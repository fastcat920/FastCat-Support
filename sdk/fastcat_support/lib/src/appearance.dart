import 'package:flutter/material.dart';

const defaultSupportColor = Color(0xff5b4ee8);
Color supportColor(Map<String, dynamic> config,
    {Brightness brightness = Brightness.light}) {
  final appearance = config['widget'] as Map? ?? const {};
  final dark = appearance['theme'] == 'dark' ||
      (appearance['theme'] != 'light' && brightness == Brightness.dark);
  final selected = appearance[dark ? 'themeColorDark' : 'themeColorLight'];
  final raw =
      selected is String && RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(selected)
          ? selected
          : appearance['themeColor'];
  return raw is String && RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(raw)
      ? Color(0xff000000 | int.parse(raw.substring(1), radix: 16))
      : defaultSupportColor;
}

ThemeData supportTheme(ThemeData host, Color primary) {
  final onPrimary =
      primary.computeLuminance() > 0.179 ? Colors.black : Colors.white;
  return host.copyWith(
      primaryColor: primary,
      colorScheme:
          ColorScheme.fromSeed(seedColor: primary, brightness: host.brightness)
              .copyWith(
                  primary: primary,
                  onPrimary: onPrimary,
                  surface: host.colorScheme.surface));
}
