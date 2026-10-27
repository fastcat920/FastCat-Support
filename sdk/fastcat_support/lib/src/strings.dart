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
