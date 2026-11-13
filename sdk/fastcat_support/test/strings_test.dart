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
  test(
      'upload quotas and identity expiry are explained in the current language',
      () {
    expect(supportError('今日附件上传额度已用完，请稍后重试', true), contains('upload quota'));
    expect(supportError('访客身份凭据无效或已过期', true),
        contains('Session or permission expired'));
  });
}
