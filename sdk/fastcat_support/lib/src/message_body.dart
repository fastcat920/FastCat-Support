import 'strings.dart';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

/// Shared Markdown and bounded structured-message view. Links are host controlled.
class FastCatMessageBody extends StatefulWidget {
  final String body;
  final bool plain;
  final Locale? locale;
  final ValueChanged<String>? onMessage;
  final ValueChanged<Uri>? onOpenLink;
  const FastCatMessageBody(
      {super.key,
      required this.body,
      this.plain = false,
      this.locale,
      this.onMessage,
      this.onOpenLink});
  @override
  State<FastCatMessageBody> createState() => _FastCatMessageBodyState();
}

class _FastCatMessageBodyState extends State<FastCatMessageBody> {
  final values = <String, String>{};
  String _t(String zh, String en) =>
      supportText(context, zh, en, widget.locale);
  @override
  void didUpdateWidget(covariant FastCatMessageBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.body != widget.body) values.clear();
  }

  Uri? safeUrl(dynamic raw) {
    final u = Uri.tryParse(raw?.toString() ?? '');
    return u != null && ['http', 'https', 'mailto'].contains(u.scheme)
        ? u
        : null;
  }

  void link(String raw) {
    if (raw.startsWith('msg://')) {
      try {
        widget.onMessage?.call(Uri.decodeComponent(raw.substring(6)));
      } catch (_) {}
    } else {
      final u = safeUrl(raw);
      if (u != null) widget.onOpenLink?.call(u);
    }
  }

  Widget markdown(String text) => MarkdownBody(
      data: text.length > 20000 ? text.substring(0, 20000) : text,
      selectable: true,
      onTapLink: (text, href, title) {
        if (href != null) link(href);
      },
      imageBuilder: (uri, title, alt) {
        if (!['http', 'https'].contains(uri.scheme))
          return Text(alt ?? _t('图片不可用', 'Image unavailable'));
        return Image.network(uri.toString(),
            height: 180,
            fit: BoxFit.contain,
            errorBuilder: (c, e, s) =>
                Text(alt ?? _t('图片加载失败', 'Image failed to load')));
      });
  @override
  Widget build(BuildContext context) {
    if (widget.plain) return Text(widget.body);
    dynamic data;
    try {
      data = jsonDecode(widget.body);
    } catch (_) {
      final match = RegExp(r'^```(?:spec|json-render)\s*\n([\s\S]*?)\n```$')
          .firstMatch(widget.body);
      if (match != null) {
        try {
          data = {'type': 'json_render', 'spec': jsonDecode(match[1]!)};
        } catch (_) {}
      }
    }
    if (data is Map && data['type'] == 'rich_text') {
      final images = data['images'] is List
          ? (data['images'] as List).take(9)
          : const <dynamic>[];
      final file = data['file'];
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        markdown(data['content']?.toString() ?? ''),
        Wrap(
            spacing: 8,
            runSpacing: 8,
            children: images.map((i) {
              final u = safeUrl(i is String
                  ? i
                  : i is Map
                      ? i['url']
                      : null);
              return u != null && ['http', 'https'].contains(u.scheme)
                  ? Image.network(u.toString(),
                      width: 120,
                      height: 120,
                      fit: BoxFit.contain,
                      errorBuilder: (c, e, s) =>
                          Text(_t('图片加载失败', 'Image failed to load')))
                  : const SizedBox.shrink();
            }).toList()),
        if (file is Map && safeUrl(file['url']) != null)
          TextButton(
              onPressed: () => link(file['url'].toString()),
              child: Text(
                  '${_t('附件', 'Attachment')}: ${file['name'] ?? _t('下载', 'Download')}'))
      ]);
    }
    if (data is Map && data['type'] == 'json_render') {
      try {
        var count = 0;
        final spec = data['spec'];
        final path = <dynamic>{};
        Widget node(dynamic id, int depth) {
          if (++count > 200 || depth > 12) throw const FormatException('结构过大');
          final e = id is String ? spec['elements'][id] : id;
          if (e is! Map || path.contains(e))
            throw const FormatException('结构无效');
          path.add(e);
          final p = e['props'] is Map ? e['props'] as Map : const {};
          final children =
              (e['children'] is List ? e['children'] as List : const [])
                  .map((v) => node(v, depth + 1))
                  .toList();
          path.remove(e);
          final type = e['type'],
              text =
                  (p['text'] ?? p['content'] ?? p['label'] ?? p['value'] ?? '')
                      .toString();
          switch (type) {
            case 'Text':
              return Text(text);
            case 'Card':
            case 'Section':
            case 'SectionCard':
              return Card(
                  child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (p['title'] != null)
                              Text(p['title'].toString(),
                                  style: const TextStyle(
                                      fontWeight: FontWeight.bold)),
                            ...children
                          ])));
            case 'Row':
            case 'ButtonGroup':
            case 'Actions':
              return Wrap(spacing: 10, runSpacing: 8, children: children);
            case 'Column':
            case 'List':
              return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: children);
            case 'Divider':
              return const Divider();
            case 'KV':
            case 'KeyValue':
            case 'PriceRow':
            case 'AmountRow':
              return Wrap(spacing: 16, children: [
                Text((p['label'] ?? p['key'] ?? '').toString()),
                Text((p['value'] ?? p['amount'] ?? '').toString(),
                    style: const TextStyle(fontWeight: FontWeight.bold))
              ]);
            case 'Badge':
            case 'StatusBadge':
              return Chip(label: Text(text));
            case 'OrderItem':
            case 'LineItem':
              return ListTile(
                  title: Text(
                      (p['name'] ?? p['title'] ?? _t('商品', 'Item')).toString()),
                  subtitle: Text(
                      '${p['description'] ?? ''}\n${p['quantity'] ?? p['qty'] ?? 1} × ${p['price'] ?? p['amount'] ?? ''}'));
            case 'Image':
              final u = safeUrl(p['url'] ?? p['src']);
              return u != null && ['http', 'https'].contains(u.scheme)
                  ? Image.network(u.toString(),
                      height: 180,
                      errorBuilder: (c, e, s) =>
                          Text(_t('图片加载失败', 'Image failed to load')))
                  : const SizedBox.shrink();
            case 'Button':
              final event = e['on'] is Map ? e['on']['press'] : null;
              final message = p['message'] ??
                  (event is Map &&
                          event['action'] == 'send_message' &&
                          event['params'] is Map
                      ? event['params']['message']
                      : null);
              final url = safeUrl(p['url'] ?? p['href']);
              return TextButton(
                  onPressed: p['disabled'] == true
                      ? null
                      : message != null
                          ? () {
                              final value = message.toString().replaceAllMapped(
                                  RegExp(r'\{\{([^{}]+)\}\}'),
                                  (m) => values[m[1]!.trim()] ?? '');
                              widget.onMessage?.call(value);
                            }
                          : url != null
                              ? () => link(url.toString())
                              : null,
                  child: Text((p['label'] ?? p['text'] ?? _t('提交', 'Submit'))
                      .toString()));
            case 'Input':
            case 'TextField':
            case 'DateTimeInput':
              final name = (p['name'] ?? p['label'] ?? 'field').toString();
              values.putIfAbsent(name, () => p['value']?.toString() ?? '');
              return TextFormField(
                  key: ValueKey(name),
                  initialValue: values[name] ?? p['value']?.toString(),
                  maxLength: 1000,
                  decoration:
                      InputDecoration(labelText: p['label']?.toString()),
                  onChanged: (v) => values[name] = v);
            case 'Checkbox':
            case 'CheckBox':
              final name = (p['name'] ?? p['label'] ?? 'field').toString();
              values.putIfAbsent(name, () => (p['checked'] == true).toString());
              return CheckboxListTile(
                  title: Text((p['label'] ?? '').toString()),
                  value: values[name] == 'true' ||
                      (!values.containsKey(name) && p['checked'] == true),
                  onChanged: (v) =>
                      setState(() => values[name] = v.toString()));
            case 'MultipleChoice':
              final name = (p['name'] ?? p['label'] ?? 'field').toString();
              final options = p['options'] is List
                  ? (p['options'] as List).take(50)
                  : const <dynamic>[];
              return DropdownButtonFormField<String>(
                  initialValue: values[name],
                  decoration:
                      InputDecoration(labelText: p['label']?.toString()),
                  items: options
                      .map((o) => DropdownMenuItem(
                          value: (o is String ? o : o['value']).toString(),
                          child:
                              Text((o is String ? o : o['label']).toString())))
                      .toList(),
                  onChanged: (v) => values[name] = v ?? '');
            default:
              return Column(children: [
                Text('${_t('暂不支持的组件', 'Unsupported component')}: $type'),
                ...children
              ]);
          }
        }

        return node(spec['root'] ?? spec, 0);
      } catch (_) {
        return Text(
            '${_t('结构化内容无法完整显示', 'Unable to render structured content')}:\n${widget.body}');
      }
    }
    return markdown(widget.body);
  }
}
