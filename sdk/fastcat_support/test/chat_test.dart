import 'dart:async';
import 'dart:typed_data';
import 'package:fastcat_support/fastcat_support.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeClient extends FastCatClient {
  FakeClient()
      : super(baseUrl: Uri.parse('https://support.example.com'), appKey: 'sdk');
  final pages = StreamController<Map<String, dynamic>>.broadcast();
  final reads = StreamController<int>.broadcast();
  @override
  int get readCursor => read;
  @override
  Stream<int> get readCursorStream => reads.stream;
  final sent = <String>[];
  bool handoff = false;
  int read = 0;
  @override
  Stream<Map<String, dynamic>> watch(
          {Duration interval = const Duration(seconds: 2),
          int after = 0,
          void Function(Object)? onError}) =>
      pages.stream;
  @override
  Future<Map<String, dynamic>> sendText(String text,
      {required String clientId}) async {
    sent.add(clientId);
    if (sent.length == 1) throw Exception('offline');
    return {'ok': true};
  }

  @override
  Future<Map<String, dynamic>> acknowledge(
      {required int deliveredSeq, required int readSeq}) async {
    read = readSeq;
    reads.add(readSeq);
    return {'ok': true};
  }

  @override
  Future<Map<String, dynamic>> requestHuman() async {
    handoff = true;
    return {'ok': true};
  }
}

void main() {
  testWidgets(
      'chat follows host English and dark theme and permits sending after closure',
      (tester) async {
    final c = FakeClient();
    final scheme = ColorScheme.fromSeed(
        seedColor: Colors.orange, brightness: Brightness.dark);
    await tester.pumpWidget(MaterialApp(
        theme: ThemeData.dark().copyWith(colorScheme: scheme),
        home: FastCatChat(client: c)));
    expect(find.text('Support'), findsOneWidget);
    expect(find.text('Talk to a person'), findsOneWidget);
    final context = tester.element(find.byType(TextField));
    expect(Theme.of(context).brightness, Brightness.dark);
    expect(Theme.of(context).colorScheme.primary, scheme.primary);
    c.pages.add({
      'messages': [],
      'nextCursor': 0,
      'conversation': {'status': 'closed'}
    });
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'new issue');
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();
    expect(c.sent.length, 1);
    expect(find.byTooltip('Retry send'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    unawaited(c.pages.close());
    unawaited(c.reads.close());
    await tester.pump();
    c.close();
  });
  testWidgets(
      'chat renders messages, retries same send, and requests human support',
      (tester) async {
    final client = FakeClient();
    await tester.pumpWidget(MaterialApp(
        home: FastCatChat(
            client: client,
            locale: const Locale("zh", "CN"),
            pickAttachment: () async => null,
            onAttachment: (String name, Uint8List data) async {})));
    client.pages.add({
      'messages': [
        {'id': 'm', 'role': 'agent', 'body': '客服回复'}
      ],
      'nextCursor': 4,
      'conversation': {'status': 'open'}
    });
    await tester.pump();
    expect(find.text('客服回复'), findsOneWidget);
    expect(client.read, 4);
    await tester.enterText(find.byType(TextField), '需要帮助');
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    expect(find.byTooltip('重试发送'), findsOneWidget);
    await tester.tap(find.byTooltip('重试发送'));
    await tester.pump();
    expect(client.sent.length, 2);
    expect(client.sent[0], client.sent[1]);
    await tester.tap(find.text('联系人工'));
    await tester.pump();
    expect(client.handoff, true);
    expect(find.byTooltip('发送附件'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    unawaited(client.pages.close());
    await tester.pump();
    unawaited(client.reads.close());
    client.close();
  });
  testWidgets(
      'AI draft is transient and disappears when the final message arrives',
      (tester) async {
    final c = FakeClient();
    await tester.pumpWidget(MaterialApp(
        home: FastCatChat(client: c, locale: const Locale("zh", "CN"))));
    c.pages.add({
      'messages': [],
      'nextCursor': 0,
      'automation': {'typing': true, 'draft': '正在查询订单'}
    });
    await tester.pump();
    expect(find.text('正在查询订单'), findsOneWidget);
    c.pages.add({
      'messages': [
        {'id': 'done', 'role': 'agent', 'body': '订单已发货'}
      ],
      'nextCursor': 5,
      'automation': {'typing': false, 'draft': ''}
    });
    await tester.pumpAndSettle();
    expect(find.text('正在查询订单'), findsNothing);
    expect(find.text('订单已发货'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    unawaited(c.pages.close());
    unawaited(c.reads.close());
    await tester.pump();
    c.close();
  });
  testWidgets(
      'launcher counts unread messages without reading them, opens chat and clears badge on visible receipts',
      (tester) async {
    final c = FakeClient();
    final page = <String, dynamic>{
      'messages': [
        {
          'id': 'reply',
          'seq': 4,
          'role': 'agent',
          'source': 'manual',
          'read_at': null,
          'body': '客服新回复'
        }
      ],
      'nextCursor': 4
    };
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Stack(children: [
      FastCatLauncher(client: c, locale: const Locale("zh", "CN"))
    ]))));
    c.pages.add(page);
    await tester.pump();
    expect(find.text('1'), findsOneWidget);
    expect(c.read, 0);
    await tester.tap(find.byTooltip('联系客服'));
    await tester.pumpAndSettle();
    c.pages.add(page);
    await tester.pump();
    await tester.pump();
    expect(find.text('客服新回复'), findsOneWidget);
    expect(c.read, 4);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('1'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    unawaited(c.pages.close());
    unawaited(c.reads.close());
    await tester.pump();
    c.close();
  });
}
