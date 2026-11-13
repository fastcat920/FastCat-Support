import 'package:flutter/widgets.dart';

/// Null locale follows the host application's Localizations (or device locale).
String supportText(BuildContext context, String zh, String en,
    [Locale? locale]) {
  final language = (locale ??
          Localizations.maybeLocaleOf(context) ??
          WidgetsBinding.instance.platformDispatcher.locale)
      .languageCode;
  return language.toLowerCase() == 'en' ? en : zh;
}

/// Keep transport/server details out of user-facing notices and localize at render.
String supportError(String error, bool english) {
  String t(String zh, String en) => english ? en : zh;
  if (error.contains('配置加载失败') || error.contains('Unable to load')) {
    return t('配置加载失败，点击重试', 'Unable to load. Tap to retry');
  }
  if (error.contains('修复结果暂未同步') || error.contains('Repair result')) {
    return t('修复结果暂未同步，恢复连接后将重试。',
        'Repair result not synced yet. Will retry after reconnecting.');
  }
  if (error.contains('请输入有效邮箱') || error.contains('Enter a valid email')) {
    return t('请输入有效邮箱', 'Enter a valid email address');
  }
  if (RegExp(r'8 MB|8MB|413|too large|文件大小', caseSensitive: false)
      .hasMatch(error)) {
    return t('请选择不超过 8 MB 的非空文件', 'Choose a non-empty file up to 8 MB');
  }
  if (error.contains('上传额度')) {
    return t('今日附件上传额度已用完，请稍后重试',
        "Today's upload quota has been reached. Try again later.");
  }
  if (RegExp(r'401|403|unauthorized|expired|失效|已过期|凭据无效', caseSensitive: false)
      .hasMatch(error)) {
    return t('会话或授权已失效，请重新连接后重试',
        'Session or permission expired. Reconnect and try again.');
  }
  if (RegExp(r'429|rate limit|频繁', caseSensitive: false).hasMatch(error)) {
    return t('请求过于频繁，请稍后重试', 'Too many requests. Please try again shortly.');
  }
  if (RegExp(r'network|socket|connection|timeout|timed out|fetch|网络|连接',
          caseSensitive: false)
      .hasMatch(error)) {
    return t('网络连接异常，请检查网络后重试',
        'Connection failed. Check your network and try again.');
  }
  return t('操作未完成，请重试', 'Operation failed. Please try again.');
}
