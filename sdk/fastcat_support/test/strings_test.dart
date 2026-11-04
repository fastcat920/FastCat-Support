import 'package:flutter_test/flutter_test.dart';
import 'package:fastcat_support/src/strings.dart';

void main() {
  test(
      'transport and server errors follow current language without leaking raw details',
      () {
    expect(supportError('SocketException: secret.example', true),
        contains('Connection failed'));
    expect(
        supportError('SocketException: secret.example', false), contains('网络'));
    expect(
        supportError('未知服务器细节', true), 'Operation failed. Please try again.');
    expect(supportError('Attachment must be 8 MB or smaller', false),
        contains('8 MB'));
  });
}
