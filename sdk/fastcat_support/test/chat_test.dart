import 'dart:convert';
import 'dart:ui' as ui;
import 'package:flutter/services.dart';
import 'dart:async';
import 'package:fastcat_support/fastcat_support.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeClient extends FastCatClient {
  FakeClient()
      : super(baseUrl: Uri.parse('https://support.example.com'), appKey: 'sdk');
  final pages = StreamController<Map<String, dynamic>>.broadcast();
  final reads = StreamController<int>.broadcast();
  @override
  Future<Map<String, dynamic>> configuration() async => {
        'title': 'Hidden title',
        'widget': {
          'themeColor': '#146355',
          'welcomeMessageZh': '欢迎咨询',
          'welcomeMessageEn': 'Welcome to support'
        }
      };
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

class DelayedConfigurationClient extends FakeClient {
  final config = Completer<Map<String, dynamic>>();
  Map<String, dynamic>? warm;
  @override
  Map<String, dynamic>? get cachedConfiguration => warm;
  @override
  Future<Map<String, dynamic>?> loadCachedConfiguration() async => warm;
  @override
  Future<Map<String, dynamic>> configuration() => config.future;
}

class ControlledSendClient extends FakeClient {
  final response = Completer<Map<String, dynamic>>();
  String? requestId;
  @override
  Future<Map<String, dynamic>> sendText(String text,
      {required String clientId}) {
    requestId = clientId;
    return response.future;
  }
}

void main() {
  testWidgets('date separators follow local bubble times across midnight',
      (tester) async {
    final c = FakeClient();
    await tester.pumpWidget(
        MaterialApp(home: FastCatChat(client: c, locale: const Locale('zh'))));
    await tester.pumpAndSettle();
    final dates = [DateTime(2026, 11, 7, 23, 59), DateTime(2026, 11, 8, 0, 46)];
    c.pages.add({
      'messages': [
        for (var i = 0; i < dates.length; i++)
          {
            'id': 'date$i',
            'seq': i + 1,
            'role': 'agent',
            'body': 'date message $i',
            'created': dates[i].toUtc().toIso8601String()
          }
      ],
      'nextCursor': 2
    });
    await tester.pumpAndSettle();
    expect(find.textContaining('2026'), findsNWidgets(2));
    expect(find.text('00:46'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await c.pages.close();
    await c.reads.close();
    c.close();
  });

  testWidgets(
      'header omits generic placeholder but preserves actual service status and language changes',
      (tester) async {
    final c = FakeClient();
    await tester.pumpWidget(MaterialApp(
        home: FastCatChat(client: c, locale: const Locale('zh', 'CN'))));
    await tester.pumpAndSettle();
    expect(find.text('客服服务'), findsNothing);
    expect(find.text('等待客服接待'), findsNothing);
    c.pages.add({
      'messages': [],
      'nextCursor': 0,
      'conversation': {'assigned': true},
      'automation': {'mode': 'human'}
    });
    await tester.pumpAndSettle();
    expect(find.text('人工客服接待中'), findsOneWidget);
    c.pages.add({
      'messages': [],
      'nextCursor': 0,
      'automation': {'mode': 'ai'}
    });
    await tester.pumpAndSettle();
    expect(find.text('AI 助手接待中'), findsOneWidget);
    await tester.pumpWidget(
        MaterialApp(home: FastCatChat(client: c, locale: const Locale('en'))));
    await tester.pumpAndSettle();
    expect(find.text('AI assistant connected'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await c.pages.close();
    await c.reads.close();
    c.close();
  });

  testWidgets(
      'Enter sends, Shift Enter inserts a newline, and confirmed messages remain until stream reconciliation',
      (tester) async {
    final c = ControlledSendClient();
    await tester.pumpWidget(MaterialApp(
        home: FastCatChat(client: c, locale: const Locale('zh', 'CN'))));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'line');
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'line\n');
    expect(c.requestId, isNull);
    await tester.enterText(find.byType(TextField), 'message stays');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(c.requestId, isNotNull);
    expect(find.text('message stays'), findsOneWidget);
    c.response.complete({'ok': true, 'id': 'server-message'});
    await tester.pumpAndSettle();
    expect(find.text('message stays'), findsOneWidget);
    expect(find.text('  ✓'), findsOneWidget);
    c.pages.add({
      'messages': [
        {
          'id': 'server-message',
          'client_id': c.requestId,
          'seq': 1,
          'role': 'visitor',
          'body': 'message stays',
          'created': '2026-11-01T08:00:00Z'
        }
      ],
      'nextCursor': 1,
      'receipts': {'readSeq': 1}
    });
    await tester.pumpAndSettle();
    expect(find.text('message stays'), findsOneWidget);
    expect(find.text('  ✓✓'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await c.pages.close();
    await c.reads.close();
    c.close();
  });
  testWidgets(
      'stream confirmation arriving before HTTP response never duplicates the sent message',
      (tester) async {
    final c = ControlledSendClient();
    await tester.pumpWidget(MaterialApp(
        home: FastCatChat(client: c, locale: const Locale('zh', 'CN'))));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'early echo');
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    c.pages.add({
      'messages': [
        {
          'id': 'early',
          'client_id': c.requestId,
          'seq': 1,
          'role': 'visitor',
          'body': 'early echo',
          'created': '2026-11-01T08:00:00Z'
        }
      ],
      'nextCursor': 1
    });
    await tester.pump();
    expect(find.text('early echo'), findsOneWidget);
    c.response.complete({'ok': true, 'id': 'early'});
    await tester.pumpAndSettle();
    expect(find.text('early echo'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await c.pages.close();
    await c.reads.close();
    c.close();
  });
  testWidgets(
      'composer tools have separate touch targets and responsive spacing',
      (tester) async {
    final c = FakeClient();
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(
        home: FastCatChat(client: c, locale: const Locale('zh', 'CN'))));
    await tester.pumpAndSettle();
    Rect attach() => tester.getRect(find.byTooltip('发送附件'));
    Rect emoji() => tester.getRect(find.byTooltip('选择表情'));
    expect(attach().width, 36);
    expect(emoji().left - attach().right, 8);
    tester.view.physicalSize = const Size(1440, 1000);
    await tester.pumpAndSettle();
    expect(emoji().left - attach().right, 12);
    await tester.pumpWidget(const SizedBox());
    await c.pages.close();
    await c.reads.close();
    c.close();
  });

  testWidgets(
      'cold appearance waits without default UI; cached appearance paints immediately',
      (tester) async {
    final cold = DelayedConfigurationClient();
    await tester.pumpWidget(MaterialApp(home: FastCatChat(client: cold)));
    expect(find.byType(TextField), findsNothing);
    expect(find.byTooltip('声音'), findsNothing);
    cold.config.complete({
      'widget': {'themeColor': '#102030', 'showHandoffButton': false}
    });
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);
    expect(tester.widget<Scaffold>(find.byType(Scaffold)).appBar, isNotNull);
    final warm = DelayedConfigurationClient()
      ..warm = {
        'widget': {'themeColor': '#abcdef', 'showHandoffButton': false}
      };
    await tester.pumpWidget(MaterialApp(home: FastCatChat(client: warm)));
    expect(find.byType(TextField), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(
        find.byWidgetPredicate(
            (w) => w is ColoredBox && w.color == const Color(0xffabcdef)),
        findsWidgets);
    warm.config.complete({
      'widget': {'themeColor': '#654321', 'showHandoffButton': false}
    });
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    await cold.pages.close();
    await cold.reads.close();
    cold.close();
    await warm.pages.close();
    await warm.reads.close();
    warm.close();
  });

  testWidgets('compact header omits title and welcome follows window language',
      (tester) async {
    final c = FakeClient();
    await tester.pumpWidget(
        MaterialApp(home: FastCatChat(client: c, locale: const Locale('en'))));
    await tester.pumpAndSettle();
    c.pages.add({
      'messages': [
        {
          'id': 'welcome',
          'seq': 1,
          'role': 'agent',
          'source': 'welcome',
          'body': '欢迎咨询'
        }
      ],
      'nextCursor': 1
    });
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.text('Hidden title'), findsNothing);
    expect(find.text('Welcome to support', findRichText: true), findsOneWidget);
    expect(
        tester
            .widget<PreferredSize>(find.byType(PreferredSize))
            .preferredSize
            .height,
        40);
    await tester.pumpWidget(MaterialApp(
        home: FastCatChat(client: c, locale: const Locale('zh', 'CN'))));
    await tester.pumpAndSettle();
    expect(find.text('欢迎咨询', findRichText: true), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await c.pages.close();
    await c.reads.close();
    c.close();
  });

  testWidgets('desktop host input styling does not override the SDK composer',
      (tester) async {
    tester.view.physicalSize = const Size(1440, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final c = FakeClient();
    await tester.pumpWidget(MaterialApp(
        theme: ThemeData(
            inputDecorationTheme: const InputDecorationTheme(
                filled: true,
                fillColor: Colors.red,
                border: OutlineInputBorder())),
        home: FastCatChat(client: c)));
    await tester.pumpAndSettle();
    final input = tester.widget<TextField>(find.byType(TextField));
    expect(input.decoration!.filled, isFalse);
    expect(input.decoration!.focusedBorder, InputBorder.none);
    c.pages.add({
      'messages': [
        {
          'id': 'image',
          'seq': 1,
          'role': 'visitor',
          'attachment': {
            'id': 'photo',
            'mime': 'image/png',
            'filename': 'photo.png'
          },
          'created': '2026-11-01T08:00:00Z'
        }
      ],
      'nextCursor': 1
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('photo.png'), findsNothing);
    expect(find.text('  ✓'), findsOneWidget);
    c.pages.add({
      'messages': [],
      'nextCursor': 1,
      'receipts': {'readSeq': 1}
    });
    await tester.pump();
    expect(find.text('  ✓✓'), findsOneWidget);
    expect(tester.getSize(find.byType(FutureBuilder<Uint8List>)).width,
        lessThan(240));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await c.pages.close();
    await c.reads.close();
    c.close();
  });

  testWidgets(
      'emoji selection restores caret while dismissal stays unfocused; sending scrolls to latest',
      (tester) async {
    final c = FakeClient();
    await tester.pumpWidget(MaterialApp(
        home: FastCatChat(client: c, locale: const Locale('zh', 'CN'))));
    await tester.pumpAndSettle();
    c.pages.add({
      'messages': List.generate(
          25,
          (i) => {
                'id': '$i',
                'seq': i + 1,
                'role': 'agent',
                'body': 'Message $i',
                'created': '2026-11-01T08:00:00Z'
              }),
      'nextCursor': 25
    });
    await tester.pumpAndSettle();
    await tester.tap(find.byType(TextField));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'hello');
    tester.widget<TextField>(find.byType(TextField)).controller!.selection =
        const TextSelection(baseOffset: 1, extentOffset: 3);
    await tester.tap(find.byTooltip('选择表情'));
    await tester.pumpAndSettle();
    expect(find.byType(BackButton), findsNothing);
    await tester.tap(find.text('😀'));
    await tester.pumpAndSettle();
    final selectedInput = tester.widget<TextField>(find.byType(TextField));
    expect(selectedInput.focusNode!.hasFocus, isTrue);
    expect(tester.testTextInput.isVisible, isTrue);
    expect(selectedInput.controller!.text, 'h😀lo');
    expect(selectedInput.controller!.selection.baseOffset, 3);
    await tester.tap(find.byTooltip('选择表情'));
    await tester.pumpAndSettle();
    await tester.tapAt(const Offset(5, 100));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(find.byType(TextField)).focusNode!.hasFocus,
        isFalse);
    final list = tester.widget<ListView>(find.byType(ListView));
    list.controller!.jumpTo(0);
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'send now');
    await tester.tap(find.byTooltip('发送'));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(find.byType(TextField)).focusNode!.hasFocus,
        isFalse);
    expect(list.controller!.offset, list.controller!.position.maxScrollExtent);
    await tester.pumpWidget(const SizedBox());
    await c.pages.close();
    await c.reads.close();
    c.close();
  });

  testWidgets('visitor receipt appears after time and updates when read',
      (tester) async {
    final c = FakeClient();
    await tester.pumpWidget(MaterialApp(
        home: FastCatChat(client: c, locale: const Locale('zh', 'CN'))));
    c.pages.add({
      'messages': [
        {
          'id': 'sent',
          'seq': 4,
          'role': 'visitor',
          'body': 'Hello',
          'created': '2026-10-27T08:00:00Z'
        }
      ],
      'nextCursor': 4,
      'receipts': {'readSeq': 0}
    });
    await tester.pump();
    expect(find.text('  ✓'), findsOneWidget);
    c.pages.add({
      'messages': [],
      'nextCursor': 4,
      'receipts': {'readSeq': 4}
    });
    await tester.pump();
    expect(find.text('  ✓✓'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    unawaited(c.pages.close());
    unawaited(c.reads.close());
    await tester.pump();
    c.close();
  });
  testWidgets(
      'chat follows host English and dark mode, keeps backend accent and sends after closure',
      (tester) async {
    final c = FakeClient();
    final scheme = ColorScheme.fromSeed(
        seedColor: Colors.orange, brightness: Brightness.dark);
    await tester.pumpWidget(MaterialApp(
        theme: ThemeData.dark().copyWith(colorScheme: scheme),
        home: FastCatChat(client: c)));
    await tester.pump();
    expect(find.text('Support'), findsNothing);
    expect(find.text('Talk to a person'), findsNothing);
    final context = tester.element(find.byType(TextField));
    expect(Theme.of(context).brightness, Brightness.dark);
    expect(Theme.of(context).colorScheme.primary, const Color(0xff146355));
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
    expect(find.text('联系人工'), findsNothing);
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
    tester.state<NavigatorState>(find.byType(Navigator).first).pop();
    await tester.pumpAndSettle();
    expect(find.text('1'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    unawaited(c.pages.close());
    unawaited(c.reads.close());
    await tester.pump();
    c.close();
  });
  testWidgets(
      'streamed AI drafts show latest while unchanged polling stays put',
      (tester) async {
    final c = FakeClient();
    await tester.pumpWidget(MaterialApp(home: FastCatChat(client: c)));
    await tester.pumpAndSettle();
    final messages = [
      {
        'id': 'long',
        'seq': 1,
        'role': 'agent',
        'body': List.filled(100, '长消息内容').join('\n'),
        'created': '2026-11-02T08:00:00Z'
      }
    ];
    c.pages.add({'messages': messages, 'nextCursor': 1});
    await tester.pumpAndSettle();
    final controller =
        tester.widget<ListView>(find.byType(ListView)).controller!;
    controller.jumpTo(controller.position.maxScrollExtent - 40);
    await tester.pump();
    c.pages.add({
      'messages': messages,
      'nextCursor': 1,
      'automation': {'typing': true, 'draft': '正在整理答复'}
    });
    await tester.pumpAndSettle();
    expect(controller.offset, closeTo(controller.position.maxScrollExtent, .1));
    c.pages.add({
      'messages': messages,
      'nextCursor': 1,
      'automation': {'typing': true, 'draft': '正在整理答复，继续补充内容'}
    });
    await tester.pumpAndSettle();
    expect(controller.offset, closeTo(controller.position.maxScrollExtent, .1));
    await tester.pumpWidget(const SizedBox());
    await c.pages.close();
    await c.reads.close();
    c.close();
  });
  testWidgets('incoming replies show latest even after manual scrolling',
      (tester) async {
    final c = FakeClient();
    await tester.pumpWidget(MaterialApp(home: FastCatChat(client: c)));
    await tester.pumpAndSettle();
    Map<String, dynamic> message(int seq) => {
          'id': '$seq',
          'seq': seq,
          'role': 'agent',
          'body': List.filled(100, '客服回复').join('\n'),
          'created': '2026-11-02T08:00:00Z'
        };
    c.pages.add({
      'messages': [message(1)],
      'nextCursor': 1
    });
    await tester.pumpAndSettle();
    c.pages.add({
      'messages': [message(2)],
      'nextCursor': 2
    });
    await tester.pumpAndSettle();
    final controller =
        tester.widget<ListView>(find.byType(ListView)).controller!;
    expect(controller.offset, closeTo(controller.position.maxScrollExtent, .1));
    await tester.drag(find.byType(ListView), const Offset(0, 180));
    await tester.pumpAndSettle();
    final offset = controller.offset;
    c.pages.add({
      'messages': [message(3)],
      'nextCursor': 3
    });
    await tester.pumpAndSettle();
    expect(controller.offset, greaterThan(offset));
    expect(controller.offset, closeTo(controller.position.maxScrollExtent, .1));
    await tester.pumpWidget(const SizedBox());
    await c.pages.close();
    await c.reads.close();
    c.close();
  });
  testWidgets('thinking bubble uses the configured AI avatar', (tester) async {
    final bytes = await tester.runAsync(() async {
      final recorder = ui.PictureRecorder();
      final canvas = ui.Canvas(recorder);
      canvas.drawColor(const ui.Color(0xff146355), ui.BlendMode.src);
      final image = await recorder.endRecording().toImage(1, 1);
      return await image.toByteData(format: ui.ImageByteFormat.png);
    });
    final avatar =
        'data:image/png;base64,${base64Encode(bytes!.buffer.asUint8List())}';
    final c = FakeClient();
    await tester.pumpWidget(MaterialApp(home: FastCatChat(client: c)));
    await tester.pumpAndSettle();
    c.pages.add({
      'messages': [],
      'nextCursor': 0,
      'automation': {'typing': true, 'aiAvatar': avatar}
    });
    await tester.pumpAndSettle();
    final widget = tester.widget<Image>(find.byType(Image));
    expect((widget.image as MemoryImage).bytes, bytes.buffer.asUint8List());
    await tester.pumpWidget(const SizedBox());
    await c.pages.close();
    await c.reads.close();
    c.close();
  });
}
