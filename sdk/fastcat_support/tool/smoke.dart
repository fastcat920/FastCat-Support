import 'dart:typed_data';
import '../lib/src/client.dart';

Future<void> main(List<String> args) async {
  if (args.length != 2)
    throw ArgumentError(
        'Usage: dart run tool/smoke.dart LOCAL_QA_ORIGIN APP_KEY');
  final origin = Uri.parse(args[0]);
  if (!['localhost', '127.0.0.1'].contains(origin.host))
    throw ArgumentError('This smoke creates QA data; localhost only');
  final client = FastCatClient(baseUrl: origin, appKey: args[1]);
  try {
    await client.start(email: 'smoke@example.com');
    final id = FastCatClient.newClientId();
    await client.sendText('来自 Dart SDK 的咨询', clientId: id);
    final retry = await client.sendText('来自 Dart SDK 的咨询', clientId: id);
    if (retry['duplicate'] != true) throw StateError('Deduplication failed');
    await client.sendAttachment(Uint8List.fromList('SDK file'.codeUnits),
        filename: 'sdk.txt', clientId: FastCatClient.newClientId());
    await client.requestHuman();
    final page = await client.messages();
    if ((page['messages'] as List).length < 2)
      throw StateError('Messages missing');
    final seq = page['nextCursor'] as int;
    await client.acknowledge(deliveredSeq: seq, readSeq: seq);
    print(
        'Dart HTTP integration passed: start, text, deduplication, attachment, handoff, history, receipts.');
  } finally {
    client.close();
  }
}
