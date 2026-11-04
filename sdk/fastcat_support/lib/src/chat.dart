import 'package:flutter/rendering.dart' show ScrollDirection;
import 'assistance.dart';
import 'package:flutter/services.dart';
import 'web_icons.dart';
import 'notification_sound.dart';
import 'appearance.dart';
import 'strings.dart';
import 'message_body.dart';
import 'dart:async';
import 'dart:convert';
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
  final _tone = SupportNotificationSound();
  final _emojiKey = GlobalKey();
  final _composerKey = GlobalKey();
  final _inputFocus = FocusNode();
  bool _emojiOpen = false;
  final _text = TextEditingController();
  final _scroll = ScrollController();
  final _messages = <Map<String, dynamic>>[];
  DateTime _assistanceOpenedAt = DateTime.now();
  void _observeAssistance(Map<String, dynamic> state) {
    if (!mounted) return;
    bool changed = false;
    for (final row in [
      ...(state['requests'] as List? ?? []),
      ...(state['repairs'] as List? ?? [])
    ]) {
      final id = 'assistance:${row['id']}';
      final index = _messages.indexWhere((m) => m['id'] == id);
      if (index < 0 &&
          (row['status'] == 'pending' ||
              (row['created'] as int? ?? 0) <
                      _assistanceOpenedAt.millisecondsSinceEpoch &&
                  !['running', 'unknown'].contains(row['status']))) continue;
      if (index >= 0 &&
          jsonEncode(_messages[index]['activity']) == jsonEncode(row)) continue;
      final message = <String, dynamic>{
        'id': id,
        'source': 'assistance',
        'role': 'system',
        'activity': Map<String, dynamic>.from(row),
        'created': DateTime.fromMillisecondsSinceEpoch(
                row['created'] as int? ?? DateTime.now().millisecondsSinceEpoch)
            .toUtc()
            .toIso8601String()
      };
      if (index < 0)
        _messages.add(message);
      else
        _messages[index] = message;
      changed = true;
    }
    if (changed) setState(() {});
  }

  StreamSubscription<Map<String, dynamic>>? _subscription;
  Timer? _pushHeartbeat;
  void _pushPresence() {
    unawaited(widget.client
        .setPushChatVisible(WidgetsBinding.instance.lifecycleState == null ||
            WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed)
        .catchError((Object _) {}));
  }

  String? _error, _pendingId, _pendingBody;
  String _aiDraft = "", _aiAvatar = "";
  bool _openingScrollPending = true, _userNavigated = false;
  bool _typing = false;
  bool _statusReady = false, _assigned = false;
  String _serviceMode = '';
  String get _serviceLabel => !_statusReady
      ? ''
      : _closed
          ? _t('会话已结束', 'Conversation ended')
          : _serviceMode == 'ai'
              ? _t('AI 助手接待中', 'AI assistant connected')
              : _assigned
                  ? _t('人工客服接待中', 'Staff connected')
                  : _t('等待客服接待', 'Waiting for support');
  Color _primary = defaultSupportColor;
  String? _themeMode, _language, _welcomeZh, _welcomeEn;
  bool _showHandoff = true, _sound = true;
  final _avatarBytes = <String, Uint8List>{};
  bool _scrollAfterSend = false;
  final _attachmentPreviews = <String, Uint8List>{};
  final _attachmentCache = <String, Future<Uint8List>>{};
  int _appearanceRevision = 0;
  bool _appearanceReady = false;
  String? _appearanceError;
  void _loadAppearance() {
    final revision = ++_appearanceRevision;
    void apply(Map<String, dynamic> config) {
      final firstPaint = !_appearanceReady;
      _primary = supportColor(config);
      final appearance = config['widget'] as Map? ?? const {};
      _themeMode = appearance['theme'] as String?;
      _language = appearance['language'] as String?;
      _showHandoff = appearance['showHandoffButton'] != false;
      _welcomeZh = appearance['welcomeMessageZh'] as String? ??
          appearance['welcomeMessage'] as String?;
      _welcomeEn = appearance['welcomeMessageEn'] as String?;
      _appearanceReady = true;
      _appearanceError = null;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          if (firstPaint) _showLatest();
          _ack();
        }
      });
    }

    final cached = widget.client.cachedConfiguration;
    if (cached != null) apply(cached);
    unawaited(widget.client.loadCachedConfiguration().then((config) {
      if (mounted &&
          revision == _appearanceRevision &&
          !_appearanceReady &&
          config != null) setState(() => apply(config));
    }));
    widget.client.configuration().then((config) {
      if (mounted && revision == _appearanceRevision)
        setState(() => apply(config));
    }).catchError((Object _) {
      if (mounted && revision == _appearanceRevision && !_appearanceReady)
        setState(() => _appearanceError =
            _t('配置加载失败，点击重试', 'Unable to load. Tap to retry'));
    });
  }

  StreamSubscription<Map<String, dynamic>>? _soundSubscription;
  StreamSubscription<FastCatConnectionStatus>? _connectionSubscription;
  FastCatConnectionStatus _connection = FastCatConnectionStatus.idle;
  bool _sending = false, _closed = false;
  int _lastSeq = 0, _ackSeq = 0, _peerReadSeq = 0;
  FastCatAttachment? _pendingFile;
  @override
  void initState() {
    super.initState();
    _text.addListener(_onTextChanged);
    _inputFocus.addListener(_onTextChanged);
    _inputFocus.onKeyEvent = (node, event) {
      final enter = event.logicalKey == LogicalKeyboardKey.enter ||
          event.logicalKey == LogicalKeyboardKey.numpadEnter;
      if (!enter || !_text.value.composing.isCollapsed)
        return KeyEventResult.ignored;
      if (event is KeyDownEvent) {
        if (HardwareKeyboard.instance.isShiftPressed) {
          final value = _text.value;
          final selection = value.selection.isValid
              ? value.selection
              : TextSelection.collapsed(offset: value.text.length);
          final text =
              value.text.replaceRange(selection.start, selection.end, '\n');
          if (text.length <= 10000)
            _text.value = TextEditingValue(
                text: text,
                selection:
                    TextSelection.collapsed(offset: selection.start + 1));
        } else {
          unawaited(_send());
        }
      }
      return KeyEventResult.handled;
    };
    WidgetsBinding.instance.addObserver(this);
    _loadAppearance();
    _scroll.addListener(_ack);
    _subscribe();
    _pushPresence();
    _pushHeartbeat =
        Timer.periodic(const Duration(seconds: 30), (_) => _pushPresence());
  }

  void _onTextChanged() {
    if (mounted) setState(() {});
  }

  void _toggleSound() {
    setState(() => _sound = !_sound);
    if (_sound) _tone.play();
  }

  String _dateLabel(String date) {
    final value = DateTime.tryParse(date);
    if (value == null) return date;
    return _t('${value.year}年${value.month}月${value.day}日',
        '${value.month}/${value.day}/${value.year}');
  }

  void _subscribe() {
    _soundSubscription?.cancel();
    _soundSubscription = widget.client.incomingMessageStream.listen((message) {
      if (mounted &&
          _sound &&
          WidgetsBinding.instance.lifecycleState != AppLifecycleState.paused)
        _tone.play();
    });
    _connection = widget.client.connectionStatus;
    _connectionSubscription =
        widget.client.connectionStatusStream.listen((state) {
      if (mounted) setState(() => _connection = state);
    });
    _subscription = widget.client.watch(onError: (e) {
      if (mounted) setState(() => _error = e.toString());
    }).listen((page) {
      if (!mounted) return;
      var incoming = false;
      final previousDraft = _aiDraft;
      final wasTyping = _typing;
      setState(() {
        if (_pendingId == null) _error = null;
        _closed = (page['conversation'] as Map?)?['status'] == 'closed';
        _peerReadSeq =
            (page['receipts'] as Map?)?['readSeq'] as int? ?? _peerReadSeq;
        final automation = page['automation'] as Map?;
        _statusReady = true;
        _serviceMode = automation?['mode'] as String? ?? '';
        _assigned = (page['conversation'] as Map?)?['assigned'] == true;
        _typing = automation?['typing'] == true;
        _aiDraft = automation?['draft'] as String? ?? '';
        _aiAvatar = automation?['aiAvatar'] as String? ?? _aiAvatar;
        for (final value in page['messages'] as List) {
          final message = Map<String, dynamic>.from(value as Map);
          final index = _messages.indexWhere((m) =>
              m['id'] == message['id'] ||
              (message['client_id'] != null &&
                  m['client_id'] == message['client_id']));
          final attachmentId =
              (message['attachment'] as Map?)?['id'] as String?;
          final localBytes = index >= 0
              ? _messages[index]['localBytes'] as Uint8List?
              : (message['client_id'] == _pendingId
                  ? _pendingFile?.bytes
                  : null);
          if (attachmentId != null && localBytes != null) {
            _attachmentPreviews[attachmentId] = localBytes;
            _attachmentCache[attachmentId] = Future.value(localBytes);
          }
          if (index < 0) {
            if (message['role'] != 'visitor') incoming = true;
            _messages.add(message);
          } else {
            _messages[index] = message;
          }
          if (message['client_id'] != null &&
              message['client_id'] == _pendingId) {
            _pendingId = null;
            _pendingBody = null;
            _pendingFile = null;
          }
        }
        _lastSeq = page['nextCursor'] as int? ?? _lastSeq;
      });
      final shouldShowLatest = incoming ||
          (_typing && (!wasTyping || previousDraft != _aiDraft)) ||
          _scrollAfterSend ||
          (_openingScrollPending && page['hasMore'] != true);
      if (page['hasMore'] != true) _openingScrollPending = false;
      _scrollAfterSend = false;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        if (shouldShowLatest && _scroll.hasClients)
          _scroll.jumpTo(_scroll.position.maxScrollExtent);
        _ack();
      });
    }, onError: (Object e) {
      if (mounted) setState(() => _error = e.toString());
    });
  }

  void _ack() {
    if (!_appearanceReady) return;
    if (_scroll.hasClients &&
        _scroll.position.hasContentDimensions &&
        _scroll.position.maxScrollExtent - _scroll.offset > 90) return;
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
    _pushPresence();
  }

  @override
  void didUpdateWidget(covariant FastCatChat old) {
    super.didUpdateWidget(old);
    if (old.client != widget.client) {
      unawaited(old.client.setPushChatVisible(false).catchError((Object _) {}));
      _pushPresence();
      _statusReady = false;
      _openingScrollPending = true;
      _userNavigated = false;
      _aiAvatar = "";
      _appearanceReady = false;
      _appearanceError = null;
      _primary = defaultSupportColor;
      _themeMode = _language = _welcomeZh = _welcomeEn = null;
      _peerReadSeq = 0;
      _loadAppearance();
      _subscription?.cancel();
      _connectionSubscription?.cancel();
      _typing = false;
      _aiDraft = "";
      _messages.clear();
      _assistanceOpenedAt = DateTime.now();
      _attachmentPreviews.clear();
      _attachmentCache.clear();
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
  ThemeData _effectiveTheme(BuildContext context) {
    final host = Theme.of(context);
    final base = _themeMode == 'dark'
        ? ThemeData.dark()
        : _themeMode == 'light'
            ? ThemeData.light()
            : host;
    final dark = base.brightness == Brightness.dark;
    return supportTheme(
        base.copyWith(
            colorScheme: base.colorScheme.copyWith(
                surface: dark ? const Color(0xff191a20) : Colors.white),
            dividerColor:
                dark ? const Color(0xff2b2d37) : const Color(0xffe9ecf2)),
        _primary);
  }

  void _showLatest() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted &&
          !_userNavigated &&
          _scroll.hasClients &&
          _scroll.position.hasContentDimensions)
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  Future<void> _send() async {
    if (_sending) return;
    final body = _pendingBody ?? _text.text.trim();
    if (body.isEmpty && _pendingFile == null) return;
    _inputFocus.unfocus();
    _scrollAfterSend = true;
    _userNavigated = false;
    _showLatest();
    setState(() {
      _sending = true;
      _error = null;
    });
    _pendingId ??= FastCatClient.newClientId();
    _pendingBody = body;
    _text.clear();
    final clientId = _pendingId!;
    final file = _pendingFile;
    try {
      Map<String, dynamic> result;
      if (file != null) {
        result = await widget.client.sendAttachment(file.bytes,
            filename: file.filename, clientId: clientId);
      } else {
        result = await widget.client.sendText(body, clientId: clientId);
      }
      if (!mounted) return;
      if (!_messages.any((m) =>
          m['id'] == result['id'] && result['id'] != null ||
          m['client_id'] == clientId)) {
        _messages.add({
          'id': result['id'] ?? clientId,
          'client_id': clientId,
          'role': 'visitor',
          'body': file?.filename ?? body,
          'created': DateTime.now().toUtc().toIso8601String(),
          if (file != null &&
              RegExp(r'\.(png|jpg|jpeg|gif|webp)$', caseSensitive: false)
                  .hasMatch(file.filename))
            'localBytes': file.bytes
        });
      }

      _pendingFile = null;
      _pendingBody = null;
      _pendingId = null;
    } catch (e) {
      if (mounted && !_messages.any((m) => m['client_id'] == clientId))
        setState(() => _error = e.toString());
    } finally {
      if (mounted) {
        setState(() => _sending = false);
        _scrollAfterSend = false;
        _showLatest();
      }
    }
  }

  Future<void> _openImage(Uint8List bytes) => showDialog<void>(
      context: context,
      builder: (context) => Dialog(
          backgroundColor: Colors.black87,
          insetPadding: const EdgeInsets.all(16),
          child: SizedBox(
              width: MediaQuery.sizeOf(context).width,
              height: MediaQuery.sizeOf(context).height * .8,
              child: Stack(fit: StackFit.expand, children: [
                InteractiveViewer(
                    maxScale: 5,
                    child: Image.memory(bytes, fit: BoxFit.contain)),
                Positioned(
                    right: 0,
                    top: 0,
                    child: IconButton(
                        onPressed: () => Navigator.pop(context),
                        icon: const Icon(Icons.close, color: Colors.white)))
              ]))));

  Widget _attachment(Map a) {
    final id = a['id'] as String;
    Future<Uint8List> bytes() => _attachmentCache.putIfAbsent(
        id, () => widget.client.downloadAttachment(id));
    return SizedBox(
        width: 220,
        child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if ((a['mime'] as String? ?? '').startsWith('image/'))
                FutureBuilder<Uint8List>(
                    future: bytes(),
                    initialData: _attachmentPreviews[id],
                    builder: (context, snapshot) => snapshot.hasData
                        ? ClipRRect(
                            borderRadius: BorderRadius.circular(10),
                            child: GestureDetector(
                                onTap: () => _openImage(snapshot.data!),
                                child: Image.memory(snapshot.data!,
                                    frameBuilder:
                                        (context, child, frame, sync) {
                                  // Media loading must not move the conversation.
                                  return child;
                                }, width: 200, fit: BoxFit.contain)))
                        : const SizedBox(
                            height: 80,
                            child: Center(child: CircularProgressIndicator()))),
              if (!(a['mime'] as String? ?? '').startsWith('image/'))
                TextButton(
                    onPressed: widget.onAttachment == null
                        ? null
                        : () async {
                            try {
                              await widget.onAttachment!(
                                  a['filename'] as String, await bytes());
                            } catch (e) {
                              if (mounted)
                                setState(() => _error = e.toString());
                            }
                          },
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      const Icon(Icons.insert_drive_file_outlined, size: 18),
                      const SizedBox(width: 8),
                      Flexible(
                          child: Text(a['filename'] as String,
                              maxLines: 1, overflow: TextOverflow.ellipsis))
                    ]))
            ]));
  }

  Widget _message(Map m) {
    final own = m['role'] == 'visitor', pending = m['pending'] == true;
    final isImage = m['localBytes'] != null ||
        (m['attachment'] as Map?)?['mime']?.toString().startsWith('image/') ==
            true;
    final name = m['source'] == 'ai'
        ? _t('AI 助手', 'AI assistant')
        : (m['source'] == 'system' || m['source'] == 'welcome')
            ? _t('系统', 'System')
            : (m['senderName'] as String? ?? _t('客服', 'Support'));
    final fg = own && !isImage
        ? (_primary.computeLuminance() > .179 ? Colors.black : Colors.white)
        : _effectiveTheme(context).colorScheme.onSurface;
    final created = DateTime.tryParse(m['created'] as String? ?? '')?.toLocal();
    final time = created == null
        ? ''
        : '${created.hour.toString().padLeft(2, '0')}:${created.minute.toString().padLeft(2, '0')}';
    final read = m['seq'] is int && m['seq'] <= _peerReadSeq;
    Widget avatar = CircleAvatar(
        radius: 14,
        backgroundColor: Color.alphaBlend(_primary.withValues(alpha: .12),
            _effectiveTheme(context).colorScheme.surface),
        child: Text(name.isEmpty ? '?' : name.substring(0, 1),
            style: TextStyle(fontSize: 12, color: _primary)));
    final image = (m['senderAvatar'] ?? m['avatar']) as String? ?? '';
    if (image.startsWith('data:image/')) {
      try {
        avatar = ClipOval(
            child: Image.memory(
                _avatarBytes.putIfAbsent(
                    image, () => base64Decode(image.split(',').last)),
                gaplessPlayback: true,
                width: 28,
                height: 28,
                fit: BoxFit.cover));
      } catch (_) {}
    }
    if (image.isNotEmpty && !image.startsWith('data:')) {
      final url = widget.client.baseUrl.resolve(image).toString();
      avatar = ClipOval(
          child: Image.network(url,
              width: 28, height: 28, fit: BoxFit.cover, gaplessPlayback: true));
    }
    final metadata = pending
        ? (_sending
            ? const SizedBox(
                width: 12,
                height: 12,
                child: CircularProgressIndicator(strokeWidth: 1.5))
            : IconButton(
                tooltip: _t('发送失败，点击重试', 'Failed, tap to retry'),
                constraints:
                    const BoxConstraints.tightFor(width: 20, height: 20),
                padding: EdgeInsets.zero,
                onPressed: _send,
                icon: const Icon(Icons.error, color: Colors.red, size: 18)))
        : Row(mainAxisSize: MainAxisSize.min, children: [
            Text(time,
                style:
                    TextStyle(fontSize: 10, color: fg.withValues(alpha: .65))),
            if (own)
              Semantics(
                  label: read ? _t('已读', 'Read') : _t('已发送', 'Sent'),
                  child: Padding(
                      padding: const EdgeInsets.only(left: 3, right: 4),
                      child: Text(read ? '  ✓✓' : '  ✓',
                          style: TextStyle(
                              fontSize: 11,
                              letterSpacing: read ? -1.5 : 0,
                              color: fg.withValues(alpha: .7)))))
          ]);
    return Padding(
        padding: const EdgeInsets.only(bottom: 20),
        child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment:
                own ? MainAxisAlignment.end : MainAxisAlignment.start,
            children: [
              if (!own)
                Padding(
                    padding: const EdgeInsets.only(top: 7, right: 8),
                    child: avatar),
              Flexible(
                  child: ConstrainedBox(
                      constraints: BoxConstraints(
                          maxWidth: isImage
                              ? 248
                              : (MediaQuery.sizeOf(context).width *
                                      (own ? .88 : .78))
                                  .clamp(0.0, 560.0)),
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (!own)
                              Padding(
                                  padding: const EdgeInsets.only(bottom: 5),
                                  child: Text(name,
                                      style: const TextStyle(
                                          fontSize: 12, color: Colors.grey))),
                            CustomPaint(
                                painter: isImage
                                    ? null
                                    : _BubbleTail(
                                        own: own,
                                        border: own
                                            ? null
                                            : _effectiveTheme(context)
                                                .dividerColor,
                                        color: own
                                            ? _primary
                                            : _effectiveTheme(context)
                                                .colorScheme
                                                .surface),
                                child: Container(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 14, vertical: 10),
                                    child: DefaultTextStyle.merge(
                                        style: TextStyle(
                                            fontSize: 14,
                                            height: 1.7,
                                            color: fg),
                                        child: Wrap(
                                            alignment: WrapAlignment.end,
                                            crossAxisAlignment:
                                                WrapCrossAlignment.end,
                                            spacing: 8,
                                            runSpacing: 4,
                                            children: [
                                              m['localBytes'] != null
                                                  ? Image.memory(m['localBytes'] as Uint8List,
                                                      width: 200,
                                                      fit: BoxFit.contain)
                                                  : m['attachment'] != null
                                                      ? _attachment(
                                                          m['attachment']
                                                              as Map)
                                                      : FastCatMessageBody(
                                                          body: m['source'] ==
                                                                  'welcome'
                                                              ? ((_t('zh', 'en') == 'en'
                                                                      ? _welcomeEn
                                                                      : _welcomeZh) ??
                                                                  m['body']
                                                                      as String? ??
                                                                  '')
                                                              : m['body']
                                                                      as String? ??
                                                                  '',
                                                          plain: own,
                                                          locale: _locale,
                                                          onOpenLink:
                                                              widget.onOpenLink,
                                                          onMessage: (value) =>
                                                              setState(() =>
                                                                  _text.text =
                                                                      value)),
                                              metadata
                                            ]))))
                          ])))
            ]));
  }

  @override
  void dispose() {
    _pushHeartbeat?.cancel();
    unawaited(
        widget.client.setPushChatVisible(false).catchError((Object _) {}));
    WidgetsBinding.instance.removeObserver(this);
    _subscription?.cancel();
    _connectionSubscription?.cancel();
    _soundSubscription?.cancel();
    _tone.dispose();
    _scroll.dispose();
    _inputFocus.dispose();
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => !_appearanceReady
      ? Material(
          color: Theme.of(context).brightness == Brightness.dark
              ? const Color(0xff111216)
              : const Color(0xfff8f9fc),
          child: Center(
              child: _appearanceError == null
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.grey))
                  : TextButton(
                      onPressed: () {
                        setState(() => _appearanceError = null);
                        _loadAppearance();
                      },
                      child: Text(_appearanceError!))))
      : Theme(
          data: _effectiveTheme(context),
          child: Scaffold(
              appBar: widget.showHeader
                  ? PreferredSize(
                      preferredSize: const Size.fromHeight(40),
                      child: ColoredBox(
                          color: _primary,
                          child: SafeArea(
                              bottom: false,
                              child: SizedBox(
                                  height: 40,
                                  child: Padding(
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 20),
                                      child: Row(children: [
                                        Expanded(
                                            child: Text(_serviceLabel,
                                                style: TextStyle(
                                                    fontSize: 12,
                                                    color:
                                                        _primary.computeLuminance() >
                                                                .179
                                                            ? Colors.black
                                                            : Colors.white))),
                                        IconButton(
                                            padding: EdgeInsets.zero,
                                            constraints:
                                                const BoxConstraints.tightFor(
                                                    width: 30, height: 30),
                                            tooltip: _t('声音', 'Sound'),
                                            color: _primary.computeLuminance() >
                                                    .179
                                                ? Colors.black
                                                : Colors.white,
                                            onPressed: _toggleSound,
                                            icon: WebIcon(
                                                _sound ? 'bell' : 'muted',
                                                size: 18))
                                      ]))))))
                  : null,
              backgroundColor:
                  _effectiveTheme(context).brightness == Brightness.dark
                      ? const Color(0xff111216)
                      : const Color(0xfff8f9fc),
              body: SafeArea(
                  child: Column(children: [
                if (widget.client.diagnosticHandlers.isNotEmpty ||
                    widget.client.repairHandlers.isNotEmpty)
                  FastCatAssistancePanel(
                      client: widget.client,
                      english: _t('中文', 'English') == 'English',
                      onActivity: _observeAssistance),
                if (!widget.showHeader && _showHandoff)
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
                      child: Text(_connection ==
                              FastCatConnectionStatus.connecting
                          ? _t('正在连接客服…', 'Connecting to support…')
                          : _t('连接中断，正在重试…', 'Connection lost. Retrying…'))),
                Expanded(
                    child: NotificationListener<UserScrollNotification>(
                        onNotification: (notification) {
                          if (notification.depth == 0 &&
                              notification.direction != ScrollDirection.idle) {
                            _userNavigated = true;
                            _openingScrollPending = false;
                            _scrollAfterSend = false;
                          }
                          return false;
                        },
                        child: ListView.builder(
                            controller: _scroll,
                            padding: const EdgeInsets.symmetric(
                                horizontal: 16, vertical: 18),
                            itemCount: _messages.length +
                                (_typing ? 1 : 0) +
                                (_pendingId != null ? 1 : 0),
                            itemBuilder: (context, i) {
                              if (i < _messages.length) {
                                final m = _messages[i];
                                final date = (m['created'] as String? ?? '')
                                    .split('T')
                                    .first;
                                final previous = i == 0
                                    ? ''
                                    : (_messages[i - 1]['created'] as String? ??
                                            '')
                                        .split('T')
                                        .first;
                                return Column(children: [
                                  if (date != previous)
                                    Padding(
                                        padding:
                                            const EdgeInsets.only(bottom: 20),
                                        child: Text(_dateLabel(date),
                                            style: const TextStyle(
                                                fontSize: 12,
                                                color: Colors.grey))),
                                  if (m['source'] == 'assistance')
                                    FastCatAssistanceActivity(
                                        activity: m['activity'] as Map,
                                        english:
                                            _t('中文', 'English') == 'English')
                                  else
                                    _message(m)
                                ]);
                              }
                              if (_typing && i == _messages.length)
                                return _message({
                                  'role': 'agent',
                                  'source': 'ai',
                                  'senderAvatar': _aiAvatar,
                                  'body': _aiDraft.isEmpty
                                      ? _t('正在思考…', 'Thinking…')
                                      : _aiDraft
                                });
                              return _message({
                                'role': 'visitor',
                                'body': _pendingFile?.filename ??
                                    _pendingBody ??
                                    '',
                                if (_pendingFile != null &&
                                    RegExp(r'\.(png|jpg|jpeg|gif|webp)$',
                                            caseSensitive: false)
                                        .hasMatch(_pendingFile!.filename))
                                  'localBytes': _pendingFile!.bytes,
                                'pending': true
                              });
                            }))),
                if (_error != null)
                  Padding(
                      padding: const EdgeInsets.all(8),
                      child: Text(supportError(_error!, _t('zh', 'en') == 'en'),
                          style: TextStyle(
                              color: Theme.of(context).colorScheme.error))),
                if (_closed)
                  Text(_t('会话已结束，发送消息即可继续咨询。',
                      'Conversation closed. Send a message to continue.')),
                ColoredBox(
                    color: _effectiveTheme(context).colorScheme.surface,
                    child: Container(
                        key: _composerKey,
                        constraints: const BoxConstraints(minHeight: 90),
                        margin: const EdgeInsets.fromLTRB(12, 6, 12, 12),
                        padding: const EdgeInsets.fromLTRB(16, 10, 16, 8),
                        decoration: BoxDecoration(
                          color: _effectiveTheme(context).colorScheme.surface,
                          border: Border.all(
                              color: (_inputFocus.hasFocus || _emojiOpen)
                                  ? _primary
                                  : _effectiveTheme(context).brightness ==
                                          Brightness.dark
                                      ? const Color(0xff2b2d37)
                                      : const Color(0xffe9ecf2)),
                          borderRadius: BorderRadius.circular(28),
                        ),
                        child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              TextField(
                                  focusNode: _inputFocus,
                                  controller: _text,
                                  readOnly: false,
                                  maxLength: 10000,
                                  style: const TextStyle(
                                      fontSize: 14, height: 1.6),
                                  minLines: 1,
                                  maxLines: 4,
                                  textInputAction: TextInputAction.send,
                                  onSubmitted: (_) => _send(),
                                  decoration: InputDecoration(
                                      filled: false,
                                      fillColor: Colors.transparent,
                                      enabledBorder: InputBorder.none,
                                      focusedBorder: InputBorder.none,
                                      disabledBorder: InputBorder.none,
                                      isDense: true,
                                      contentPadding:
                                          const EdgeInsets.symmetric(
                                              horizontal: 4, vertical: 2),
                                      hintText:
                                          _t('输入消息...', 'Type a message...'),
                                      border: InputBorder.none,
                                      counterText: '')),
                              const SizedBox(height: 8),
                              LayoutBuilder(
                                  builder: (context, constraints) =>
                                      Row(children: [
                                        Transform.translate(
                                            offset: const Offset(-4, 0),
                                            child: Row(
                                                mainAxisSize: MainAxisSize.min,
                                                children: [
                                                  IconButton(
                                                      tooltip: _t(
                                                          '发送附件', 'Send attachment'),
                                                      style: IconButton.styleFrom(
                                                          fixedSize: const Size(
                                                              36, 36),
                                                          minimumSize: const Size(
                                                              36, 36),
                                                          tapTargetSize:
                                                              MaterialTapTargetSize
                                                                  .shrinkWrap),
                                                      constraints:
                                                          const BoxConstraints.tightFor(
                                                              width: 36,
                                                              height: 36),
                                                      padding:
                                                          const EdgeInsets.only(
                                                              left: 5),
                                                      alignment:
                                                          Alignment.centerLeft,
                                                      visualDensity:
                                                          VisualDensity.compact,
                                                      onPressed:
                                                          widget.pickAttachment ==
                                                                      null ||
                                                                  _sending ||
                                                                  _pendingId != null
                                                              ? null
                                                              : () async {
                                                                  try {
                                                                    final file =
                                                                        await widget
                                                                            .pickAttachment!();
                                                                    if (!mounted ||
                                                                        file ==
                                                                            null)
                                                                      return;
                                                                    if (file.bytes
                                                                            .length >
                                                                        8 *
                                                                            1024 *
                                                                            1024) {
                                                                      throw Exception(_t(
                                                                          '附件不能超过 8 MB',
                                                                          'Attachment must be 8 MB or smaller'));
                                                                    }
                                                                    _pendingFile =
                                                                        file;
                                                                    await _send();
                                                                  } catch (e) {
                                                                    if (mounted)
                                                                      setState(() =>
                                                                          _error =
                                                                              e.toString());
                                                                  }
                                                                },
                                                      icon: const WebIcon('attach')),
                                                  SizedBox(
                                                      width: (constraints
                                                                  .maxWidth *
                                                              .02)
                                                          .clamp(8.0, 12.0)),
                                                  IconButton(
                                                      key: _emojiKey,
                                                      tooltip: _t(
                                                          '选择表情', 'Choose emoji'),
                                                      style: IconButton.styleFrom(
                                                          fixedSize: const Size(
                                                              36, 36),
                                                          minimumSize:
                                                              const Size(
                                                                  36, 36),
                                                          tapTargetSize:
                                                              MaterialTapTargetSize
                                                                  .shrinkWrap),
                                                      constraints:
                                                          const BoxConstraints.tightFor(
                                                              width: 36,
                                                              height: 36),
                                                      padding:
                                                          const EdgeInsets.only(
                                                              left: 5),
                                                      alignment:
                                                          Alignment.centerLeft,
                                                      visualDensity:
                                                          VisualDensity.compact,
                                                      icon:
                                                          const WebIcon('emoji'),
                                                      onPressed: () async {
                                                        _inputFocus.unfocus();
                                                        setState(() =>
                                                            _emojiOpen = true);
                                                        final emoji = await showMenu<
                                                                String>(
                                                            context: context,
                                                            requestFocus: false,
                                                            color: _effectiveTheme(
                                                                    context)
                                                                .colorScheme
                                                                .surface,
                                                            surfaceTintColor:
                                                                Colors
                                                                    .transparent,
                                                            menuPadding:
                                                                const EdgeInsets.all(
                                                                    10),
                                                            shape: RoundedRectangleBorder(
                                                                borderRadius:
                                                                    BorderRadius.circular(
                                                                        14),
                                                                side: BorderSide(
                                                                    color: _effectiveTheme(context)
                                                                        .dividerColor)),
                                                            constraints:
                                                                const BoxConstraints.tightFor(
                                                                    width: 260),
                                                            positionBuilder:
                                                                (menuContext,
                                                                    constraints) {
                                                              final composer = _composerKey
                                                                      .currentContext!
                                                                      .findRenderObject()
                                                                  as RenderBox;
                                                              final point = composer.localToGlobal(
                                                                  Offset.zero,
                                                                  ancestor: Navigator.of(
                                                                          context)
                                                                      .overlay!
                                                                      .context
                                                                      .findRenderObject() as RenderBox);
                                                              return RelativeRect.fromLTRB(
                                                                  point.dx + 16,
                                                                  (point.dy -
                                                                          200)
                                                                      .clamp(
                                                                          8.0,
                                                                          double
                                                                              .infinity)
                                                                      .toDouble(),
                                                                  constraints
                                                                          .maxWidth -
                                                                      point.dx -
                                                                      276,
                                                                  0);
                                                            },
                                                            items: [
                                                              PopupMenuItem<
                                                                      String>(
                                                                  padding:
                                                                      EdgeInsets
                                                                          .zero,
                                                                  enabled:
                                                                      false,
                                                                  child: SizedBox(
                                                                      width: 240,
                                                                      child: Wrap(
                                                                          children: [
                                                                        '😀',
                                                                        '😊',
                                                                        '😂',
                                                                        '🥰',
                                                                        '😉',
                                                                        '🤔',
                                                                        '😅',
                                                                        '🥲',
                                                                        '😎',
                                                                        '🙏',
                                                                        '👍',
                                                                        '👏',
                                                                        '🙌',
                                                                        '🤝',
                                                                        '❤️',
                                                                        '💛',
                                                                        '💚',
                                                                        '💙',
                                                                        '🎉',
                                                                        '🎁',
                                                                        '✨',
                                                                        '🌟',
                                                                        '✅',
                                                                        '💬'
                                                                      ].map((v) => SizedBox(width: 40, height: 40, child: TextButton(style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: Size.zero, tapTargetSize: MaterialTapTargetSize.shrinkWrap), onPressed: () => Navigator.pop(context, v), child: Text(v, style: const TextStyle(fontSize: 20))))).toList())))
                                                            ]);
                                                        if (mounted) {
                                                          _inputFocus.unfocus();
                                                          setState(() =>
                                                              _emojiOpen =
                                                                  false);
                                                        }
                                                        if (emoji != null &&
                                                            mounted) {
                                                          final value =
                                                              _text.value;
                                                          final selection = value
                                                                  .selection
                                                                  .isValid
                                                              ? value.selection
                                                              : TextSelection
                                                                  .collapsed(
                                                                      offset: value
                                                                          .text
                                                                          .length);
                                                          final inserted = value
                                                              .text
                                                              .replaceRange(
                                                                  selection
                                                                      .start,
                                                                  selection.end,
                                                                  emoji);
                                                          if (inserted.length <=
                                                              10000) {
                                                            _text.value = TextEditingValue(
                                                                text: inserted,
                                                                selection: TextSelection.collapsed(
                                                                    offset: selection
                                                                            .start +
                                                                        emoji
                                                                            .length));
                                                            _inputFocus
                                                                .requestFocus();
                                                          }
                                                        }
                                                      }),
                                                ])),
                                        const Spacer(),
                                        Tooltip(
                                            message: _pendingId != null
                                                ? _t('重试发送', 'Retry send')
                                                : _t('发送', 'Send'),
                                            child: FilledButton(
                                                style: FilledButton.styleFrom(
                                                    tapTargetSize: MaterialTapTargetSize
                                                        .shrinkWrap,
                                                    shape: const CircleBorder(),
                                                    minimumSize:
                                                        const Size(36, 36),
                                                    padding:
                                                        const EdgeInsets.all(8),
                                                    backgroundColor: _text.text
                                                                .trim()
                                                                .isEmpty &&
                                                            _pendingId == null
                                                        ? (_effectiveTheme(context).brightness == Brightness.dark
                                                            ? const Color(
                                                                0xff111216)
                                                            : const Color(
                                                                0xfff8f9fc))
                                                        : _primary,
                                                    foregroundColor: _text.text
                                                                .trim()
                                                                .isEmpty &&
                                                            _pendingId == null
                                                        ? Colors.grey
                                                        : _primary.computeLuminance() >
                                                                0.179
                                                            ? Colors.black
                                                            : Colors.white),
                                                onPressed:
                                                    _sending ? null : _send,
                                                child: _sending
                                                    ? const SizedBox(
                                                        width: 16,
                                                        height: 16,
                                                        child: CircularProgressIndicator(strokeWidth: 1.5))
                                                    : _pendingId != null
                                                        ? const Icon(Icons.error_outline, size: 20)
                                                        : const WebIcon('send', size: 24)))
                                      ]))
                            ])))
              ]))));
}

class _BubbleTail extends CustomPainter {
  final bool own;
  final Color color;
  final Color? border;
  _BubbleTail({required this.own, required this.color, this.border});
  @override
  void paint(Canvas canvas, Size size) {
    final path = Path();
    if (own) {
      path.moveTo(size.width - 3, size.height - 17);
      path.quadraticBezierTo(
          size.width, size.height - 6, size.width + 3, size.height - 4);
      path.quadraticBezierTo(
          size.width - 4, size.height, size.width - 12, size.height - 2);
    } else {
      path.moveTo(12, 1);
      path.quadraticBezierTo(2, 0, -3, 3);
      path.quadraticBezierTo(0, 6, 2, 17);
    }
    path.close();
    final outline = Path.combine(
        PathOperation.union,
        Path()
          ..addRRect(RRect.fromRectAndRadius(
              Offset.zero & size, const Radius.circular(14))),
        path);
    canvas.drawPath(outline, Paint()..color = color);
    if (border != null)
      canvas.drawPath(
          outline,
          Paint()
            ..color = border!
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1);
  }

  @override
  bool shouldRepaint(_BubbleTail old) =>
      old.own != own || old.color != color || old.border != border;
}
