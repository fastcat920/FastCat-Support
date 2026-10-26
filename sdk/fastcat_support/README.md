# FastCat Support · Flutter / Dart SDK

SDK 版本 0.13.0，连接自建 FastCat Support 0.9+，支持 Flutter 原生聊天界面与独立 Dart 访客客户端。用户从应用咨询；Telegram 仅作为客服的人工回复桥接。

## 安装与连接

解压后以本地依赖接入（未发布 pub.dev）：

```yaml
dependencies:
  fastcat_support:
    path: ../fastcat_support
```

```dart
import 'package:fastcat_support/fastcat_support.dart';

final support = FastCatClient(
  baseUrl: Uri.parse('https://support.example.com'),
  appKey: '后台 → 接入平台 → Flutter / Dart SDK 中的公开标识',
  // store: AppSecureSessionStore(),
);
if (!await support.restore()) {
  await support.start(name: '客户称呼', email: '可选邮箱');
}
// 在 Flutter 页面中展示；页面销毁不会关闭共享 client。
FastCatChat(client: support);
```

完整启动示例见 `example/main.dart`。正式服务必须使用 HTTPS；HTTP 仅允许 localhost、127.0.0.1、::1 与 Android 模拟器宿主地址 10.0.2.2。Android 需 INTERNET 权限；开发 HTTP 需按宿主应用配置本地明文访问，iOS 本地开发按宿主 ATS 设置。Flutter Web 在后台配置完整 origin（例如 `https://app.example.com`）；SDK 不使用工作台 Cookie。

## 消息与附件

```dart
final requestId = FastCatClient.newClientId();
await support.sendText('需要帮助', clientId: requestId);
// 网络失败且结果未知时，保留同一内容与 requestId 重试。
await support.requestHuman();
final page = await support.messages(after: 0, limit: 200);
await support.acknowledge(deliveredSeq: 12, readSeq: 10);
```

`watch()` 每两秒按服务端游标增量拉取，分页立即续取，网络恢复后继续；订阅取消后停止拉取。不使用推送通知或后台常驻。`watch` 本身不标记已读，宿主需在用户可见后显式提交回执。聊天组件在前台、当前路由接收消息后提交已读。

附件 API：`sendAttachment(bytes, filename: ..., clientId: ...)`、`downloadAttachment(id)`；单文件 8 MB，服务器检查文件类型。聊天组件可注入 `pickAttachment`（返回 `FastCatAttachment`）与 `onAttachment(filename, bytes)`（保存/预览）。选择器与文件保存由宿主提供，不请求额外平台权限。

## 会话与重试边界

- 公开 appKey 是接入配置标识，不是客户身份凭证；每次 start 创建匿名访客会话，不提供可信业务身份登录。
- 生产应用应实现 `FastCatSessionStore`，使用宿主安全存储保存访客 token。存储按服务地址与平台隔离；不注入时仅内存保存。切换业务账号时先 `reset()`，再为新账号 start，禁止跨账号恢复旧访客会话。
- `reset()` 只清除本地会话；`close()` 释放 HTTP 客户端。调用 reset/更换 client 前，应取消旧 watch 并停止发送。
- 聊天组件保留当前失败文本/附件及原 clientId，点击重试；暂未提供跨进程持久离线 outbox，退出页面前由宿主保存草稿。不要重新生成 ID 重试未知结果。
- 原生客户端实测协议使用本地 QA 服务；尚未在真实 Android/iOS 设备发布构建中验收。无 APNs/FCM、语音录制或视频通话。

## 验证

```sh
flutter pub get
flutter analyze
flutter test
# 仅本地独立 QA 数据库使用，会创建验收会话：
dart run tool/smoke.dart http://localhost:4311 PUBLIC_SDK_KEY
```

Dart HTTP 实现参考：[官方 http 包](https://pub.dev/packages/http)。

## 0.9：悬浮入口、连接状态与 AI 草稿

```dart
// 先完成 start/restore，再加入宿主页面的 Stack。
Stack(children: [
  yourPage,
  FastCatLauncher(client: support, alignment: Alignment.bottomRight),
]);

support.connectionStatusStream.listen((status) {
  // idle / connecting / connected / reconnecting / closed
});
```

Launcher 显示已同步、尚未读取的客服/AI 回复角标。点击后进入全屏聊天；入口本身不提交已读，聊天页在前台可见时提交回执。宿主切换业务账号、reset 或重建会话时，应先销毁旧 Launcher/Chat，再以新会话重建组件。尚无独立 unreadCountStream、全局 show/hide 或底部弹层接口。

聊天页显示 automation.draft 临时内容，最终消息到达后移除草稿。连接事件表示轮询状态，仍是两秒增量轮询，不等同于 WebSocket。Launcher 未挂载时观察停止；无后台系统推送。

## 0.13 消息展示

FastCatChat 与可独立使用的 FastCatMessageBody 支持 Markdown、rich_text 和 json_render body 信封。结构化按钮将内容填入输入框，由用户确认发送。外链由 onOpenLink 回调交给宿主处理，默认不自动打开；不执行 HTML 或脚本 URL。独立 Dart API 客户端仍返回原始 body。完整协议与边界见项目 docs/FEATURES-V013.md。

11 项 Flutter 测试与静态分析通过；真实设备和宿主外链打开行为需宿主自行联调。
