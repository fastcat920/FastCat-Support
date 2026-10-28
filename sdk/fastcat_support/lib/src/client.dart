import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:http/http.dart' as http;

/// Implement with app-owned secure storage. The value contains a visitor token.
abstract interface class FastCatSessionStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class FastCatException implements Exception {
  final int status;
  final String message;
  FastCatException(this.status, this.message);
  @override
  String toString() => message;
}

enum FastCatConnectionStatus {
  idle,
  connecting,
  connected,
  reconnecting,
  closed
}

class FastCatClient {
  final _connectionEvents =
      StreamController<FastCatConnectionStatus>.broadcast();
  final _readEvents = StreamController<int>.broadcast();
  FastCatConnectionStatus _connectionStatus = FastCatConnectionStatus.idle;
  int _watchers = 0, _readCursor = 0;
  FastCatConnectionStatus get connectionStatus => _connectionStatus;
  Stream<FastCatConnectionStatus> get connectionStatusStream =>
      _connectionEvents.stream;
  int get readCursor => _readCursor;
  Stream<int> get readCursorStream => _readEvents.stream;
  void _setConnection(FastCatConnectionStatus value) {
    if (_connectionStatus == value) return;
    _connectionStatus = value;
    if (!_connectionEvents.isClosed) _connectionEvents.add(value);
  }

  final Uri baseUrl;
  final String appKey;
  final FastCatSessionStore? store;

  /// Optional stable business-account scope. Use a different client per account.
  final String? sessionScope;
  final http.Client _http;
  Map<String, dynamic>? _session;
  bool _closed = false;
  String get _storeKey =>
      'fastcat:${baseUrl.origin}:$appKey' +
      (sessionScope == null
          ? ''
          : ':user:${Uri.encodeComponent(sessionScope!)}');
  String? get conversationId => _session?['id'] as String?;
  bool get hasSession => _session != null;

  FastCatClient(
      {required this.baseUrl,
      required this.appKey,
      this.store,
      this.sessionScope,
      http.Client? client})
      : _http = client ?? http.Client() {
    if ((!['https'].contains(baseUrl.scheme) &&
            !(baseUrl.scheme == 'http' &&
                ['localhost', '127.0.0.1', '10.0.2.2', '::1']
                    .contains(baseUrl.host))) ||
        baseUrl.userInfo.isNotEmpty ||
        baseUrl.path.isNotEmpty && baseUrl.path != '/' ||
        baseUrl.hasQuery ||
        baseUrl.hasFragment ||
        appKey.isEmpty ||
        (sessionScope != null && sessionScope!.trim().isEmpty)) {
      throw ArgumentError(
          'Use an HTTPS origin and a platform appKey (HTTP is allowed for local development).');
    }
  }

  static String newClientId() {
    final random = Random.secure();
    return 'fc_${List.generate(24, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
  }

  Uri _uri(String path, [Map<String, String> query = const {}]) => baseUrl
      .resolve('/api/widget$path')
      .replace(queryParameters: {'appKey': appKey, ...query});
  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_session != null) 'Authorization': 'Bearer ${_session!['token']}'
      };
  void _requireSession() {
    if (_closed) throw StateError('Client is closed');
    if (_session == null) throw StateError('Start or restore a session first');
  }

  /// Public channel appearance; no visitor session is required.
  Future<Map<String, dynamic>> configuration() => _json('/config');

  Future<Map<String, dynamic>> _json(String path,
      {String method = 'GET',
      Map<String, String> query = const {},
      Map<String, dynamic>? body}) async {
    if (_closed) throw StateError('Client is closed');
    final request = http.Request(method, _uri(path, query))
      ..headers.addAll(_headers);
    if (body != null) request.body = jsonEncode(body);
    final response = await http.Response.fromStream(
        await _http.send(request).timeout(const Duration(seconds: 30)));
    final value =
        jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    if (response.statusCode >= 400)
      throw FastCatException(
          response.statusCode, value['error'] as String? ?? 'Request failed');
    return value;
  }

  Future<void> start(
      {required String email,
      String? name,
      Map<String, dynamic> profile = const {}}) async {
    if (hasSession)
      throw StateError(
          'A session already exists; reset explicitly to start a new conversation');
    final result = await _json('/start',
        method: 'POST', body: {'email': email, 'profile': profile});
    _session = {'id': result['id'], 'token': result['token'], 'appKey': appKey};
    await store?.write(_storeKey, jsonEncode(_session));
  }

  /// Update only this authenticated conversation's visitor profile.
  Future<void> updateProfile(
      {String? email, Map<String, dynamic> profile = const {}}) async {
    _requireSession();
    await _json('/profile', method: 'POST', body: {
      'id': conversationId,
      if (email != null) 'email': email,
      'profile': profile
    });
  }

  Future<bool> restore() async {
    final value = await store?.read(_storeKey);
    if (value == null) return false;
    final decoded = jsonDecode(value) as Map<String, dynamic>;
    if (decoded['appKey'] != appKey ||
        decoded['id'] is! String ||
        decoded['token'] is! String)
      throw const FormatException('Invalid saved session');
    _session = decoded;
    try {
      await messages(limit: 1);
      return true;
    } on FastCatException catch (e) {
      if (e.status == 403) {
        await reset();
        return false;
      }
      rethrow;
    }
  }

  Future<void> reset() async {
    _session = null;
    _readCursor = 0;
    if (!_readEvents.isClosed) _readEvents.add(0);
    await store?.delete(_storeKey);
  }

  Future<Map<String, dynamic>> messages({int after = 0, int limit = 200}) {
    _requireSession();
    return _json('',
        query: {'id': conversationId!, 'after': '$after', 'limit': '$limit'});
  }

  /// Retain the same clientId when retrying a send whose result is unknown.
  Future<Map<String, dynamic>> sendText(String text,
      {required String clientId}) {
    _requireSession();
    return _json('/messages',
        method: 'POST',
        body: {'id': conversationId, 'body': text, 'clientId': clientId});
  }

  Future<Map<String, dynamic>> requestHuman() {
    _requireSession();
    return _json('/handoff', method: 'POST', body: {'id': conversationId});
  }

  Future<Map<String, dynamic>> acknowledge(
      {required int deliveredSeq, required int readSeq}) async {
    _requireSession();
    final current = conversationId;
    final value = await _json('/receipts', method: 'POST', body: {
      'id': current,
      'deliveredSeq': deliveredSeq,
      'readSeq': readSeq
    });
    if (conversationId == current && readSeq > _readCursor) {
      _readCursor = readSeq;
      if (!_readEvents.isClosed) _readEvents.add(readSeq);
    }
    return value;
  }

  Future<Map<String, dynamic>> sendAttachment(Uint8List data,
      {required String filename, required String clientId}) async {
    _requireSession();
    if (data.isEmpty || data.length > 8 * 1024 * 1024)
      throw ArgumentError('Attachment must be 1 byte to 8 MB');
    final response = await _http
        .post(_uri('/attachments', {'id': conversationId!}),
            headers: {
              ..._headers,
              'Content-Type': 'application/octet-stream',
              'X-Filename': Uri.encodeComponent(filename),
              'X-Client-Id': clientId
            },
            body: data)
        .timeout(const Duration(seconds: 60));
    final value =
        jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    if (response.statusCode >= 400)
      throw FastCatException(
          response.statusCode, value['error'] as String? ?? 'Upload failed');
    return value;
  }

  Future<Uint8List> downloadAttachment(String attachmentId) async {
    _requireSession();
    final response = await _http
        .get(
            _uri('/attachments/${Uri.encodeComponent(attachmentId)}',
                {'id': conversationId!}),
            headers: _headers)
        .timeout(const Duration(seconds: 60));
    if (response.statusCode >= 400)
      throw FastCatException(response.statusCode, 'Attachment unavailable');
    return response.bodyBytes;
  }

  /// Polling uses durable message cursors; transient failures reach onError and
  /// polling continues. Read receipts must be sent by the visible UI separately.
  Stream<Map<String, dynamic>> watch(
      {Duration interval = const Duration(seconds: 2),
      int after = 0,
      void Function(Object)? onError}) async* {
    _requireSession();
    final id = conversationId;
    var cursor = after;
    _watchers++;
    _setConnection(FastCatConnectionStatus.connecting);
    try {
      while (!_closed && conversationId == id) {
        try {
          final page = await messages(after: cursor);
          _setConnection(FastCatConnectionStatus.connected);
          yield page;
          cursor = page['nextCursor'] as int? ?? cursor;
          if (page['hasMore'] == true) continue;
        } catch (e) {
          _setConnection(FastCatConnectionStatus.reconnecting);
          onError?.call(e);
          if (e is FastCatException && [403, 409].contains(e.status)) rethrow;
        }
        await Future<void>.delayed(interval);
      }
    } finally {
      _watchers--;
      if (!_closed && _watchers == 0)
        _setConnection(FastCatConnectionStatus.idle);
    }
  }

  void close() {
    _closed = true;
    _setConnection(FastCatConnectionStatus.closed);
    unawaited(_connectionEvents.close());
    unawaited(_readEvents.close());
    _http.close();
  }
}
