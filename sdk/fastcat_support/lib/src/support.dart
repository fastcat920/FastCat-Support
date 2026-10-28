import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'chat.dart';
import 'client.dart';
import 'strings.dart';

/// Business identity supplied by the host. It is not server-side authentication.
class FastCatUser {
  final String id;
  final String? email;
  final String? name;
  final String? phone;
  final Map<String, dynamic> profile;
  const FastCatUser(
      {required this.id,
      this.email,
      this.name,
      this.phone,
      this.profile = const {}});
}

/// Persists visitor credentials with the platform's secure storage facilities.
class FastCatSecureSessionStore implements FastCatSessionStore {
  final FlutterSecureStorage storage;
  const FastCatSecureSessionStore(
      {this.storage = const FlutterSecureStorage()});
  @override
  Future<String?> read(String key) => storage.read(key: key);
  @override
  Future<void> write(String key, String value) =>
      storage.write(key: key, value: value);
  @override
  Future<void> delete(String key) => storage.delete(key: key);
}

/// Own one instance per signed-in account and dispose it after the chat closes.
class FastCatSupport {
  final FastCatUser? user;
  final FastCatSessionStore store;
  late final FastCatClient client;
  late final String _emailKey;
  bool _opening = false;
  FastCatSupport(
      {required Uri baseUrl,
      required String appKey,
      this.user,
      FastCatSessionStore? store,
      http.Client? httpClient})
      : store = store ?? const FastCatSecureSessionStore() {
    if (user != null && user!.id.trim().isEmpty) {
      throw ArgumentError(
          'A non-empty user ID is required for account isolation.');
    }
    final scope = user == null ? 'anonymous' : 'account:${user!.id}';
    client = FastCatClient(
        baseUrl: baseUrl,
        appKey: appKey,
        store: this.store,
        sessionScope: scope,
        client: httpClient);
    _emailKey =
        'fastcat:email:${baseUrl.origin}:$appKey:${Uri.encodeComponent(scope)}';
  }

  Map<String, dynamic> get _profile => {
        ...?user?.profile,
        if (user != null) 'externalId': user!.id,
        if (user?.name?.trim().isNotEmpty == true)
          'displayName': user!.name!.trim(),
        if (user?.phone?.trim().isNotEmpty == true)
          'phone': user!.phone!.trim(),
      };

  /// Open the SDK-owned page. The caller supplies a new instance on account switch.
  Future<void> open(BuildContext context,
      {String? title,
      Locale? locale,
      ValueChanged<Uri>? onOpenLink,
      Future<FastCatAttachment?> Function()? pickAttachment,
      Future<void> Function(String filename, Uint8List bytes)?
          onAttachment}) async {
    if (_opening) return;
    _opening = true;
    try {
      await Navigator.of(context).push(MaterialPageRoute<void>(
          builder: (_) => _SupportEntry(
              support: this,
              title: title,
              locale: locale,
              onOpenLink: onOpenLink,
              pickAttachment: pickAttachment,
              onAttachment: onAttachment)));
    } finally {
      _opening = false;
    }
  }

  /// Clear local credentials and remembered email for this identity only.
  Future<void> reset() async {
    await client.reset();
    await store.delete(_emailKey);
  }

  void close() => client.close();
}

class _SupportEntry extends StatefulWidget {
  final FastCatSupport support;
  final String? title;
  final Locale? locale;
  final ValueChanged<Uri>? onOpenLink;
  final Future<FastCatAttachment?> Function()? pickAttachment;
  final Future<void> Function(String, Uint8List)? onAttachment;
  const _SupportEntry(
      {required this.support,
      this.title,
      this.locale,
      this.onOpenLink,
      this.pickAttachment,
      this.onAttachment});
  @override
  State<_SupportEntry> createState() => _SupportEntryState();
}

class _SupportEntryState extends State<_SupportEntry> {
  final _email = TextEditingController();
  bool _busy = true, _ready = false, _needsEmail = false;
  String? _error;
  String _t(String zh, String en) =>
      supportText(context, zh, en, widget.locale);
  @override
  void initState() {
    super.initState();
    _prepare();
  }

  Future<void> _prepare() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final support = widget.support;
      if (support.client.hasSession || await support.client.restore()) {
        if (support._profile.isNotEmpty ||
            support.user?.email?.trim().isNotEmpty == true) {
          await support.client.updateProfile(
              email: support.user?.email?.trim().isNotEmpty == true
                  ? support.user!.email!.trim()
                  : null,
              profile: support._profile);
        }
        if (mounted) setState(() => _ready = true);
        return;
      }
      if (!mounted) return;
      final supplied = support.user?.email?.trim() ?? '';
      final saved =
          supplied.isEmpty ? await support.store.read(support._emailKey) : null;
      if (!mounted) return;
      _email.text = supplied.isNotEmpty ? supplied : (saved ?? '');
      if (_email.text.trim().isNotEmpty) {
        await _start();
        return;
      }
      if (mounted) setState(() => _needsEmail = true);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _start() async {
    final email = _email.text.trim();
    if (!RegExp(r'^\S+@\S+\.\S+$').hasMatch(email)) {
      if (mounted)
        setState(() {
          _needsEmail = true;
          _error = _t('请输入有效邮箱', 'Enter a valid email address');
        });
      return;
    }
    if (mounted)
      setState(() {
        _busy = true;
        _error = null;
      });
    try {
      await widget.support.client
          .start(email: email, profile: widget.support._profile);
      await widget.support.store.write(widget.support._emailKey, email);
      if (mounted) setState(() => _ready = true);
    } catch (e) {
      if (mounted)
        setState(() {
          _needsEmail = !widget.support.client.hasSession;
          _error = e.toString();
        });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_ready)
      return FastCatChat(
          client: widget.support.client,
          title: widget.title,
          locale: widget.locale,
          onOpenLink: widget.onOpenLink,
          pickAttachment: widget.pickAttachment,
          onAttachment: widget.onAttachment);
    return Scaffold(
        appBar: AppBar(title: Text(widget.title ?? _t('在线客服', 'Support'))),
        body: Center(
            child: Padding(
                padding: const EdgeInsets.all(24),
                child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 420),
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      if (_busy) const CircularProgressIndicator(),
                      if (!_busy && _needsEmail) ...[
                        TextField(
                            controller: _email,
                            keyboardType: TextInputType.emailAddress,
                            autofillHints: const [AutofillHints.email],
                            decoration:
                                InputDecoration(labelText: _t('邮箱', 'Email')),
                            onSubmitted: (_) => _start()),
                        const SizedBox(height: 16),
                        FilledButton(
                            onPressed: _start,
                            child: Text(_t('开始咨询', 'Start chat'))),
                      ],
                      if (_error != null) ...[
                        const SizedBox(height: 12),
                        Text(_error!,
                            style: TextStyle(
                                color: Theme.of(context).colorScheme.error)),
                        if (!_needsEmail && !_busy)
                          TextButton(
                              onPressed: _prepare,
                              child: Text(_t('重试', 'Retry')))
                      ],
                    ])))));
  }
}
