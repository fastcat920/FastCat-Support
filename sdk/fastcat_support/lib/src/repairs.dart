import 'dart:async';
import 'dart:convert';
import 'client.dart';

class FastCatRouteOption {
  final String id, label;
  const FastCatRouteOption({required this.id, required this.label});
  Map<String, dynamic> toJson() => {'id': id, 'label': label};
}

class FastCatRepairRequest {
  final String id, operation;
  final String? restoreRequestId, targetRouteId, targetRouteLabel;
  final DateTime expiresAt;
  bool Function()? authorizationStillValid;
  FastCatRepairRequest(
      {required this.id,
      required this.operation,
      required this.expiresAt,
      this.restoreRequestId,
      this.targetRouteId,
      this.targetRouteLabel});

  /// Only guards starting a modification. Local verification/rollback must continue after disconnect.
  void throwIfCannotStart() {
    if (DateTime.now().isAfter(expiresAt) ||
        authorizationStillValid?.call() == false)
      throw StateError('Repair start authorization expired');
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'operation': operation,
        'expires': expiresAt.millisecondsSinceEpoch,
        'restore_request_id': restoreRequestId,
        'target_route_id': targetRouteId,
        'target_route_label': targetRouteLabel
      };
  factory FastCatRepairRequest.fromJson(Map<String, dynamic> r) =>
      FastCatRepairRequest(
          id: r['id'],
          operation: r['operation'],
          expiresAt: DateTime.fromMillisecondsSinceEpoch(r['expires']),
          restoreRequestId: r['restore_request_id'],
          targetRouteId: r['target_route_id'],
          targetRouteLabel: r['target_route_label']);
}

class FastCatRepairResult {
  /// succeeded / failed / rolled_back / not_started. Never report a timeout as a known failure.
  final String outcome, summary, rollback;
  final bool verified, snapshotAvailable;
  final bool? originalRouteRestored;
  const FastCatRepairResult(
      {required this.outcome,
      required this.summary,
      required this.verified,
      this.snapshotAvailable = false,
      this.rollback = 'not_needed',
      this.originalRouteRestored});
  Map<String, dynamic> toJson() => {
        'outcome': outcome,
        'summary': summary,
        'verified': verified,
        'snapshotAvailable': snapshotAvailable,
        'rollback': rollback,
        if (originalRouteRestored != null)
          'originalRouteRestored': originalRouteRestored
      };
}

class FastCatRepairHandler {
  /// Must durably deduplicate by request.id and save settings before touching them.
  final Future<FastCatRepairResult> Function(FastCatRepairRequest request)
      execute;

  /// Read-only lookup of the host's durable execution ledger. Never execute or retry the repair here.
  final Future<FastCatRepairResult?> Function(FastCatRepairRequest request)
      recover;

  /// Required for reapply_proxy, restore_settings and switch_route. The host owns local snapshots and rollback.
  final bool supportsRollback;
  const FastCatRepairHandler(
      {required this.execute,
      required this.recover,
      this.supportsRollback = false});
}

/// Persists execution intent before dispatch and never re-dispatches an accepted operation.
/// The host remains responsible for OS-side idempotency, verification and local rollback.
class FastCatRepairCoordinator {
  final FastCatClient client;
  final _inFlight = <String>{};
  bool _confirming = false, _recovering = false;
  bool english = false;
  FastCatRepairCoordinator(this.client);
  bool get busy => _confirming || _inFlight.isNotEmpty;
  List<String> get capabilities => client.store == null
      ? []
      : client.repairHandlers.entries
          .where((e) =>
              [
                'reconnect',
                'restart_core',
                'reapply_proxy',
                'restore_settings',
                'switch_route'
              ].contains(e.key) &&
              (e.key != 'switch_route' || client.routeOptions != null) &&
              (!['reapply_proxy', 'restore_settings', 'switch_route']
                      .contains(e.key) ||
                  e.value.supportsRollback))
          .map((e) => e.key)
          .toList();
  String get _key => client.repairStorageKey;
  Future<Map<String, dynamic>> _read(String key) async {
    final text = await client.store!.read(key);
    if (text == null) return {};
    // Corruption must stop execution rather than silently erase deduplication history.
    return Map<String, dynamic>.from(jsonDecode(text) as Map);
  }

  Future<void> _save(String key, Map<String, dynamic> ledger) =>
      client.store!.write(key, jsonEncode(ledger));
  Future<void> confirm(Map row, {String? grantId}) async {
    if (_confirming || _recovering || busy)
      throw StateError('A repair is already running');
    if (!capabilities.contains(row['operation']))
      throw StateError('Host repair capability unavailable');
    _confirming = true;
    final key = _key, conversation = client.conversationId;
    final id = row['id'] as String;
    try {
      var ledger = await _read(key);
      if (ledger.containsKey(id))
        throw StateError(
            'This request was already recorded. Query its result instead of executing again.');
      final device = await client.diagnosticDeviceId();
      final executionKey = FastCatClient.newClientId();
      final record = <String, dynamic>{
        'phase': 'prepared',
        'deviceId': device,
        'requestId': id,
        'executionKey': executionKey,
        'request': Map<String, dynamic>.from(row)
      };
      ledger[id] = record;
      await _save(key, ledger);
      final accepted = await client.assistance(action: 'repair_accept', data: {
        'deviceId': device,
        'requestId': id,
        'executionKey': executionKey,
        if (grantId != null) 'grantId': grantId
      });
      if (client.conversationId != conversation)
        throw StateError('Support session changed');
      final actual =
          (accepted['repairs'] as List).firstWhere((r) => r['id'] == id);
      if (actual['status'] != 'running')
        throw StateError('Repair was not authorized to start');
      final request =
          FastCatRepairRequest.fromJson(Map<String, dynamic>.from(actual));
      request.authorizationStillValid = () =>
          !client.isClosed &&
          (grantId == null || client.activeConsentIds.contains(grantId));
      request.throwIfCannotStart();
      record['request'] = request.toJson();
      record['phase'] = 'dispatched';
      ledger = await _read(key);
      ledger[id] = record;
      await _save(key, ledger);
      _inFlight.add(id);
      try {
        request.throwIfCannotStart();
        final result = await client.repairHandlers[request.operation]!
            .execute(request)
            .timeout(const Duration(seconds: 120));
        record['result'] = result.toJson();
        record['phase'] = 'result';
        ledger = await _read(key);
        ledger[id] = record;
        await _save(key, ledger);
      } catch (_) {
        // A callback exception may occur after an OS side effect; only recover() can establish the outcome.
      } finally {
        _inFlight.remove(id);
      }
      if (client.conversationId == conversation)
        await _deliver(key, id, record);
    } finally {
      _confirming = false;
    }
  }

  Future<void> _deliver(
      String key, String id, Map<String, dynamic> record) async {
    if (record['phase'] != 'result') return;
    if (record['notification'] == null) {
      record['notification'] = english
          ? 'The repair result has been submitted. Please review the execution record.'
          : '修复结果已提交，请根据执行记录继续排查。';
      final saved = await _read(key);
      saved[id] = record;
      await _save(key, saved);
    }
    final response = await client.assistance(action: 'repair_result', data: {
      'deviceId': record['deviceId'],
      'requestId': id,
      'executionKey': record['executionKey'],
      'result': record['result']
    });
    if (response['conversationClosed'] != true)
      await client.sendText(record['notification'] as String,
          clientId: 'repair_$id');
    final ledger = await _read(key);
    // Retain a compact tombstone: never forget that this request has already been dispatched.
    ledger[id] = {'phase': 'delivered'};
    await _save(key, ledger);
  }

  Future<void> reconcile(List repairs) async {
    if (_recovering ||
        _confirming ||
        client.store == null ||
        !client.hasSession) return;
    _recovering = true;
    final key = _key, conversation = client.conversationId;
    try {
      final ledger = await _read(key);
      for (final entry in ledger.entries) {
        if (client.conversationId != conversation) return;
        final id = entry.key,
            record = Map<String, dynamic>.from(entry.value as Map);
        if (record['phase'] == 'delivered' || _inFlight.contains(id)) continue;
        final rows = repairs.where((r) => r['id'] == id);
        if (record['phase'] == 'prepared') {
          if (rows.isEmpty) continue;
          final row = rows.first;
          if (['pending', 'expired', 'declined', 'revoked']
              .contains(row['status'])) {
            final fresh = await _read(key);
            fresh.remove(id);
            await _save(key, fresh);
            continue;
          }
          record['result'] = FastCatRepairResult(
                  originalRouteRestored:
                      record['request']['operation'] == 'switch_route'
                          ? true
                          : null,
                  outcome: 'not_started',
                  summary: '执行前连接中断，未调用客户端修复。',
                  verified: false)
              .toJson();
          record['phase'] = 'result';
        } else if (record['phase'] == 'dispatched') {
          final request = FastCatRepairRequest.fromJson(
              Map<String, dynamic>.from(record['request']));
          final handler = client.repairHandlers[request.operation];
          if (handler == null) continue;
          final result = await handler
              .recover(request)
              .timeout(const Duration(seconds: 10));
          if (result == null) continue;
          record['result'] = result.toJson();
          record['phase'] = 'result';
        }
        if (record['phase'] == 'result') {
          final fresh = await _read(key);
          fresh[id] = record;
          await _save(key, fresh);
          await _deliver(key, id, record);
        }
      }
    } finally {
      _recovering = false;
    }
  }
}
