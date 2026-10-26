import 'package:flutter/material.dart';
import 'package:fastcat_support/fastcat_support.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final client = FastCatClient(
      baseUrl: Uri.parse('https://support.example.com'),
      appKey: '从后台 SDK 平台复制');
  // Inject an app-owned FastCatSessionStore for persistence across app launches.
  await client.start(name: '演示客户');
  runApp(MaterialApp(home: FastCatChat(client: client)));
}
