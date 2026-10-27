import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fastcat_support/fastcat_support.dart';

void main() {
  testWidgets(
      'Markdown uses the bounded renderer while visitor text stays plain',
      (tester) async {
    await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: FastCatMessageBody(body: '# 标题\n\n**重点**'))));
    expect(find.byType(MarkdownBody), findsOneWidget);
    await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: FastCatMessageBody(body: '**原文**', plain: true))));
    expect(find.byType(MarkdownBody), findsNothing);
    expect(find.text('**原文**'), findsOneWidget);
  });
  testWidgets(
      'structured form actions use entered values and cannot open javascript URLs',
      (tester) async {
    String? message;
    Uri? opened;
    final body = jsonEncode({
      'type': 'json_render',
      'spec': {
        'root': 'card',
        'elements': {
          'card': {
            'type': 'Card',
            'children': ['field', 'send', 'bad']
          },
          'field': {
            'type': 'Input',
            'props': {'name': 'order', 'label': '订单号'}
          },
          'send': {
            'type': 'Button',
            'props': {'label': '查询', 'message': '查询 {{order}}'}
          },
          'bad': {
            'type': 'Button',
            'props': {'label': '不安全链接', 'url': 'javascript:alert(1)'}
          }
        }
      }
    });
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: FastCatMessageBody(
                body: body,
                onMessage: (s) => message = s,
                onOpenLink: (u) => opened = u))));
    await tester.enterText(find.byType(TextFormField), '42');
    await tester.tap(find.text('查询'));
    expect(message, '查询 42');
    final bad =
        tester.widget<TextButton>(find.widgetWithText(TextButton, '不安全链接'));
    expect(bad.onPressed, isNull);
    expect(opened, isNull);
  });
  testWidgets('cyclic structured trees fall back without crashing',
      (tester) async {
    final body = jsonEncode({
      'type': 'json_render',
      'spec': {
        'root': 'a',
        'elements': {
          'a': {
            'type': 'Card',
            'children': ['a']
          }
        }
      }
    });
    await tester.pumpWidget(
        MaterialApp(home: Scaffold(body: FastCatMessageBody(body: body))));
    expect(find.textContaining('Unable to render structured content'),
        findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
