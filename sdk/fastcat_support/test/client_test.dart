import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:fastcat_support/fastcat_support.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class MemoryStore implements FastCatSessionStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

class SSEClient extends http.BaseClient {
  final streams = <StreamController<List<int>>>[];
  final requests = <http.BaseRequest>[];
  int pulls = 0, seq = 0;
  bool denyEvents = false;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    if (request.url.path.endsWith('/events')) {
      if (denyEvents) return http.StreamedResponse(const Stream.empty(), 403);
      final stream = StreamController<List<int>>();
      streams.add(stream);
      if (request is http.AbortableRequest) {
        request.abortTrigger?.then((_) {
          if (!stream.isClosed) unawaited(stream.close());
        });
      }
      return http.StreamedResponse(stream.stream, 200,
          headers: {'content-type': 'text/event-stream'});
    }
    Map<String, dynamic> result;
    if (request.url.path.endsWith('/start'))
      result = {'id': 'c', 'token': 't'};
    else {
      pulls++;
      final after =
          int.tryParse(request.url.queryParameters['after'] ?? '0') ?? 0;
      result = {
        'messages': seq > after
            ? [
                {'id': 'm$seq', 'seq': seq, 'role': 'agent', 'body': 'reply'}
              ]
            : [],
        'nextCursor': seq
      };
    }
    return http.StreamedResponse(
        Stream.value(utf8.encode(jsonEncode(result))), 200);
  }
}

Future<void> eventually(bool Function() condition) async {
  for (var i = 0; i < 400 && !condition(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  expect(condition(), true);
}

void main() {
  test(
      'SSE idles without polling, parses fragmented updates, reconnects and cleans up',
      () async {
    final transport = SSEClient();
    final client = FastCatClient(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'key',
        client: transport);
    await client.start(email: 'a@example.com');
    final pages = <Map<String, dynamic>>[];
    final subscription = client
        .watch(interval: const Duration(milliseconds: 10))
        .listen(pages.add);
    await eventually(
        () => transport.streams.isNotEmpty && transport.pulls >= 2);
    final baseline = transport.pulls;
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(transport.pulls, baseline);
    expect(
        transport.requests
            .firstWhere((r) => r.url.path.endsWith('/events'))
            .headers['Authorization'],
        'Bearer t');
    transport.seq = 1;
    transport.streams.first.add(utf8.encode('data: up'));
    transport.streams.first.add(utf8.encode('date\n\n'));
    await eventually(() => pages.any((p) => p['nextCursor'] == 1));
    await transport.streams.first.close();
    transport.seq = 2;
    await eventually(() => pages.any((p) => p['nextCursor'] == 2));
    await eventually(() => transport.streams.length >= 2);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    final stable = transport.pulls;
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(transport.pulls, stable);
    await subscription.cancel();
    final ended = transport.pulls;
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(transport.pulls, ended);
    client.close();
  });
  test('SSE expired authorization terminates instead of polling forever',
      () async {
    final transport = SSEClient()..denyEvents = true;
    final client = FastCatClient(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'key',
        client: transport);
    await client.start(email: 'a@example.com');
    await expectLater(
        client.watch().toList(), throwsA(isA<FastCatException>()));
    final pulls = transport.pulls;
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(transport.pulls, pulls);
    client.close();
  });

  test(
      'push registration is conversation-authenticated and reset unbinds before clearing',
      () async {
    final requests = <http.Request>[];
    final c = FastCatClient(
        baseUrl: Uri.parse('https://push.example'),
        appKey: 'app',
        client: MockClient((r) async {
          requests.add(r);
          if (r.url.path.endsWith('/start'))
            return http.Response(
                jsonEncode({'id': 'conversation', 'token': 'visitor-secret'}),
                201);
          return http.Response(
              jsonEncode({
                'ok': true,
                'configured': {'apns': false, 'fcm': false},
                'unreadCount': 0
              }),
              200);
        }));
    await c.start(email: 'test@example.com');
    await c.registerPushDevice(
        deviceId: 'installation_uuid_001', token: 'a' * 64, provider: 'apns');
    final registration = requests.firstWhere((r) => r.method == 'PUT');
    expect(registration.headers['Authorization'], 'Bearer visitor-secret');
    expect(jsonDecode(registration.body)['id'], 'conversation');
    await c.setPushChatVisible(true);
    expect(jsonDecode(requests.last.body)['foreground'], true);
    await c.pushStatus();
    expect(requests.last.url.queryParameters['id'], 'conversation');
    await c.reset();
    expect(
        requests.any((r) =>
            r.method == 'DELETE' && jsonDecode(r.body)['id'] == 'conversation'),
        true);
    expect(c.hasSession, false);
    c.close();
  });

  test(
      'configuration requests are shared and appearance is immediately reusable per origin and channel',
      () async {
    final pending = Completer<http.Response>();
    var requests = 0;
    final store = MemoryStore();
    final c = FastCatClient(
        baseUrl: Uri.parse('https://cache.example.com'),
        appKey: 'warm',
        store: store,
        client: MockClient((_) {
          requests++;
          return pending.future;
        }));
    final first = c.configuration(), second = c.configuration();
    await Future<void>.delayed(Duration.zero);
    expect(requests, 1);
    pending.complete(http.Response(
        jsonEncode({
          'widget': {'themeColor': '#102030', 'showHandoffButton': false}
        }),
        200));
    await Future.wait([first, second]);
    expect(c.cachedConfiguration!['widget']['themeColor'], '#102030');
    final warm = FastCatClient(
        baseUrl: Uri.parse('https://cache.example.com'), appKey: 'warm');
    final other = FastCatClient(
        baseUrl: Uri.parse('https://cache.example.com'), appKey: 'other');
    expect(warm.cachedConfiguration!['widget']['showHandoffButton'], false);
    expect(other.cachedConfiguration, isNull);
    expect(
        store.values.keys.any((key) => key.startsWith('fastcat:appearance:')),
        isTrue);
    c.close();
    warm.close();
    other.close();
  });
  test('persisted appearance ignores expired, corrupt and future-dated records',
      () async {
    final store = MemoryStore();
    final c = FastCatClient(
        baseUrl: Uri.parse('https://disk-cache.example.com'),
        appKey: 'disk',
        store: store);
    const key = 'fastcat:appearance:https://disk-cache.example.com:disk';
    store.values[key] = 'broken';
    expect(await c.loadCachedConfiguration(), isNull);
    store.values[key] = jsonEncode({
      'saved': 0,
      'data': {
        'widget': {'themeColor': '#123456'}
      }
    });
    expect(await c.loadCachedConfiguration(), isNull);
    store.values[key] = jsonEncode({
      'saved': DateTime.now().millisecondsSinceEpoch + 86400000,
      'data': {
        'widget': {'themeColor': '#123456'}
      }
    });
    expect(await c.loadCachedConfiguration(), isNull);
    store.values[key] = jsonEncode({
      'saved': DateTime.now().millisecondsSinceEpoch,
      'data': {
        'widget': {'themeColor': '#654321'}
      }
    });
    expect((await c.loadCachedConfiguration())!['widget']['themeColor'],
        '#654321');
    c.close();
  });

  test('email and visitor profile use the authenticated session', () async {
    final requests = <http.Request>[];
    final client = FastCatClient(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'sdk-key',
        client: MockClient((r) async {
          requests.add(r);
          return http.Response(
              jsonEncode(r.url.path.endsWith('/start')
                  ? {'id': 'conversation', 'token': 'visitor-token'}
                  : {'ok': true}),
              200);
        }));
    await client.start(email: 'user@example.com', profile: {'device': 'Phone'});
    await client.updateProfile(profile: {'company': 'Acme'});
    expect(jsonDecode(requests[0].body)['email'], 'user@example.com');
    expect(jsonDecode(requests[0].body)['profile']['device'], 'Phone');
    expect(requests[1].headers['authorization'], 'Bearer visitor-token');
    expect(jsonDecode(requests[1].body)['profile']['company'], 'Acme');
    client.close();
  });
  test(
      'public configuration reads channel accent without requiring a visitor session',
      () async {
    final client = FastCatClient(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'channel-key',
        client: MockClient((r) async {
          expect(r.url.path, '/api/widget/config');
          expect(r.url.queryParameters['appKey'], 'channel-key');
          expect(r.headers.containsKey('authorization'), false);
          return http.Response(
              jsonEncode({
                'widget': {'themeColor': '#146355'}
              }),
              200);
        }));
    expect((await client.configuration())['widget']['themeColor'], '#146355');
    client.close();
  });
  test(
      'session persistence is scoped by server and platform; restored requests use visitor bearer',
      () async {
    final store = MemoryStore();
    final requests = <http.Request>[];
    final mock = MockClient((r) async {
      requests.add(r);
      return http.Response(
          jsonEncode(r.url.path.endsWith('/start')
              ? {'id': 'conversation', 'token': 'visitor-token'}
              : {'messages': [], 'nextCursor': 0}),
          200);
    });
    final client = FastCatClient(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'sdk-key',
        store: store,
        client: mock);
    await client.start(email: 'customer@example.test');
    final restored = FastCatClient(
        baseUrl: client.baseUrl,
        appKey: client.appKey,
        store: store,
        client: mock);
    expect(await restored.restore(), true);
    expect(requests.last.headers['Authorization'], 'Bearer visitor-token');
    expect(requests.every((r) => r.url.queryParameters['appKey'] == 'sdk-key'),
        true);
    final other = FastCatClient(
        baseUrl: client.baseUrl,
        appKey: 'different',
        store: store,
        client: mock);
    expect(await other.restore(), false);
    await restored.reset();
    expect(store.values, isEmpty);
  });
  test(
      'retry retains the same idempotency key and supports attachments and receipts',
      () async {
    final sent = <Map<String, dynamic>>[];
    var failures = 1;
    final mock = MockClient((r) async {
      if (r.url.path.endsWith('/start'))
        return http.Response('{"id":"c","token":"t"}', 201);
      if (r.url.path.endsWith('/messages')) {
        sent.add(jsonDecode(r.body) as Map<String, dynamic>);
        if (failures-- > 0) throw http.ClientException('offline');
      }
      if (r.url.path.endsWith('/attachments')) {
        expect(r.headers['X-Client-Id'], 'attachment_client_id');
        expect(r.bodyBytes, [1, 2, 3]);
      }
      return http.Response('{"ok":true}', 200);
    });
    final c = FastCatClient(
        baseUrl: Uri.parse('http://localhost:4310'),
        appKey: 'sdk',
        client: mock);
    await c.start(email: 'customer@example.test');
    final id = FastCatClient.newClientId();
    await expectLater(
        c.sendText('问题', clientId: id), throwsA(isA<http.ClientException>()));
    await c.sendText('问题', clientId: id);
    expect(sent[0], sent[1]);
    await c.sendAttachment(Uint8List.fromList([1, 2, 3]),
        filename: '文件.txt', clientId: 'attachment_client_id');
    await c.acknowledge(deliveredSeq: 3, readSeq: 2);
    await c.requestHuman();
  });
  test(
      'watch paginates by server cursor and never sends read receipts implicitly',
      () async {
    final queries = <String?>[];
    final mock = MockClient((r) async {
      if (r.url.path.endsWith('/start'))
        return http.Response('{"id":"c","token":"t"}', 201);
      queries.add(r.url.queryParameters['after']);
      return http.Response(
          jsonEncode({
            'messages': [
              {'id': 'm${queries.length}'}
            ],
            'nextCursor': queries.length,
            'hasMore': queries.length == 1
          }),
          200);
    });
    final c = FastCatClient(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'sdk',
        client: mock);
    await c.start(email: 'customer@example.test');
    final pages = await c.watch().take(2).toList();
    expect(pages.length, 2);
    expect(queries, ['0', '1']);
    c.close();
  });
  test('invalid server origins and missing sessions are rejected', () {
    expect(
        () => FastCatClient(
            baseUrl: Uri.parse('http://public.example.com'), appKey: 'key'),
        throwsArgumentError);
    final c = FastCatClient(
        baseUrl: Uri.parse('https://support.example.com'), appKey: 'key');
    expect(() => c.messages(), throwsStateError);
    c.close();
  });
  test(
      'watch exposes connection status and receipt events without confusing peer read cursors',
      () async {
    final client = FastCatClient(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'sdk',
        client: MockClient((r) async => http.Response(
            r.url.path.endsWith('/start')
                ? '{"id":"c","token":"t"}'
                : r.url.path.endsWith('/receipts')
                    ? '{"readSeq":0}'
                    : '{"messages":[],"nextCursor":0}',
            200)));
    final states = <FastCatConnectionStatus>[];
    final reads = <int>[];
    final a = client.connectionStatusStream.listen(states.add),
        b = client.readCursorStream.listen(reads.add);
    await client.start(email: 'customer@example.test');
    await client.watch().take(1).toList();
    await client.acknowledge(deliveredSeq: 9, readSeq: 7);
    await Future<void>.delayed(Duration.zero);
    expect(
        states,
        containsAllInOrder([
          FastCatConnectionStatus.connecting,
          FastCatConnectionStatus.connected,
          FastCatConnectionStatus.idle
        ]));
    expect(client.readCursor, 7);
    expect(reads, [7]);
    await a.cancel();
    await b.cancel();
    client.close();
  });
}
