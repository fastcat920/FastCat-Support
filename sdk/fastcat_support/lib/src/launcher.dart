import 'appearance.dart';
import 'strings.dart';
import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'client.dart';
import 'chat.dart';

/// Put in the host page's Stack after start/restore. The host owns the client.
/// This observer does not mark messages read. Chat sends receipts when visible.
class FastCatLauncher extends StatefulWidget {
  final FastCatClient client;
  final String? title;
  final Locale? locale;
  final Alignment alignment;
  final Future<FastCatAttachment?> Function()? pickAttachment;
  final Future<void> Function(String filename, Uint8List bytes)? onAttachment;
  const FastCatLauncher(
      {super.key,
      required this.client,
      this.title,
      this.locale,
      this.alignment = Alignment.bottomRight,
      this.pickAttachment,
      this.onAttachment});
  @override
  State<FastCatLauncher> createState() => _FastCatLauncherState();
}

class _FastCatLauncherState extends State<FastCatLauncher> {
  final _unread = <int>{};
  StreamSubscription<Map<String, dynamic>>? _pages;
  StreamSubscription<int>? _reads;
  bool _opening = false;
  Color _primary = defaultSupportColor;
  int _appearanceRevision = 0;
  void _loadAppearance() {
    final revision = ++_appearanceRevision;
    widget.client.configuration().then((config) {
      if (mounted && revision == _appearanceRevision)
        setState(() => _primary = supportColor(config));
    }).catchError((Object _) {});
  }

  void _subscribe() {
    _reads = widget.client.readCursorStream.listen((seq) {
      if (mounted) setState(() => _unread.removeWhere((n) => n <= seq));
    });
    _pages = widget.client.watch().listen((page) {
      if (!mounted) return;
      setState(() {
        for (final m in page['messages'] as List) {
          final seq = m['seq'];
          if (seq is int &&
              m['role'] == 'agent' &&
              m['source'] != 'system' &&
              m['read_at'] == null &&
              seq > widget.client.readCursor) _unread.add(seq);
        }
        _unread.removeWhere((n) => n <= widget.client.readCursor);
      });
    }, onError: (Object error) {});
  }

  @override
  void initState() {
    super.initState();
    _loadAppearance();
    _subscribe();
  }

  @override
  void didUpdateWidget(covariant FastCatLauncher old) {
    super.didUpdateWidget(old);
    if (old.client != widget.client) {
      _primary = defaultSupportColor;
      _loadAppearance();
      _pages?.cancel();
      _reads?.cancel();
      _unread.clear();
      _subscribe();
    }
  }

  Future<void> _open() async {
    if (_opening) return;
    setState(() => _opening = true);
    try {
      await Navigator.of(context).push(MaterialPageRoute<void>(
          builder: (_) => FastCatChat(
              client: widget.client,
              title: widget.title,
              locale: widget.locale,
              pickAttachment: widget.pickAttachment,
              onAttachment: widget.onAttachment)));
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  void dispose() {
    _pages?.cancel();
    _reads?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Align(
      alignment: widget.alignment,
      child: Padding(
          padding: const EdgeInsets.all(16),
          child: Badge(
              isLabelVisible: _unread.isNotEmpty,
              label: Text(_unread.length > 99 ? '99+' : '${_unread.length}'),
              child: FloatingActionButton(
                  heroTag: null,
                  backgroundColor: _primary,
                  foregroundColor: _primary.computeLuminance() > 0.179
                      ? Colors.black
                      : Colors.white,
                  tooltip: supportText(
                      context, '联系客服', 'Contact support', widget.locale),
                  onPressed: _opening ? null : _open,
                  child: const Icon(Icons.chat_bubble_outline)))));
}
