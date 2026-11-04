import 'dart:math';
import 'dart:typed_data';
import 'package:audioplayers/audioplayers.dart';

class SupportNotificationSound {
  AudioPlayer? _player;
  Future<void> play() async {
    try {
      const rate = 24000, count = 8640;
      final data = ByteData(44 + count * 2);
      void text(int offset, String s) {
        for (var i = 0; i < s.length; i++) {
          data.setUint8(offset + i, s.codeUnitAt(i));
        }
      }

      text(0, 'RIFF');
      data.setUint32(4, 36 + count * 2, Endian.little);
      text(8, 'WAVE');
      text(12, 'fmt ');
      data.setUint32(16, 16, Endian.little);
      data.setUint16(20, 1, Endian.little);
      data.setUint16(22, 1, Endian.little);
      data.setUint32(24, rate, Endian.little);
      data.setUint32(28, rate * 2, Endian.little);
      data.setUint16(32, 2, Endian.little);
      data.setUint16(34, 16, Endian.little);
      text(36, 'data');
      data.setUint32(40, count * 2, Endian.little);
      var phase = 0.0;
      for (var i = 0; i < count; i++) {
        final t = i / rate;
        final gain =
            t < .02 ? .13 * t / .02 : .13 * pow(.001 / .13, (t - .02) / .33);
        phase += 2 * pi * (t < .12 ? 740 : 990) / rate;
        data.setInt16(
            44 + i * 2, (sin(phase) * gain * 32767).round(), Endian.little);
      }
      _player ??= AudioPlayer();
      await _player!
          .play(BytesSource(data.buffer.asUint8List(), mimeType: 'audio/wav'));
    } catch (_) {/* Audio is optional when muted or unavailable. */}
  }

  void dispose() {
    _player?.dispose();
  }
}
