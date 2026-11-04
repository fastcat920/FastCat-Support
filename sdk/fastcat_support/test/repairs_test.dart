import 'package:flutter/material.dart';
import 'dart:convert';
import 'package:fastcat_support/fastcat_support.dart';
import 'package:flutter_test/flutter_test.dart';

class RepairStore implements FastCatSessionStore {
  final values = <String, String>{};
  bool failWrites = false;
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    if (failWrites) throw StateError('storage unavailable');
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

class RepairClient extends FastCatClient {
  int uploads = 0, accepts = 0;
  bool failUpload = false, loseAcceptResponse = false;
  String status = 'pending';
  RepairClient(RepairStore store)
      : super(
            baseUrl: Uri.parse('https://repair.test'),
            appKey: 'test',
            store: store);
  @override
  bool get hasSession => true;
  @override
  String? get conversationId => 'conversation';
  @override
  Future<String> diagnosticDeviceId() async => 'device_12345678901234';
  Map<String, dynamic> get row => {
        'id': 'repair-request',
        'operation': 'reconnect',
        'label': '重新连接',
        'reason': '排查问题',
        'impact': '可能短暂断网',
        'status': status,
        'expires': DateTime.now()
            .add(const Duration(minutes: 3))
            .millisecondsSinceEpoch
      };
  @override
  Future<Map<String, dynamic>> assistance(
      {String? action, Map<String, dynamic> data = const {}}) async {
    if (action == 'repair_accept') {
      accepts++;
      status = 'running';
      if (loseAcceptResponse) throw StateError('network after accept');
    }
    if (action == 'repair_result') {
      uploads++;
      if (failUpload) throw StateError('offline');
      status = data['result']['outcome'];
    }
    return {
      'repairs': [row]
    };
  }

  @override
  Future<Map<String, dynamic>> sendText(String text,
          {required String clientId}) async =>
      {};
}

class ScopedRepairClient extends RepairClient {
  bool granted = false;
  int grants = 0;
  ScopedRepairClient(super.store);
  @override
  Future<Map<String, dynamic>> assistance(
      {String? action, Map<String, dynamic> data = const {}}) async {
    if (action == 'scope_grant') {
      granted = true;
      grants++;
    }
    if (action == 'scope_revoke') granted = false;
    if (action == 'repair_accept') expect(data['grantId'], 'op');
    final value = await super.assistance(action: action, data: data);
    return {
      ...value,
      'requests': [],
      'device': {
        'consentRequired': true,
        'capabilities': [],
        'repairCapabilities': ['reconnect'],
        'routeOptions': []
      },
      'consents': {
        'query': null,
        'operation': granted
            ? {
                'id': 'op',
                'expires': DateTime.now()
                    .add(const Duration(minutes: 30))
                    .millisecondsSinceEpoch,
                'capabilities': ['reconnect'],
                'routes': []
              }
            : null
      }
    };
  }
}

const success = FastCatRepairResult(
    outcome: 'succeeded', summary: 'verified', verified: true);
void main() {
  test(
      'repair executes only on explicit confirm and duplicate confirm never executes it again',
      () async {
    final client = RepairClient(RepairStore());
    int calls = 0;
    client.repairHandlers = {
      'reconnect': FastCatRepairHandler(
          execute: (r) async {
            calls++;
            return success;
          },
          recover: (r) async => success)
    };
    expect(calls, 0);
    await client.repairs.confirm(client.row);
    expect(calls, 1);
    expect(client.uploads, 1);
    await expectLater(client.repairs.confirm(client.row), throwsStateError);
    expect(calls, 1);
    client.close();
  });
  test(
      'offline result persists and a new SDK instance only submits result without re-executing',
      () async {
    final store = RepairStore();
    final first = RepairClient(store)..failUpload = true;
    int calls = 0;
    final handler = FastCatRepairHandler(
        execute: (r) async {
          calls++;
          return success;
        },
        recover: (r) async => success);
    first.repairHandlers = {'reconnect': handler};
    await expectLater(first.repairs.confirm(first.row), throwsStateError);
    first.close();
    final second = RepairClient(store)..repairHandlers = {'reconnect': handler};
    await second.repairs.reconcile([second.row]);
    expect(calls, 1);
    expect(second.uploads, 1);
    expect(
        jsonDecode(store.values[second.repairStorageKey]!)['repair-request']
            ['phase'],
        'delivered');
    second.close();
  });
  test('uncertain host exception queries recovery and never repeats execute',
      () async {
    final client = RepairClient(RepairStore());
    int calls = 0, recoveries = 0;
    client.repairHandlers = {
      'reconnect': FastCatRepairHandler(execute: (r) async {
        calls++;
        throw StateError('may have changed OS state');
      }, recover: (r) async {
        recoveries++;
        return recoveries == 1 ? null : success;
      })
    };
    await client.repairs.confirm(client.row);
    expect(client.uploads, 0);
    await client.repairs.reconcile([client.row]);
    expect(client.uploads, 0);
    await client.repairs.reconcile([client.row]);
    expect(calls, 1);
    expect(client.uploads, 1);
    client.close();
  });
  test(
      'storage failure blocks repair and lost acceptance never causes automatic execution',
      () async {
    final store = RepairStore()..failWrites = true;
    final client = RepairClient(store);
    int calls = 0;
    client.repairHandlers = {
      'reconnect': FastCatRepairHandler(
          execute: (r) async {
            calls++;
            return success;
          },
          recover: (r) async => null)
    };
    await expectLater(client.repairs.confirm(client.row), throwsStateError);
    expect(client.accepts, 0);
    expect(calls, 0);
    store.failWrites = false;
    client.loseAcceptResponse = true;
    await expectLater(client.repairs.confirm(client.row), throwsStateError);
    await client.repairs.reconcile([client.row]);
    expect(client.status, 'not_started');
    expect(calls, 0);
    client.close();
  });
  test(
      'proxy-changing capabilities require an explicit local rollback contract',
      () {
    final client = RepairClient(RepairStore());
    client.repairHandlers = {
      'reapply_proxy': FastCatRepairHandler(
          execute: (r) async => success, recover: (r) async => null)
    };
    expect(client.repairs.capabilities, isEmpty);
    client.close();
  });
  testWidgets('repair consent card does not execute until the user confirms',
      (tester) async {
    final client = RepairClient(RepairStore());
    var calls = 0;
    client.repairHandlers = {
      'reconnect': FastCatRepairHandler(
          execute: (r) async {
            calls++;
            return success;
          },
          recover: (r) async => null)
    };
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: FastCatAssistancePanel(client: client))));
    await tester.pump();
    expect(calls, 0);
    await tester.ensureVisible(find.text('确认修复'));
    await tester.tap(find.text('确认修复'));
    await tester.pump();
    await tester.pump();
    expect(calls, 1);
    expect(client.uploads, 1);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
  test(
      'route switching requires metadata provider and rollback support; request fields survive persistence',
      () {
    final client = RepairClient(RepairStore());
    final handler = FastCatRepairHandler(
        execute: (r) async => success,
        recover: (r) async => null,
        supportsRollback: true);
    client.repairHandlers = {'switch_route': handler};
    expect(client.repairs.capabilities, isEmpty);
    client.routeOptions =
        () async => [const FastCatRouteOption(id: 'alt_1', label: 'Backup')];
    expect(client.repairs.capabilities, ['switch_route']);
    final request = FastCatRepairRequest(
        id: 'r',
        operation: 'switch_route',
        expiresAt: DateTime.now(),
        targetRouteId: 'alt_1',
        targetRouteLabel: 'Backup');
    expect(
        FastCatRepairRequest.fromJson(request.toJson()).targetRouteId, 'alt_1');
    expect(
        const FastCatRepairResult(
                outcome: 'succeeded',
                summary: 'Compared',
                verified: true,
                originalRouteRestored: true)
            .toJson()['originalRouteRestored'],
        true);
    client.close();
  });
  testWidgets(
      'operation scope grant starts the authorized repair without a second per-request confirmation',
      (tester) async {
    final client = ScopedRepairClient(RepairStore());
    var calls = 0;
    client.repairHandlers = {
      'reconnect': FastCatRepairHandler(
          execute: (r) async {
            r.throwIfCannotStart();
            calls++;
            return success;
          },
          recover: (r) async => null)
    };
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: FastCatAssistancePanel(client: client))));
    await tester.pump();
    expect(calls, 0);
    await tester.ensureVisible(find.text('允许操作'));
    await tester.tap(find.text('允许操作'));
    await tester.pump();
    await tester.pump();
    expect(calls, 1);
    expect(client.grants, 1);
    expect(client.uploads, 1);
    expect(find.text('确认修复'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
}
