import 'dart:async';
import 'package:fastcat_support/fastcat_support.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class DiagnosticClient extends FastCatClient {
  String status = 'pending';
  int accepts = 0, results = 0;
  bool failFirstUpload = false;
  DiagnosticClient()
      : super(baseUrl: Uri.parse('https://example.com'), appKey: 'test');
  @override
  bool get hasSession => true;
  @override
  Future<String> diagnosticDeviceId() async => 'device_12345678901234';
  @override
  Future<Map<String, dynamic>> assistance(
      {String? action, Map<String, dynamic> data = const {}}) async {
    if (action == 'accept') {
      accepts++;
      status = 'running';
    }
    if (action == 'decline') status = 'declined';
    if (action == 'revoke') status = 'revoked';
    if (action == 'result') {
      results++;
      if (failFirstUpload && results == 1) throw StateError('network');
      status = 'succeeded';
    }
    return {
      'requests': [
        {
          'id': 'r',
          'capability': 'basic',
          'reason': '排查问题',
          'status': status,
          'expires': DateTime.now()
              .add(const Duration(minutes: 2))
              .millisecondsSinceEpoch
        }
      ]
    };
  }

  @override
  Future<Map<String, dynamic>> sendText(String text,
          {required String clientId}) async =>
      {};
}

class ScopedDiagnosticClient extends DiagnosticClient {
  bool granted = false;
  int grants = 0;
  final states = {'r1': 'pending', 'r2': 'pending'};
  @override
  Future<Map<String, dynamic>> assistance(
      {String? action, Map<String, dynamic> data = const {}}) async {
    if (action == 'scope_grant') {
      granted = true;
      grants++;
    }
    if (action == 'scope_revoke') granted = false;
    if (action == 'accept') {
      expect(data['grantId'], 'q');
      accepts++;
      states[data['requestId']] = 'running';
    }
    if (action == 'result') {
      results++;
      states[data['requestId']] = 'succeeded';
    }
    return {
      'device': {
        'consentRequired': true,
        'capabilities': ['basic'],
        'repairCapabilities': []
      },
      'consents': {
        'query': granted
            ? {
                'id': 'q',
                'capabilities': ['basic'],
                'routes': [],
                'expires': DateTime.now()
                    .add(const Duration(minutes: 30))
                    .millisecondsSinceEpoch
              }
            : null,
        'operation': null
      },
      'requests': states.entries
          .map((e) => {
                'id': e.key,
                'capability': 'basic',
                'reason': '排查',
                'status': e.value,
                'expires': DateTime.now()
                    .add(const Duration(minutes: 2))
                    .millisecondsSinceEpoch
              })
          .toList(),
      'repairs': []
    };
  }
}

void main() {
  testWidgets('no authorization and no pending request hides management',
      (tester) async {
    final c = ScopedDiagnosticClient();
    c.states.clear();
    await tester.pumpWidget(
        MaterialApp(home: Scaffold(body: FastCatAssistancePanel(client: c))));
    await tester.pumpAndSettle();
    expect(find.text('管理'), findsNothing);
    expect(find.textContaining('未授权'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    c.close();
  });

  testWidgets(
      'diagnostic callback only runs after explicit consent, result is submitted once',
      (tester) async {
    final client = DiagnosticClient();
    int calls = 0;
    client.diagnosticHandlers = {
      'basic': (request) async {
        calls++;
        request.throwIfCancelled();
        return {'summary': 'ok'};
      }
    };
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: FastCatAssistancePanel(client: client))));
    await tester.pump();
    expect(calls, 0);
    await tester.tap(find.text('同意并诊断'));
    await tester.pump();
    await tester.pump();
    expect(calls, 1);
    expect(client.accepts, 1);
    expect(client.results, 1);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
  testWidgets('retrying report upload does not run diagnostics again',
      (tester) async {
    final client = DiagnosticClient()..failFirstUpload = true;
    var calls = 0;
    client.diagnosticHandlers = {
      'basic': (request) async {
        calls++;
        return {'summary': 'ok'};
      }
    };
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: FastCatAssistancePanel(client: client))));
    await tester.pump();
    await tester.tap(find.text('同意并诊断'));
    await tester.pump();
    await tester.pump();
    expect(find.text('重新提交报告'), findsOneWidget);
    await tester.tap(find.text('重新提交报告'));
    await tester.pump();
    await tester.pump();
    expect(calls, 1);
    expect(client.results, 2);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
  testWidgets('revoking a running diagnostic prevents later report upload',
      (tester) async {
    final client = DiagnosticClient();
    final completion = Completer<Map<String, dynamic>>();
    FastCatDiagnosticRequest? active;
    client.diagnosticHandlers = {
      'basic': (request) {
        active = request;
        return completion.future;
      }
    };
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: FastCatAssistancePanel(client: client))));
    await tester.pump();
    await tester.tap(find.text('同意并诊断'));
    await tester.pump();
    await tester.tap(find.text('撤回授权'));
    await tester.pump();
    expect(active!.isCancelled, true);
    completion.complete({'summary': 'late'});
    await tester.pump();
    expect(client.results, 0);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
  testWidgets(
      'one query grant automatically handles subsequent requests and revocation stops new collection',
      (tester) async {
    final client = ScopedDiagnosticClient();
    var calls = 0;
    client.diagnosticHandlers = {
      'basic': (r) async {
        calls++;
        return {'summary': 'ok'};
      }
    };
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: FastCatAssistancePanel(client: client))));
    await tester.pump();
    expect(calls, 0);
    await tester.ensureVisible(find.text('允许查询'));
    await tester.tap(find.text('允许查询'));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(seconds: 4));
    await tester.pump();
    expect(calls, 2);
    expect(client.grants, 1);
    await tester.tap(find.text('管理'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('撤回查询授权'));
    await tester.tap(find.text('撤回查询授权'));
    await tester.pump();
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();
    await tester.pump();
    client.states['r3'] = 'pending';
    await tester.pump(const Duration(seconds: 4));
    await tester.pump();
    expect(calls, 2);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
}
