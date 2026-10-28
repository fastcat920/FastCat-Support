import 'appearance.dart';
import 'strings.dart';
import 'message_body.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'client.dart';

class FastCatAttachment {
  final String filename;
  final Uint8List bytes;
  FastCatAttachment({required this.filename, required this.bytes});
}

/// Mount after start/restore. The host owns the client and session lifetime.
class FastCatChat extends StatefulWidget {
  final FastCatClient client;
  final bool showHeader;
  final String? title;
  final Locale? locale;
  final ValueChanged<Uri>? onOpenLink;
  final Future<FastCatAttachment?> Function()? pickAttachment;
  final Future<void> Function(String filename, Uint8List bytes)? onAttachment;
  const FastCatChat(
      {super.key,
      required this.client,
      this.showHeader = true,
      this.title,
      this.locale,
      this.onOpenLink,
      this.pickAttachment,
      this.onAttachment});
  @override
  State<FastCatChat> createState() => _FastCatChatState();
}

class _FastCatChatState extends State<FastCatChat> with WidgetsBindingObserver {
  final _text = TextEditingController();
  final _messages = <Map<String, dynamic>>[];
  StreamSubscription<Map<String, dynamic>>? _subscription;
  String? _error, _pendingId, _pendingBody;
  String _aiDraft = "";
  bool _typing = false;
  Color _primary = defaultSupportColor;
  String? _configuredTitle, _logoUrl, _themeMode, _language;
  int _appearanceRevision = 0;
  void _loadAppearance() {
    final revision = ++_appearanceRevision;
    widget.client.configuration().then((config) {
      if (mounted && revision == _appearanceRevision)
        setState(() {
          _primary = supportColor(config);
          final appearance = config['widget'] as Map? ?? const {};
          _configuredTitle = config['title'] as String?;
          _logoUrl = appearance['logoUrl'] as String?;
          _themeMode = appearance['theme'] as String?;
          _language = appearance['language'] as String?;
        });
    }).catchError((Object _) {});
  }

  StreamSubscription<FastCatConnectionStatus>? _connectionSubscription;
  FastCatConnectionStatus _connection = FastCatConnectionStatus.idle;
  bool _sending = false, _closed = false;
  int _lastSeq = 0, _ackSeq = 0, _peerReadSeq = 0;
  FastCatAttachment? _pendingFile;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadAppearance();
    _subscribe();
  }

  void _subscribe() {
    _connection = widget.client.connectionStatus;
    _connectionSubscription =
        widget.client.connectionStatusStream.listen((state) {
      if (mounted) setState(() => _connection = state);
    });
    _subscription = widget.client.watch(onError: (e) {
      if (mounted) setState(() => _error = e.toString());
    }).listen((page) {
      if (!mounted) return;
      setState(() {
        if (_pendingId == null) _error = null;
        _closed = (page['conversation'] as Map?)?['status'] == 'closed';
        _peerReadSeq =
            (page['receipts'] as Map?)?['readSeq'] as int? ?? _peerReadSeq;
        final automation = page['automation'] as Map?;
        _typing = automation?['typing'] == true;
        _aiDraft = automation?['draft'] as String? ?? '';
        for (final value in page['messages'] as List) {
          final message = Map<String, dynamic>.from(value as Map);
          if (!_messages.any((m) => m['id'] == message['id']))
            _messages.add(message);
        }
        _lastSeq = page['nextCursor'] as int? ?? _lastSeq;
      });
      _ack();
    }, onError: (Object e) {
      if (mounted) setState(() => _error = e.toString());
    });
  }

  void _ack() {
    if (WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed &&
        WidgetsBinding.instance.lifecycleState != null) return;
    if (ModalRoute.of(context)?.isCurrent == false) return;
    if (_lastSeq <= _ackSeq) return;
    final target = _lastSeq;
    widget.client
        .acknowledge(deliveredSeq: _lastSeq, readSeq: _lastSeq)
        .then((value) {
      if (mounted) _ackSeq = target;
      return value;
    }).catchError((Object e) => <String, dynamic>{});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _ack();
  }

  @override
  void didUpdateWidget(covariant FastCatChat old) {
    super.didUpdateWidget(old);
    if (old.client != widget.client) {
      _primary = defaultSupportColor;
      _configuredTitle = _logoUrl = _themeMode = _language = null;
      _peerReadSeq = 0;
      _loadAppearance();
      _subscription?.cancel();
      _connectionSubscription?.cancel();
      _typing = false;
      _aiDraft = "";
      _messages.clear();
      _lastSeq = 0;
      _ackSeq = 0;
      _pendingFile = null;
      _pendingId = null;
      _pendingBody = null;
      _subscribe();
    }
  }

  Locale? get _locale =>
      widget.locale ??
      (_language == 'en'
          ? const Locale('en')
          : _language == 'zh-CN'
              ? const Locale('zh', 'CN')
              : null);
  String _t(String zh, String en) => supportText(context, zh, en, _locale);
  Widget _logo() {
    final value = _logoUrl ?? '';
    if (value.startsWith('https://'))
      return Image.network(value,
          width: 36,
          height: 36,
          fit: BoxFit.contain,
          errorBuilder: (_, __, ___) => const SizedBox.shrink());
    final match =
        RegExp(r'^data:image/(?:png|jpeg|webp);base64,(.+)$').firstMatch(value);
    if (match != null) {
      try {
        return Image.memory(base64Decode(match.group(1)!),
            width: 36,
            height: 36,
            fit: BoxFit.contain,
            errorBuilder: (_, __, ___) => const SizedBox.shrink());
      } catch (_) {}
    }
    return const SizedBox.shrink();
  }

  ThemeData _effectiveTheme(BuildContext context) {
    final host = Theme.of(context);
    final base = _themeMode == 'dark'
        ? ThemeData.dark()
        : _themeMode == 'light'
            ? ThemeData.light()
            : host;
    return supportTheme(base, _primary);
  }

  Future<void> _send() async {
    if (_sending) return;
    final body = _pendingBody ?? _text.text.trim();
    if (body.isEmpty && _pendingFile == null) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    _pendingId ??= FastCatClient.newClientId();
    _pendingBody = body;
    try {
      final file = _pendingFile;
      if (file != null) {
        await widget.client.sendAttachment(file.bytes,
            filename: file.filename, clientId: _pendingId!);
      } else {
        await widget.client.sendText(body, clientId: _pendingId!);
      }
      if (!mounted) return;
      if (file == null) _text.clear();
      _pendingFile = null;
      _pendingBody = null;
      _pendingId = null;
    } catch (e) {
      if (mounted)
        setState(() =>
            _error = '${_t('发送未完成，请重试', 'Send failed, please retry')}: $e');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _subscription?.cancel();
    _connectionSubscription?.cancel();
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Theme(
      data: _effectiveTheme(context),
      child: Scaffold(
          appBar: widget.showHeader
              ? AppBar(
                  backgroundColor: _primary,
                  foregroundColor: _primary.computeLuminance() > 0.179
                      ? Colors.black
                      : Colors.white,
                  title: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(widget.title ??
                            (_configuredTitle?.isNotEmpty == true
                                ? _configuredTitle!
                                : _t('在线客服', 'Support'))),
                        Text(_t('客服服务', 'Customer service'),
                            style: const TextStyle(fontSize: 12)),
                      ]),
                  actions: [
                      _logo(),
                      TextButton(
                          onPressed: _closed
                              ? null
                              : () async {
                                  try {
                                    await widget.client.requestHuman();
                                  } catch (e) {
                                    if (mounted)
                                      setState(() => _error = e.toString());
                                  }
                                },
                          style: TextButton.styleFrom(
                              foregroundColor:
                                  _primary.computeLuminance() > 0.179
                                      ? Colors.black
                                      : Colors.white),
                          child: Text(_t('联系人工', 'Talk to a person')))
                    ])
              : null,
          backgroundColor:
              _effectiveTheme(context).brightness == Brightness.dark
                  ? const Color(0xff111216)
                  : const Color(0xfff5f6fa),
          body: SafeArea(
              child: Column(children: [
            if (!widget.showHeader)
              Align(
                  alignment: Alignment.centerRight,
                  child: TextButton(
                      onPressed: _closed
                          ? null
                          : () async {
                              try {
                                await widget.client.requestHuman();
                              } catch (e) {
                                if (mounted)
                                  setState(() => _error = e.toString());
                              }
                            },
                      child: Text(_t("联系人工", "Talk to a person")))),
            if (_connection == FastCatConnectionStatus.connecting ||
                _connection == FastCatConnectionStatus.reconnecting)
              Padding(
                  padding: const EdgeInsets.all(8),
                  child: Text(_connection == FastCatConnectionStatus.connecting
                      ? _t('正在连接客服…', 'Connecting to support…')
                      : _t('连接中断，正在重试…', 'Connection lost. Retrying…'))),
            Expanded(
                child: ListView.builder(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 16, vertical: 18),
                    itemCount: _messages.length + (_typing ? 1 : 0),
                    itemBuilder: (context, i) {
                      if (i == _messages.length)
                        return Semantics(
                            liveRegion: true,
                            label: _t("AI 正在回复", "AI is replying"),
                            child: Card(
                                child: Padding(
                                    padding: const EdgeInsets.all(12),
                                    child: Text(_aiDraft.isEmpty
                                        ? _t("正在思考…", "Thinking…")
                                        : _aiDraft))));
                      final m = _messages[i];
                      final sentAt =
                          DateTime.tryParse(m['created'] as String? ?? '')
                              ?.toLocal();
                      final time = sentAt == null
                          ? ''
                          : '${sentAt.hour.toString().padLeft(2, '0')}:${sentAt.minute.toString().padLeft(2, '0')}';
                      final own = m['role'] == 'visitor';
                      final read =
                          m['seq'] is int && (m['seq'] as int) <= _peerReadSeq;
                      return Align(
                          alignment: m['role'] == 'visitor'
                              ? Alignment.centerRight
                              : Alignment.centerLeft,
                          child: ConstrainedBox(
                              constraints: BoxConstraints(
                                  maxWidth:
                                      MediaQuery.sizeOf(context).width * 0.88),
                              child: Column(
                                  crossAxisAlignment: own
                                      ? CrossAxisAlignment.end
                                      : CrossAxisAlignment.start,
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Card(
                                        color: own
                                            ? _primary
                                            : Theme.of(context)
                                                .colorScheme
                                                .surface,
                                        shape: RoundedRectangleBorder(
                                            borderRadius:
                                                BorderRadius.circular(14)),
                                        child: DefaultTextStyle.merge(
                                            style: TextStyle(
                                                color: own
                                                    ? (_primary.computeLuminance() > 0.179
                                                        ? Colors.black
                                                        : Colors.white)
                                                    : Theme.of(context)
                                                        .colorScheme
                                                        .onSurface),
                                            child: Padding(
                                                padding:
                                                    const EdgeInsets.all(12),
                                                child: m['attachment'] != null
                                                    ? TextButton(
                                                        onPressed:
                                                            widget.onAttachment ==
                                                                    null
                                                                ? null
                                                                : () async {
                                                                    try {
                                                                      final a =
                                                                          m['attachment']
                                                                              as Map;
                                                                      final bytes = await widget
                                                                          .client
                                                                          .downloadAttachment(a['id']
                                                                              as String);
                                                                      await widget
                                                                              .onAttachment!(
                                                                          a['filename']
                                                                              as String,
                                                                          bytes);
                                                                    } catch (e) {
                                                                      if (mounted)
                                                                        setState(() =>
                                                                            _error =
                                                                                e.toString());
                                                                    }
                                                                  },
                                                        child: Text(
                                                            '${_t('附件', 'Attachment')}: ${(m['attachment'] as Map)['filename']}'))
                                                    : FastCatMessageBody(
                                                        body:
                                                            m['body'] as String? ??
                                                                '',
                                                        plain: m['role'] ==
                                                            'visitor',
                                                        locale: _locale,
                                                        onOpenLink:
                                                            widget.onOpenLink,
                                                        onMessage: (value) =>
                                                            setState(() =>
                                                                _text.text = value))))),
                                    if (time.isNotEmpty)
                                      Padding(
                                          padding: const EdgeInsets.symmetric(
                                              horizontal: 8),
                                          child: Row(
                                              mainAxisSize: MainAxisSize.min,
                                              children: [
                                                Text(time,
                                                    style: Theme.of(context)
                                                        .textTheme
                                                        .bodySmall),
                                                if (own)
                                                  Semantics(
                                                      label: read
                                                          ? _t("已读", "Read")
                                                          : _t("已发送", "Sent"),
                                                      child: Text(
                                                          read ? "  ✓✓" : "  ✓",
                                                          style: TextStyle(
                                                              color: read
                                                                  ? _primary
                                                                  : Theme.of(
                                                                          context)
                                                                      .colorScheme
                                                                      .onSurfaceVariant)))
                                              ]))
                                  ])));
                    })),
            if (_error != null)
              Padding(
                  padding: const EdgeInsets.all(8),
                  child: Text(_error!,
                      style: TextStyle(
                          color: Theme.of(context).colorScheme.error))),
            if (_closed)
              Text(_t('会话已结束，发送消息即可继续咨询。',
                  'Conversation closed. Send a message to continue.')),
            Container(
                margin: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                padding: const EdgeInsets.fromLTRB(14, 8, 10, 8),
                decoration: BoxDecoration(
                  color: _effectiveTheme(context).colorScheme.surface,
                  border:
                      Border.all(color: _effectiveTheme(context).dividerColor),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextField(
                          controller: _text,
                          readOnly: _sending || _pendingBody != null,
                          maxLength: 10000,
                          minLines: 2,
                          maxLines: 4,
                          decoration: InputDecoration(
                              hintText: _t('输入你想咨询的问题…', 'Type your question…'),
                              border: InputBorder.none,
                              counterText: '')),
                      Row(children: [
                        if (widget.pickAttachment != null)
                          IconButton(
                              tooltip: _t('发送附件', 'Send attachment'),
                              onPressed: _sending || _pendingId != null
                                  ? null
                                  : () async {
                                      try {
                                        final file =
                                            await widget.pickAttachment!();
                                        if (!mounted || file == null) return;
                                        _pendingFile = file;
                                        await _send();
                                      } catch (e) {
                                        if (mounted)
                                          setState(() => _error = e.toString());
                                      }
                                    },
                              icon: const Icon(Icons.attach_file)),
                        const Spacer(),
                        Tooltip(
                            message: _pendingId != null
                                ? _t('重试发送', 'Retry send')
                                : _t('发送', 'Send'),
                            child: FilledButton(
                                style: FilledButton.styleFrom(
                                    backgroundColor: _primary,
                                    foregroundColor:
                                        _primary.computeLuminance() > 0.179
                                            ? Colors.black
                                            : Colors.white),
                                onPressed: _sending ? null : _send,
                                child: Text(_pendingId != null
                                    ? _t('重试', 'Retry')
                                    : _t('发送 ↗', 'Send ↗'))))
                      ])
                    ]))
          ]))));
}
