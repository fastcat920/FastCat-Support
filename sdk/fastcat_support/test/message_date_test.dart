import 'package:flutter_test/flutter_test.dart';
import 'package:fastcat_support/src/message_date.dart';

void main() {
  test('local midnight and year boundaries use the same day as bubble times',
      () {
    for (final local in [
      DateTime(2026, 11, 8, 0, 46),
      DateTime(2027, 1, 1, 0, 1),
      DateTime(2026, 11, 7, 23, 59)
    ]) {
      final stamp = local.toUtc().toIso8601String();
      final expected =
          '${local.year}-${local.month.toString().padLeft(2, '0')}-${local.day.toString().padLeft(2, '0')}';
      expect(localMessageDay(stamp), expected);
    }
    final stamp = '2026-11-07T16:46:00Z';
    expect(
        localMessageDay(stamp), localMessageDay('2026-11-08T00:46:00+08:00'));
    expect(localMessageDay(null), '');
    expect(localMessageDay('invalid'), '');
  });
}
