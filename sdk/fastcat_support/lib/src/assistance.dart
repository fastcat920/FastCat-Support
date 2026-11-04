import 'strings.dart';
import 'repairs.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'client.dart';

/// A host must check [isCancelled] before every collection step and redact secrets.
class FastCatDiagnosticRequest {
  final String id;
  final String capability;
  final DateTime expiresAt;
  bool _cancelled = false;
  bool get isCancelled => _cancelled || DateTime.now().isAfter(expiresAt);
  void cancel() => _cancelled = true;
  FastCatDiagnosticRequest(
      {required this.id, required this.capability, required this.expiresAt});
  void throwIfCancelled() {
    if (isCancelled)
      throw StateError('Diagnostic authorization expired or revoked');
  }
}

typedef FastCatDiagnosticHandler = Future<Map<String, dynamic>> Function(
    FastCatDiagnosticRequest request);

/// Built-in consent UI. No callback is invoked by merely receiving a request.
class FastCatAssistancePanel extends StatefulWidget {
  final FastCatClient client;
  final bool english;
  final ValueChanged<Map<String, dynamic>>? onActivity;
  const FastCatAssistancePanel(
      {super.key, required this.client, this.english = false, this.onActivity});
  @override
  State<FastCatAssistancePanel> createState() => _FastCatAssistancePanelState();
}

class _FastCatAssistancePanelState extends State<FastCatAssistancePanel>
    with WidgetsBindingObserver {
  Timer? _timer;
  Map<String, dynamic>? _state;
  String? _deviceId, _error;
  bool _polling = false, _busy = false, _foreground = true;
  bool _autoProcessing = false;
  final Set<String> _attemptedRequests = {};
  bool get _scoped =>
      _state?.containsKey('consents') == true &&
      _state?['device']?['consentRequired'] == true;
  Map? _grant(String scope) => _state?['consents']?[scope] as Map?;
  bool _authorized(Map row, String scope) {
    final grant = _grant(scope);
    if (grant == null ||
        grant['expires'] <= DateTime.now().millisecondsSinceEpoch) return false;
    final capability = scope == 'query' ? row['capability'] : row['operation'];
    if (!(grant['capabilities'] as List).contains(capability)) return false;
    return capability != 'switch_route' ||
        (grant['routes'] as List).any((r) =>
            r['id'] == row['target_route_id'] &&
            r['label'] == row['target_route_label']);
  }

  void _takeState(Map<String, dynamic> state) {
    _state = state;
    widget.onActivity?.call(state);
    if (state.containsKey('consents')) {
      widget.client.activeConsentIds.clear();
      for (final scope in ['query', 'operation']) {
        final grant = state['consents']?[scope];
        if (grant != null &&
            grant['expires'] > DateTime.now().millisecondsSinceEpoch)
          widget.client.activeConsentIds.add(grant['id']);
      }
    }
  }

  Future<void> _scopeAction(String scope, bool grant,
      {bool decline = false}) async {
    final client = widget.client;
    if (!grant && !decline) {
      final old = _grant(scope);
      if (old != null) client.activeConsentIds.remove(old['id']);
      if (scope == 'query') _active?.cancel();
    }
    try {
      final state = await client.assistance(
          action: grant
              ? 'scope_grant'
              : (decline ? 'scope_decline' : 'scope_revoke'),
          data: {
            'scope': scope,
            'deviceId': _deviceId,
            'consentSessionId': client.consentSessionId
          });
      if (mounted && client == widget.client) {
        setState(() => _takeState(state));
        unawaited(_processAuthorized());
      }
    } catch (e) {
      if (mounted && client == widget.client)
        setState(() => _error = e.toString());
    }
  }

  Future<void> _processAuthorized() async {
    if (!_scoped ||
        _autoProcessing ||
        _busy ||
        !mounted ||
        !_foreground ||
        widget.client.isClosed) return;
    _autoProcessing = true;
    try {
      for (final scope in ['query', 'operation']) {
        final rows =
            (_state?[scope == 'query' ? 'requests' : 'repairs'] as List? ?? []);
        for (final row in rows) {
          if (!mounted || !_foreground || widget.client.isClosed) return;
          if (row['status'] != 'pending' || !_authorized(row, scope)) continue;
          final grantId = _grant(scope)!['id'] as String;
          if (!_attemptedRequests.add('${row['id']}:$grantId')) continue;
          if (scope == 'query')
            await _act(row, 'accept', grantId: grantId);
          else
            await _repairAction(row, true, grantId: grantId);
          return;
        }
      }
    } finally {
      _autoProcessing = false;
    }
  }

  String operationLabel(String operation) =>
      {
        'reconnect': t('重新连接', 'Reconnect'),
        'restart_core': t('重启内核', 'Restart core'),
        'reapply_proxy': t('重新应用代理', 'Reapply proxy'),
        'restore_settings': t('恢复原设置', 'Restore settings'),
        'switch_route': t('临时切换线路并恢复', 'Temporarily switch and restore route'),
      }[operation] ??
      operation;
  bool _needsConsent(String scope) =>
      (_state?[scope == 'query' ? 'requests' : 'repairs'] as List? ?? [])
          .any((r) => r['status'] == 'pending' && !_authorized(r, scope));
  Widget _scopeDetails(String scope, {required bool granted}) {
    final query = scope == 'query', g = _grant(scope);
    final List capabilities;
    if (granted) {
      capabilities = (g?['capabilities'] as List?) ?? [];
    } else {
      capabilities = (_state?['device']
              ?[query ? 'capabilities' : 'repairCapabilities'] as List?) ??
          [];
    }
    final List routes;
    if (granted) {
      routes = (g?['routes'] as List?) ?? [];
    } else {
      routes = (_state?['device']?['routeOptions'] as List?) ?? [];
    }
    return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
              query
                  ? t('信息查询', 'Information queries')
                  : t('协助修复', 'Repair operations'),
              style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Text(capabilities
              .map((c) => query ? capabilityLabel(c) : operationLabel(c))
              .join('、')),
          if (!query && routes.isNotEmpty)
            Text(
                '${t('备用线路', 'Alternate routes')}: ${routes.map((r) => r['label']).join('、')}'),
          const SizedBox(height: 8),
          Text(query
              ? t('30分钟内可自动查询上述信息，结果供本次会话AI与人工查看，最多保留7天。可随时撤回。',
                  'Allow these queries automatically for 30 minutes. Results are shared with this conversation’s AI and staff for up to 7 days. Revoke anytime.')
              : t('30分钟内可自动执行上述修复，可能短暂断网。线路验证后恢复原线路；客户端负责复查及必要回滚。撤回后停止新操作，已开始的操作需安全收尾。',
                  'Allow these repairs automatically for 30 minutes. Connectivity may pause. Route tests restore the original route; the host verifies and rolls back. Revocation stops new work, while started work completes safely.')),
          if (granted && g != null)
            Text(
                '${t('有效至', 'Valid until')} ${DateTime.fromMillisecondsSinceEpoch(g['expires']).toLocal().toString().substring(11, 16)}'),
        ]);
  }

  Future<void> _showScopeDetails(String scope) => showDialog<void>(
      context: context,
      useRootNavigator: false,
      builder: (dialog) => AlertDialog(
              title: Text(t('授权范围', 'Permission scope')),
              content: ConstrainedBox(
                  constraints: BoxConstraints(
                      maxWidth: 480,
                      maxHeight: MediaQuery.sizeOf(dialog).height * .65),
                  child: SingleChildScrollView(
                      child: _scopeDetails(scope, granted: false))),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(dialog),
                    child: Text(t('关闭', 'Close')))
              ]));
  Future<void> _manage() => showDialog<void>(
      context: context,
      useRootNavigator: false,
      builder: (dialog) => StatefulBuilder(
          builder: (context, refresh) => AlertDialog(
                  title: Text(t('授权管理', 'Manage permissions')),
                  content: ConstrainedBox(
                      constraints: BoxConstraints(
                          maxWidth: 480,
                          maxHeight: MediaQuery.sizeOf(dialog).height * .65),
                      child: SingleChildScrollView(
                          child: Column(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                            for (final scope in ['query', 'operation']) ...[
                              if (_grant(scope) != null) ...[
                                _scopeDetails(scope, granted: true),
                                TextButton(
                                    onPressed: () async {
                                      await _scopeAction(scope, false);
                                      if (dialog.mounted) refresh(() {});
                                    },
                                    child: Text(scope == 'query'
                                        ? t('撤回查询授权', 'Revoke query access')
                                        : t('撤回操作授权', 'Revoke repair access'))),
                              ] else
                                Text(scope == 'query'
                                    ? t('信息查询：未授权', 'Queries: not authorized')
                                    : t('协助修复：未授权', 'Repairs: not authorized')),
                              const SizedBox(height: 16)
                            ]
                          ]))),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(dialog),
                        child: Text(t('关闭', 'Close')))
                  ])));
  Widget _consentCard(String scope) {
    if (!_needsConsent(scope)) return const SizedBox.shrink();
    final query = scope == 'query';
    return Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                  query
                      ? t('允许查询设备信息？', 'Allow device information access?')
                      : t('允许协助修复？', 'Allow troubleshooting repairs?'),
                  style: const TextStyle(
                      fontWeight: FontWeight.w600, fontSize: 13)),
              Text(
                  query
                      ? t('设备、连接状态及脱敏日志，30分钟有效。',
                          'Device, connection and redacted logs. Valid for 30 minutes.')
                      : t('可重连、重启及调整代理，可能短暂断网。30分钟有效。',
                          'May reconnect, restart or adjust proxy settings. Connectivity may pause. Valid for 30 minutes.'),
                  style: const TextStyle(fontSize: 12)),
              Wrap(spacing: 4, runSpacing: 0, children: [
                TextButton(
                    onPressed: () => _showScopeDetails(scope),
                    child: Text(t('查看范围', 'View scope'))),
                TextButton(
                    onPressed: () => _scopeAction(scope, false, decline: true),
                    child: Text(t('暂不授权', 'Not now'))),
                FilledButton(
                    onPressed: () => _scopeAction(scope, true),
                    child: Text(_grant(scope) == null
                        ? (query
                            ? t('允许查询', 'Allow queries')
                            : t('允许操作', 'Allow repairs'))
                        : t('确认新增范围', 'Allow expanded scope'))),
              ])
            ]));
  }

  Widget _compactPanel() {
    bool active(String scope) {
      final grant = _grant(scope);
      return grant != null &&
          grant['expires'] is num &&
          grant['expires'] > DateTime.now().millisecondsSinceEpoch;
    }

    final query = active('query'), operation = active('operation');
    if (!query &&
        !operation &&
        !_needsConsent('query') &&
        !_needsConsent('operation') &&
        _error == null) return const SizedBox.shrink();
    return Material(
        color: Theme.of(context).colorScheme.surface,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (query || operation)
            SizedBox(
                height: 36,
                child: Padding(
                    padding: const EdgeInsets.only(left: 12, right: 4),
                    child: Row(children: [
                      Icon(Icons.shield_outlined,
                          size: 15,
                          color: Theme.of(context).colorScheme.primary),
                      const SizedBox(width: 6),
                      Expanded(
                          child: Text(
                              '${query ? t('查询已授权', 'Queries allowed') : t('查询未授权', 'Queries off')} · ${operation ? t('操作已授权', 'Repairs allowed') : t('操作未授权', 'Repairs off')}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12))),
                      TextButton(
                          onPressed: _manage, child: Text(t('管理', 'Manage'))),
                    ]))),
          if (_needsConsent('query') || _needsConsent('operation'))
            ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 160),
                child: SingleChildScrollView(
                    child: _needsConsent('query')
                        ? _consentCard('query')
                        : _consentCard('operation'))),
          if (_error != null)
            Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Row(children: [
                  Expanded(
                      child: Text(supportError(_error!, widget.english),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 12,
                              color: Theme.of(context).colorScheme.error))),
                  if (_pendingResult != null)
                    TextButton(
                        onPressed: _busy ? null : _retryResult,
                        child: Text(t('重试', 'Retry'))),
                  IconButton(
                      tooltip: t('关闭提示', 'Dismiss'),
                      onPressed: () => setState(() => _error = null),
                      icon: const Icon(Icons.close, size: 14))
                ])),
        ]));
  }

  FastCatDiagnosticRequest? _active;
  Map<String, dynamic>? _pendingResult;
  String capabilityLabel(String key) =>
      {
        'basic': t('客户端与系统信息', 'App and system information'),
        'status': t('连接及代理状态', 'Connection and proxy status'),
        'network': t('网络诊断', 'Network diagnostics'),
        'logs': t('脱敏日志', 'Redacted logs'),
        'routes': t('线路对比检测（最多3条）', 'Compare routes (up to 3)'),
      }[key] ??
      key;
  String t(String zh, String en) => widget.english ? en : zh;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _poll();
    _timer = Timer.periodic(const Duration(seconds: 4), (_) => _poll());
  }

  @override
  void didUpdateWidget(covariant FastCatAssistancePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.client != widget.client) {
      _active?.cancel();
      _state = null;
      _deviceId = null;
      _pendingResult = null;
      _poll();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _active?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground) _poll();
  }

  Future<void> _poll() async {
    if (!_foreground ||
        _polling ||
        !widget.client.hasSession ||
        (widget.client.diagnosticHandlers.isEmpty &&
            widget.client.repairs.capabilities.isEmpty)) return;
    _polling = true;
    final client = widget.client;
    client.repairs.english = widget.english;
    try {
      final device = await client.diagnosticDeviceId();
      List<FastCatRouteOption> options = [];
      if (client.repairs.capabilities.contains('switch_route')) {
        try {
          options =
              await client.routeOptions!().timeout(const Duration(seconds: 2));
        } catch (_) {
          options = [];
        }
      }
      final seenRoutes = <String>{};
      options = options
          .where((o) =>
              RegExp(r'^[-\w]{1,80}$').hasMatch(o.id) &&
              o.label.trim().isNotEmpty &&
              o.label.length <= 100 &&
              !RegExp(r'https?:|[\r\n]', caseSensitive: false)
                  .hasMatch(o.label) &&
              seenRoutes.add(o.id))
          .take(3)
          .toList();
      final state = await client.assistance(action: 'register', data: {
        'deviceId': device,
        'capabilities': client.diagnosticHandlers.keys.toList(),
        'repairCapabilities': client.repairs.capabilities
            .where((c) => c != 'switch_route' || options.isNotEmpty)
            .toList(),
        'repairProtocol': 3,
        'consentProtocol': 1,
        'consentSessionId': client.consentSessionId,
        'routeOptions': options.take(3).map((o) => o.toJson()).toList()
      });
      if (!mounted || client != widget.client) return;
      if (_active != null) {
        final rows = state['requests'] as List? ?? [];
        final match = rows.where((r) => r['id'] == _active!.id);
        if (match.isEmpty ||
            !['pending', 'running'].contains(match.first['status']))
          _active!.cancel();
      }
      setState(() {
        _deviceId = device;
        _takeState(state);
      });
      try {
        await client.repairs.reconcile(state['repairs'] as List? ?? []);
      } catch (_) {
        if (mounted && client == widget.client)
          setState(() => _error = t('修复结果暂未同步，恢复连接后将重试。',
              'Repair results are not synchronized yet. They will be retried after reconnection.'));
      }
      if (mounted) unawaited(_processAuthorized());
    } catch (_) {
      /* Background polling never replaces or blocks the chat. */
    } finally {
      _polling = false;
    }
  }

  Future<void> _act(Map row, String action, {String? grantId}) async {
    if (_deviceId == null) return;
    if (action == 'revoke') {
      if (_active?.id == row['id']) _active?.cancel();
      if (_pendingResult?['requestId'] == row['id']) _pendingResult = null;
    }
    final client = widget.client;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final state = await client.assistance(action: action, data: {
        'deviceId': _deviceId,
        'requestId': row['id'],
        if (grantId != null) 'grantId': grantId
      });
      if (!mounted || client != widget.client) return;
      setState(() => _takeState(state));
      if (action == 'accept') {
        final accepted =
            (state['requests'] as List).firstWhere((r) => r['id'] == row['id']);
        final request = FastCatDiagnosticRequest(
            id: row['id'],
            capability: row['capability'],
            expiresAt: DateTime.fromMillisecondsSinceEpoch(
                accepted['expires'] as int));
        _active = request;
        Map<String, dynamic>? report;
        String? failure;
        try {
          request.throwIfCancelled();
          final handler = client.diagnosticHandlers[request.capability];
          if (handler == null)
            throw StateError('Host diagnostic capability is unavailable');
          report = await handler(request).timeout(const Duration(seconds: 90));
          request.throwIfCancelled();
        } catch (e) {
          failure = t('诊断未完成，请重新请求。',
              'Diagnostics did not complete. Please request again.');
        }
        if (!mounted || client != widget.client || request.isCancelled) return;
        _pendingResult = {
          'deviceId': _deviceId,
          'requestId': request.id,
          if (failure != null) 'error': failure,
          if (report != null && failure == null) 'report': report
        };
        await _submitResult(client);
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _repairAction(Map row, bool accept, {String? grantId}) async {
    if (_deviceId == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final client = widget.client;
    try {
      if (accept)
        await client.repairs.confirm(row, grantId: grantId);
      else
        await client.assistance(
            action: 'repair_decline',
            data: {'deviceId': _deviceId, 'requestId': row['id']});
      if (mounted && client == widget.client) await _poll();
    } catch (e) {
      if (mounted && client == widget.client)
        setState(() => _error = e.toString());
    } finally {
      if (mounted && client == widget.client) setState(() => _busy = false);
    }
  }

  Future<void> _submitResult(FastCatClient client) async {
    final payload = _pendingResult;
    if (payload == null) return;
    final updated = await client.assistance(action: 'result', data: payload);
    if (!mounted || client != widget.client) return;
    _active = null;
    setState(() => _takeState(updated));
    if (payload['error'] == null)
      await client.sendText(
          t('诊断报告已提交，请根据报告继续排查。',
              'The diagnostic report has been submitted. Please continue troubleshooting.'),
          clientId: 'diagnostic_${payload['requestId']}');
    if (mounted)
      setState(() {
        _pendingResult = null;
        _error = null;
      });
  }

  Future<void> _retryResult() async {
    setState(() => _busy = true);
    try {
      await _submitResult(widget.client);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_scoped) return _compactPanel();
    final rows = (_state?['requests'] as List? ?? [])
        .where((r) => ['pending', 'running'].contains(r['status']))
        .toList();
    final repairs = (_state?['repairs'] as List? ?? [])
        .where((r) => ['pending', 'running', 'unknown'].contains(r['status']))
        .toList();
    if (rows.isEmpty &&
        repairs.isEmpty &&
        _error == null &&
        (!_scoped || (_grant('query') == null && _grant('operation') == null)))
      return const SizedBox.shrink();
    return ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 220),
        child: SingleChildScrollView(
            child: Container(
                margin: const EdgeInsets.all(8),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.surface,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: Theme.of(context).dividerColor)),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(t('诊断与修复', 'Diagnostics and repairs'),
                          style: const TextStyle(fontWeight: FontWeight.bold)),
                      if (_error != null)
                        Text(supportError(_error!, widget.english),
                            style: TextStyle(
                                color: Theme.of(context).colorScheme.error)),
                      if (_pendingResult != null && _error != null)
                        TextButton(
                            onPressed: _busy ? null : _retryResult,
                            child: Text(t('重新提交报告', 'Retry report upload'))),
                      if (_scoped) ...[
                        _consentCard('query'),
                        _consentCard('operation')
                      ],
                      for (final row in repairs) ...[
                        Text('${widget.english ? {
                            'reconnect': 'Reconnect',
                            'restart_core': 'Restart core',
                            'reapply_proxy': 'Reapply proxy',
                            'restore_settings': 'Restore previous settings',
                            'switch_route': 'Switch route and verify'
                          }[row['operation']] : row['label']} · ${row['reason']}'),
                        if (row['target_route_label'] != null)
                          Text(
                              '${t('目标线路', 'Target route')}: ${row['target_route_label']}'),
                        Text(
                            widget.english
                                ? (row['operation'] == 'switch_route'
                                    ? 'Temporarily switch to this route, verify connectivity, then restore the original route. The new route will not be kept automatically.'
                                    : 'This action may temporarily interrupt connectivity. The host must verify the outcome and roll back safely when required.')
                                : '${row['impact']}',
                            style: const TextStyle(fontSize: 12)),
                        if (!_scoped)
                          Text(
                              t('仅授权本次操作，可能短暂断网。设置快照与回滚由客户端在本地完成；结果不明时不会自动重试。',
                                  'This operation only. Connectivity may pause. The host handles local snapshots and rollback; unknown outcomes are never retried automatically.'),
                              style: const TextStyle(fontSize: 12)),
                        if (row['status'] == 'pending' && !_scoped)
                          Wrap(spacing: 8, children: [
                            TextButton(
                                onPressed: _busy
                                    ? null
                                    : () => _repairAction(row, false),
                                child: Text(t('拒绝', 'Decline'))),
                            FilledButton(
                                onPressed: _busy || widget.client.repairs.busy
                                    ? null
                                    : () => _repairAction(row, true),
                                child: Text(t('确认修复', 'Confirm repair'))),
                          ])
                        else
                          Text(row['status'] == 'pending'
                              ? t('等待操作授权或排队执行',
                                  'Awaiting operation permission or execution')
                              : row['status'] == 'unknown'
                                  ? t('结果待确认，请保持客户端运行，恢复连接后会补报。',
                                      'Outcome pending. Keep the app running; results will be reported after reconnection.')
                                  : t('正在修复及复查，请勿重复操作。',
                                      'Repair and verification in progress. Do not repeat.')),
                      ],
                      for (final row in rows) ...[
                        Text('${row['reason']}'),
                        Text(
                            '${t('采集范围', 'Scope')}: ${capabilityLabel(row['capability'])}'),
                        if (!_scoped)
                          Text(
                              t('仅本次诊断；结果供本次会话的 AI 和人工客服查看，最多保留 7 天。不包含修改设置授权。',
                                  'This diagnostic only. Results are shared with this conversation’s AI and staff for up to 7 days. No permission to change settings.'),
                              style: const TextStyle(fontSize: 12)),
                        if (_scoped)
                          Text(row['status'] == 'pending'
                              ? t('等待查询授权或排队采集',
                                  'Awaiting query permission or collection')
                              : t('正在采集，可在上方撤回查询授权',
                                  'Collecting. You can revoke information access above.'))
                        else
                          Wrap(
                              spacing: 8,
                              children: row['status'] == 'pending'
                                  ? [
                                      TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () => _act(row, 'decline'),
                                          child: Text(t('拒绝', 'Decline'))),
                                      FilledButton(
                                          onPressed: _busy
                                              ? null
                                              : () => _act(row, 'accept'),
                                          child: Text(
                                              t('同意并诊断', 'Allow diagnostics'))),
                                    ]
                                  : [
                                      TextButton(
                                          onPressed: () => _act(row, 'revoke'),
                                          child: Text(
                                              t('撤回授权', 'Revoke permission'))),
                                      if (_busy)
                                        const SizedBox(
                                            width: 16,
                                            height: 16,
                                            child: CircularProgressIndicator(
                                                strokeWidth: 2))
                                    ]),
                      ]
                    ]))));
  }
}

/// A compact activity inside the scrollable conversation; long reasons are opt-in.
class FastCatAssistanceActivity extends StatelessWidget {
  final Map activity;
  final bool english;
  const FastCatAssistanceActivity(
      {super.key, required this.activity, this.english = false});
  @override
  Widget build(BuildContext context) {
    String t(String zh, String en) => english ? en : zh;
    final repair = activity['operation'] != null, status = activity['status'];
    final labels = {
      'basic': t('基础信息', 'App information'),
      'status': t('状态诊断', 'Status diagnostics'),
      'network': t('网络诊断', 'Network diagnostics'),
      'logs': t('诊断日志', 'Diagnostic logs'),
      'routes': t('线路对比', 'Route comparison'),
      'reconnect': t('重新连接', 'Reconnect'),
      'restart_core': t('重启内核', 'Restart core'),
      'reapply_proxy': t('重新应用代理', 'Reapply proxy'),
      'restore_settings': t('恢复原设置', 'Restore settings'),
      'switch_route': t('线路切换验证', 'Route test')
    };
    final name = labels[activity[repair ? 'operation' : 'capability']] ??
        t('协助任务', 'Assistance');
    final statuses = {
      'pending': t('等待处理', 'Queued'),
      'running': t('处理中…', 'In progress…'),
      'unknown': t('结果待确认，请勿重复操作', 'Outcome pending. Do not repeat.'),
      'succeeded': t('已完成', 'Completed'),
      'failed': t('未完成', 'Failed'),
      'rolled_back': t('已恢复设置', 'Settings restored'),
      'not_started': t('未执行', 'Not started'),
      'expired': t('已过期', 'Expired'),
      'revoked': t('已撤回', 'Revoked'),
      'declined': t('已拒绝', 'Declined')
    };
    final result = activity['result'] as Map?;
    final details = [
      activity['reason'],
      if (activity['target_route_label'] != null)
        '${t('目标线路', 'Target')}: ${activity['target_route_label']}',
      result?['summary'],
      activity['error'],
      if (repair && result != null)
        '${t('复查', 'Verification')}: ${result['verified'] == true ? t('通过', 'Passed') : t('未通过或待确认', 'Not confirmed')}',
      if (activity['operation'] == 'switch_route' && result != null)
        '${t('原线路', 'Original route')}: ${result['originalRouteRestored'] == true ? t('已恢复', 'Restored') : t('待确认', 'Unconfirmed')}'
    ].where((v) => v != null && v.toString().isNotEmpty).join('\n');
    return Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Theme(
            data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
            child: ExpansionTile(
              tilePadding: const EdgeInsets.symmetric(horizontal: 8),
              childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
              dense: true,
              leading: status == 'running'
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : Icon(
                      status == 'succeeded'
                          ? Icons.check_circle_outline
                          : status == 'unknown'
                              ? Icons.schedule
                              : status == 'failed'
                                  ? Icons.error_outline
                                  : Icons.info_outline,
                      size: 17,
                      color: status == 'failed'
                          ? Theme.of(context).colorScheme.error
                          : Theme.of(context).colorScheme.primary),
              title: Text('$name · ${statuses[status] ?? status}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12)),
              children: [
                Align(
                    alignment: Alignment.centerLeft,
                    child: Text(details, style: const TextStyle(fontSize: 12)))
              ],
            )));
  }
}
