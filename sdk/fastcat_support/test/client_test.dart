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

void main() {
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
    await client.start(name: '客户');
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
    await c.start(name: '客户');
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
    await c.start(name: '客户');
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
    await client.start(name: '客户');
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
