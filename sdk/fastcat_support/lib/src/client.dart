import 'repairs.dart';
import 'assistance.dart';
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

/// Short-lived HS256 proof signed by the host BACKEND, never by the app.
class FastCatIdentityProof {
  final String deviceId;
  final String token;
  const FastCatIdentityProof({required this.deviceId, required this.token});
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
  final String consentSessionId = newClientId();
  final Set<String> activeConsentIds = {};
  bool get isClosed => _closed;
  Future<void> endAssistance() async {
    activeConsentIds.clear();
    if (_session == null || _diagnosticDevice == null || _closed) return;
    try {
      await assistance(action: 'scope_end', data: {
        'deviceId': _diagnosticDevice,
        'consentSessionId': consentSessionId
      }).timeout(const Duration(seconds: 2));
    } catch (_) {}
  }

  /// Supported keys: basic, status, network, logs, routes. The host must redact secrets.
  Map<String, FastCatDiagnosticHandler> diagnosticHandlers = {};
  Map<String, FastCatRepairHandler> repairHandlers = {};

  /// Read local metadata only: at most three alternate routes, opaque IDs and redacted names.
  Future<List<FastCatRouteOption>> Function()? routeOptions;
  late final FastCatRepairCoordinator repairs = FastCatRepairCoordinator(this);
  String get repairStorageKey => '$_storeKey:repairs:$conversationId';
  String? _diagnosticDevice;
  Future<String> diagnosticDeviceId() async {
    if (_diagnosticDevice != null) return _diagnosticDevice!;
    final key = '$_storeKey:diagnostic-device';
    final saved = await store?.read(key);
    _diagnosticDevice = saved ?? newClientId();
    if (saved == null) await store?.write(key, _diagnosticDevice!);
    return _diagnosticDevice!;
  }

  String? _pushDeviceId;
  bool _pushChatVisible = false;

  /// Host supplies its APNs/FCM token after starting/restoring the session.
  Future<Map<String, dynamic>> registerPushDevice(
      {required String deviceId,
      required String token,
      required String provider,
      String environment = 'production',
      String language = 'zh',
      bool enabled = true}) async {
    if (!hasSession) throw StateError('Start or restore a session first');
    final result = await _json('/push/device', method: 'PUT', body: {
      'id': conversationId,
      'deviceId': deviceId,
      'token': token,
      'provider': provider,
      'environment': environment,
      'language': language,
      'enabled': enabled
    });
    _pushDeviceId = deviceId;
    await setPushChatVisible(_pushChatVisible);
    return result;
  }

  Future<Map<String, dynamic>> pushStatus() =>
      _json('/push/status', query: {'id': conversationId!});

  /// Used automatically by FastCatChat; custom chat UIs should heartbeat every 30s.
  Future<void> setPushChatVisible(bool visible) async {
    _pushChatVisible = visible;
    if (_pushDeviceId == null || !hasSession || _closed) return;
    await _json('/push/device', method: 'PATCH', body: {
      'id': conversationId,
      'deviceId': _pushDeviceId,
      'foreground': visible
    });
  }

  Future<void> unregisterPushDevice() async {
    if (_pushDeviceId == null || !hasSession) return;
    await _json('/push/device',
        method: 'DELETE',
        body: {'id': conversationId, 'deviceId': _pushDeviceId});
    _pushDeviceId = null;
  }

  Future<Map<String, dynamic>> assistance(
      {String? action, Map<String, dynamic> data = const {}}) {
    _requireSession();
    return _json('/assistance',
        method: action == null ? 'GET' : 'POST',
        body: action == null
            ? null
            : {'id': conversationId, 'action': action, ...data},
        query: action == null ? {'id': conversationId!} : const {});
  }

  final _connectionEvents =
      StreamController<FastCatConnectionStatus>.broadcast();
  final _readEvents = StreamController<int>.broadcast();
  final _unreadEvents = StreamController<int>.broadcast();
  final _messageEvents = StreamController<Map<String, dynamic>>.broadcast();
  final _unreadSequences = <int>{};
  final _seenNotificationSequences = <int>{};
  bool _notificationBaseline = false;
  int get unreadCount => _unreadSequences.length;
  Stream<int> get unreadCountStream => _unreadEvents.stream;

  /// New remote messages after initial history; host may play its own sound.
  Stream<Map<String, dynamic>> get incomingMessageStream =>
      _messageEvents.stream;
  void _publishUnread() {
    _unreadSequences.removeWhere((seq) => seq <= _readCursor);
    if (!_closed) _unreadEvents.add(unreadCount);
  }

  void _observePage(Map<String, dynamic> page) {
    for (final value in page['messages'] as List? ?? const []) {
      final message = Map<String, dynamic>.from(value as Map);
      final seq = message['seq'];
      if (seq is! int ||
          message['role'] == 'visitor' ||
          message['source'] == 'system') continue;
      if (seq > _readCursor) _unreadSequences.add(seq);
      if (_seenNotificationSequences.add(seq) &&
          _notificationBaseline &&
          !_closed) _messageEvents.add(message);
    }
    if (page['hasMore'] != true) _notificationBaseline = true;
    _publishUnread();
  }

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

  final Future<FastCatIdentityProof> Function()? identityProvider;

  FastCatClient(
      {required this.baseUrl,
      required this.appKey,
      this.store,
      this.sessionScope,
      this.identityProvider,
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
      .replace(queryParameters: {'appKey': appKey, 'client': 'sdk', ...query});
  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_session != null) 'Authorization': 'Bearer ${_session!['token']}'
      };
  void _requireSession() {
    if (_closed) throw StateError('Client is closed');
    if (_session == null) throw StateError('Start or restore a session first');
  }

  static final _appearanceCache = <String, Map<String, dynamic>>{};
  Future<Map<String, dynamic>>? _configurationRequest;
  String get _appearanceKey => 'fastcat:appearance:${baseUrl.origin}:$appKey';
  Map<String, dynamic>? get cachedConfiguration {
    final record = _appearanceCache[_appearanceKey];
    if (record == null ||
        DateTime.now().millisecondsSinceEpoch < (record['saved'] as int) ||
        DateTime.now().millisecondsSinceEpoch - (record['saved'] as int) >
            86400000) return null;
    return Map<String, dynamic>.from(record['data'] as Map);
  }

  Future<Map<String, dynamic>?> loadCachedConfiguration() async {
    if (cachedConfiguration != null) return cachedConfiguration;
    try {
      final raw = await store?.read(_appearanceKey);
      if (cachedConfiguration != null) return cachedConfiguration;
      if (raw != null) {
        final record = jsonDecode(raw);
        if (record is Map &&
            record['saved'] is int &&
            record['data'] is Map &&
            _validAppearance(
                Map<String, dynamic>.from(record['data'] as Map))) {
          _appearanceCache[_appearanceKey] = Map<String, dynamic>.from(record);
        }
      }
    } catch (_) {}
    return cachedConfiguration;
  }

  bool _validAppearance(Map<String, dynamic> data) {
    final w = data['widget'];
    if (w is! Map) return false;
    return RegExp(r'^#[0-9a-fA-F]{6}$')
            .hasMatch(w['themeColor']?.toString() ?? '') &&
        (w['language'] == null ||
            ['auto', 'zh-CN', 'en'].contains(w['language'])) &&
        (w['theme'] == null ||
            ['auto', 'light', 'dark'].contains(w['theme'])) &&
        ['themeColorLight', 'themeColorDark'].every((key) =>
            w[key] == null ||
            w[key] == '' ||
            (w[key] is String &&
                RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(w[key]))) &&
        (w['showHandoffButton'] == null || w['showHandoffButton'] is bool) &&
        ['welcomeMessage', 'welcomeMessageZh', 'welcomeMessageEn']
            .every((key) => w[key] == null || w[key] is String);
  }

  /// Fresh public configuration; concurrent callers share the same request.
  Future<Map<String, dynamic>> configuration() {
    return _configurationRequest ??=
        _fetchConfiguration().whenComplete(() => _configurationRequest = null);
  }

  Future<Map<String, dynamic>> _fetchConfiguration() async {
    final data = await _json('/config');
    if (!_validAppearance(data))
      throw const FormatException('Invalid appearance configuration');
    if (_validAppearance(data)) {
      final record = <String, dynamic>{
        'saved': DateTime.now().millisecondsSinceEpoch,
        'data': data
      };
      if (_appearanceCache.length >= 32)
        _appearanceCache.remove(_appearanceCache.keys.first);
      _appearanceCache[_appearanceKey] = record;
      if (store != null)
        unawaited(store!
            .write(_appearanceKey, jsonEncode(record))
            .then<void>((_) {}, onError: (Object _) {}));
    }
    return data;
  }

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
      Map<String, dynamic> profile = const {},
      String? deviceId,
      String? identityToken}) async {
    if (hasSession)
      throw StateError(
          'A session already exists; reset explicitly to start a new conversation');
    final proof = identityToken == null ? await identityProvider?.call() : null;
    deviceId ??= proof?.deviceId;
    identityToken ??= proof?.token;
    final result = await _json('/start', method: 'POST', body: {
      'email': email,
      'profile': profile,
      if (deviceId != null) 'deviceId': deviceId,
      if (identityToken != null) 'identityToken': identityToken
    });
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

  /// Revoke server credentials as well as local state (e.g. account logout).
  Future<void> revokeSession() async {
    _requireSession();
    await _json('/session',
        method: 'POST', body: {'id': conversationId, 'action': 'revoke'});
    await reset();
  }

  Future<void> reset() async {
    for (final stop in _watchStops.toList()) {
      stop();
    }
    await unregisterPushDevice();
    await endAssistance();
    _session = null;
    _readCursor = 0;
    _unreadSequences.clear();
    _seenNotificationSequences.clear();
    _notificationBaseline = false;
    _publishUnread();
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
      _publishUnread();
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

  final Set<void Function()> _watchStops = {};

  /// SSE invalidates the durable cursor feed; polling only runs while SSE is down.
  Stream<Map<String, dynamic>> watch(
      {Duration interval = const Duration(seconds: 2),
      int after = 0,
      void Function(Object)? onError}) {
    _requireSession();
    final id = conversationId;
    var cursor = after, failures = 0;
    var stopped = false, syncing = false, dirty = false, live = false;
    Timer? polling, reconnect, heartbeat;
    StreamSubscription<String>? events;
    Completer<void>? abort;
    late StreamController<Map<String, dynamic>> output;
    late void Function() stop;
    bool valid() => !stopped && !_closed && conversationId == id;
    bool fatal(Object e) =>
        e is FastCatException && [401, 403, 409].contains(e.status);
    void report(Object e) {
      if (!valid()) return;
      onError?.call(e);
      if (fatal(e)) {
        output.addError(e);
        stop();
      }
    }

    Future<void> sync() async {
      if (!valid()) return;
      dirty = true;
      if (syncing) return;
      syncing = true;
      try {
        while (valid() && dirty) {
          dirty = false;
          try {
            final page = await messages(after: cursor);
            if (!valid()) break;
            cursor = page['nextCursor'] as int? ?? cursor;
            _setConnection(FastCatConnectionStatus.connected);
            _observePage(page);
            output.add(page);
            if (page['hasMore'] == true) dirty = true;
          } catch (e) {
            report(e);
            break;
          }
        }
      } finally {
        syncing = false;
      }
    }

    late Future<void> Function() connect;
    void disconnected([Object? error]) {
      if (!valid() || reconnect != null) return;
      live = false;
      heartbeat?.cancel();
      events?.cancel();
      events = null;
      if (abort != null && !abort!.isCompleted) abort!.complete();
      _setConnection(FastCatConnectionStatus.reconnecting);
      if (error != null) report(error);
      if (!valid()) return;
      polling ??= Timer.periodic(interval, (_) => unawaited(sync()));
      final delay = Duration(seconds: min(30, 1 << min(failures++, 5)));
      reconnect = Timer(delay, () {
        reconnect = null;
        unawaited(connect());
      });
    }

    void touchHeartbeat() {
      heartbeat?.cancel();
      heartbeat = Timer(const Duration(seconds: 65),
          () => disconnected(TimeoutException('SSE heartbeat timeout')));
    }

    connect = () async {
      if (!valid()) return;
      polling ??= Timer.periodic(interval, (_) => unawaited(sync()));
      final attempt = Completer<void>();
      abort = attempt;
      try {
        final request = http.AbortableRequest(
            'GET', _uri('/events', {'id': id!}),
            abortTrigger: attempt.future)
          ..headers.addAll({..._headers, 'Accept': 'text/event-stream'});
        final response =
            await _http.send(request).timeout(const Duration(seconds: 20));
        if (!valid() || abort != attempt) {
          if (!attempt.isCompleted) attempt.complete();
          return;
        }
        if (response.statusCode != 200 ||
            !(response.headers['content-type'] ?? '')
                .contains('text/event-stream')) {
          await response.stream.listen((_) {}).cancel();
          if ([401, 403, 409].contains(response.statusCode))
            throw FastCatException(response.statusCode, 'Session expired');
          disconnected();
          return;
        }
        live = true;
        failures = 0;
        polling?.cancel();
        polling = null;
        _setConnection(FastCatConnectionStatus.connected);
        touchHeartbeat();
        events = response.stream
            .transform(utf8.decoder)
            .transform(const LineSplitter())
            .listen((line) {
          if (!valid() || !live) return;
          touchHeartbeat();
          if (line.startsWith('data:')) unawaited(sync());
        },
                onError: (Object e) => disconnected(e),
                onDone: () => disconnected());
        // Catch messages committed between the initial pull and SSE subscription.
        unawaited(sync());
      } catch (e) {
        if (valid() && abort == attempt) disconnected(e);
      }
    };
    stop = () {
      if (stopped) return;
      stopped = true;
      polling?.cancel();
      reconnect?.cancel();
      heartbeat?.cancel();
      if (abort != null && !abort!.isCompleted) abort!.complete();
      events?.cancel();
      _watchStops.remove(stop);
      _watchers--;
      if (!_closed && _watchers == 0)
        _setConnection(FastCatConnectionStatus.idle);
      unawaited(output.close());
    };
    output = StreamController<Map<String, dynamic>>(
        onListen: () {
          _watchers++;
          _watchStops.add(stop);
          if (!valid()) {
            stop();
            return;
          }
          _setConnection(FastCatConnectionStatus.connecting);
          unawaited(() async {
            await sync();
            if (valid()) await connect();
          }());
        },
        onCancel: () => stop());
    return output.stream;
  }

  void close() {
    if (_closed) return;
    for (final stop in _watchStops.toList()) {
      stop();
    }
    unawaited(setPushChatVisible(false).catchError((Object _) {}));
    final ending = endAssistance();
    _closed = true;
    _setConnection(FastCatConnectionStatus.closed);
    unawaited(_connectionEvents.close());
    unawaited(_readEvents.close());
    unawaited(_unreadEvents.close());
    unawaited(_messageEvents.close());
    unawaited(ending.whenComplete(_http.close));
  }
}
