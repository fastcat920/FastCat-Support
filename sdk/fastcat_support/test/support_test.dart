import 'dart:convert';
import 'package:fastcat_support/fastcat_support.dart';
import 'package:flutter/material.dart';
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
  testWidgets(
      'embedded support retains host app bar during loading and email entry',
      (tester) async {
    final support = FastCatSupport(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'sdk',
        store: MemoryStore(),
        httpClient: MockClient((_) async => http.Response('{}', 200)));
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            appBar: AppBar(title: const Text('客户端标题')),
            body: FastCatSupportView(
                support: support, locale: const Locale('zh', 'CN')))));
    await tester.pumpAndSettle();
    expect(find.text('客户端标题'), findsOneWidget);
    expect(find.byType(AppBar), findsOneWidget);
    expect(find.text('开始咨询'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    support.close();
  });

  testWidgets(
      'remembers a manually supplied email and restores anonymous session',
      (tester) async {
    final store = MemoryStore();
    var starts = 0;
    http.Client mock() => MockClient((r) async {
          if (r.url.path.endsWith('/start')) {
            starts++;
            return http.Response('{"id":"c","token":"t"}', 201);
          }
          if (r.url.path.endsWith('/config'))
            return http.Response.bytes(
                utf8.encode(
                    '{"title":"客服中心","widget":{"themeColor":"#53a919","language":"zh-CN","theme":"light"}}'),
                200);
          return http.Response('{"messages":[],"nextCursor":0}', 200);
        });
    Future<void> mount(FastCatSupport support) async {
      await tester.pumpWidget(MaterialApp(
          home: Builder(
              builder: (context) => Scaffold(
                  body: TextButton(
                      onPressed: () => support.open(context,
                          locale: const Locale("zh", "CN")),
                      child: const Text('open'))))));
      await tester.tap(find.text('open'));
      await tester.pump();
      await tester.pumpAndSettle();
    }

    final first = FastCatSupport(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'sdk',
        store: store,
        httpClient: mock());
    await mount(first);
    expect(find.text('开始咨询'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'guest@example.com');
    await tester.tap(find.text('开始咨询'));
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.text('客服中心'), findsOneWidget);
    expect(starts, 1);
    await tester.pumpWidget(const SizedBox());
    first.close();
    await tester.pump(const Duration(seconds: 2));
    final second = FastCatSupport(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'sdk',
        store: store,
        httpClient: mock());
    await mount(second);
    expect(find.text('客服中心'), findsOneWidget);
    expect(find.text('开始咨询'), findsNothing);
    expect(starts, 1);
    await tester.pumpWidget(const SizedBox());
    second.close();
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets(
      'signed-in email starts automatically and blank email restores the same account',
      (tester) async {
    final store = MemoryStore();
    final requests = <http.Request>[];
    http.Client mock() => MockClient((r) async {
          requests.add(r);
          if (r.url.path.endsWith('/start'))
            return http.Response('{"id":"c","token":"t"}', 201);
          if (r.url.path.endsWith('/config'))
            return http.Response('{"widget":{}}', 200);
          return http.Response('{"messages":[],"nextCursor":0}', 200);
        });
    Future<void> open(FastCatSupport support) async {
      await tester.pumpWidget(MaterialApp(
          home: Builder(
              builder: (context) => TextButton(
                  onPressed: () => support.open(context),
                  child: const Text('open')))));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    final first = FastCatSupport(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'sdk',
        user: const FastCatUser(
            id: 'account-1', email: 'alice@example.com', name: 'Alice'),
        store: store,
        httpClient: mock());
    await open(first);
    expect(find.byType(FastCatChat), findsOneWidget);
    final start = requests.singleWhere((r) => r.url.path.endsWith('/start'));
    expect(jsonDecode(start.body)['email'], 'alice@example.com');
    expect(jsonDecode(start.body)['profile']['externalId'], 'account-1');
    await tester.pumpWidget(const SizedBox());
    first.close();
    await tester.pump(const Duration(seconds: 2));
    final second = FastCatSupport(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'sdk',
        user: const FastCatUser(id: 'account-1', email: ''),
        store: store,
        httpClient: mock());
    await open(second);
    expect(find.byType(FastCatChat), findsOneWidget);
    expect(requests.where((r) => r.url.path.endsWith('/start')).length, 1);
    await tester.pumpWidget(const SizedBox());
    second.close();
    await tester.pump(const Duration(seconds: 2));
  });

  test(
      'account sessions are isolated and a blank email cannot reuse another account',
      () async {
    final store = MemoryStore();
    var starts = 0;
    http.Client mock() => MockClient((r) async {
          if (r.url.path.endsWith('/start')) {
            starts++;
            return http.Response(
                jsonEncode({'id': 'c$starts', 'token': 't$starts'}), 201);
          }
          return http.Response('{"messages":[],"nextCursor":0}', 200);
        });
    FastCatSupport support(String id) => FastCatSupport(
        baseUrl: Uri.parse('https://support.example.com'),
        appKey: 'sdk',
        user: FastCatUser(id: id),
        store: store,
        httpClient: mock());
    final a = support('a');
    await a.client.start(email: 'a@example.com');
    final b = support('b');
    expect(await b.client.restore(), false);
    final a2 = support('a');
    expect(await a2.client.restore(), true);
    expect(a2.client.conversationId, 'c1');
    await b.client.start(email: 'b@example.com');
    await a.reset();
    final b2 = support('b');
    expect(await b2.client.restore(), true);
    a.close();
    b.close();
    a2.close();
    b2.close();
  });
}
