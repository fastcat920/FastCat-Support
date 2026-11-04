import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:fastcat_support/fastcat_support.dart';
void main() {
 test('history is silent, new messages deduplicate and read cursor clears unread', () async {
  var pages=0;
  final client=FastCatClient(baseUrl:Uri.parse('https://support.example.com'),appKey:'sdk',client:MockClient((request) async {
   if(request.url.path.endsWith('/start')) return http.Response('{"id":"c","token":"t"}',201);
   if(request.url.path.endsWith('/receipts')) return http.Response('{}',200);
   pages++;
   final messages=[{'id':'one','seq':1,'role':'agent','source':'staff'},if(pages>1){'id':'two','seq':2,'role':'agent','source':'ai'}];
   return http.Response(jsonEncode({'messages':messages,'nextCursor':pages,'hasMore':false}),200);
  }));
  await client.start(email:'user@example.com');
  final incoming=<Map<String,dynamic>>[];
  final subscription=client.incomingMessageStream.listen(incoming.add);
  await client.watch(interval:Duration.zero).take(3).drain<void>();
  await Future<void>.delayed(Duration.zero);
  expect(client.unreadCount,2);
  expect(incoming.map((m)=>m['seq']),[2]);
  await client.acknowledge(deliveredSeq:2,readSeq:2);
  expect(client.unreadCount,0);
  await subscription.cancel(); client.close();
 });
}
