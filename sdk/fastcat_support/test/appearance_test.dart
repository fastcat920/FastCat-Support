import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fastcat_support/src/appearance.dart';

void main() {
  test(
      'mode accents follow host brightness and forced mode, preserving old color',
      () {
    final config = <String, dynamic>{
      'widget': {
        'themeColor': '#123456',
        'themeColorLight': '#336699',
        'themeColorDark': '#aabbcc'
      }
    };
    expect(supportColor(config, brightness: Brightness.light),
        const Color(0xff336699));
    expect(supportColor(config, brightness: Brightness.dark),
        const Color(0xffaabbcc));
    (config['widget'] as Map)['theme'] = 'light';
    expect(supportColor(config, brightness: Brightness.dark),
        const Color(0xff336699));
    expect(
        supportColor({
          'widget': {'themeColor': '#123456'}
        }, brightness: Brightness.dark),
        const Color(0xff123456));
  });
}
