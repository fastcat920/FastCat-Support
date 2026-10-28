# FastCat Support · Flutter / Dart SDK

SDK 版本 0.16.1，连接自建 FastCat Support 0.9+，支持 Flutter 原生聊天界面与独立 Dart 访客客户端。用户从应用咨询；Telegram 仅作为客服的人工回复桥接。

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
  await support.start(email: 'customer@example.com', profile: {'platform': 'Flutter', 'device': 'Phone', 'custom': {'plan': 'Pro'}});
}
// 在 Flutter 页面中展示；页面销毁不会关闭共享 client。
FastCatChat(client: support);
```

完整启动示例见 `example/main.dart`。正式服务必须使用 HTTPS；HTTP 仅允许 localhost、127.0.0.1、::1 与 Android 模拟器宿主地址 10.0.2.2。Android 需 INTERNET 权限；开发 HTTP 需按宿主应用配置本地明文访问，iOS 本地开发按宿主 ATS 设置。Flutter Web 在后台配置完整 origin（例如 `https://app.example.com`）；SDK 不使用工作台 Cookie。

## 推荐的直接打开方式（0.16）

```dart
final support = FastCatSupport(
  baseUrl: Uri.parse('https://support.fastcat.lol'),
  appKey: '后台 Flutter / Dart SDK 平台的接入标识',
  user: FastCatUser(id: currentUser.id, email: currentUser.email, name: currentUser.name),
);
await support.open(context);
// 不再使用时调用 support.close()；切换账号时关闭旧页面并创建新实例。
```

未传用户时使用匿名会话；没有可用邮箱时首次填写，凭据及邮箱默认通过 flutter_secure_storage 保存。用户 ID 用于本机隔离，并非服务端身份认证；不同设备无法仅凭邮箱恢复会话。`reset()` 清除当前身份的本地凭据和邮箱。旧 `FastCatClient`、`FastCatChat` 和 `FastCatLauncher` 仍可使用，旧会话不会自动迁移到新账号范围。附件选择和下载仍需宿主提供回调。Web 安全存储受浏览器和 HTTPS 环境约束；macOS 等平台需按 flutter_secure_storage 文档配置权限，真实设备需单独验收。

聊天页读取后台的平台标题、Logo、主题色、语言及明暗模式；欢迎语由服务端会话消息提供。后台实时预览为网页组件，Flutter 是独立实现，布局和功能并非像素级完全一致。

## 嵌入客户端页面（0.16.1）

保留客户端原有标题和返回按钮，将 SDK 内容放进页面主体，支持自动恢复会话和首次邮箱输入：

```dart
Scaffold(
  appBar: AppBar(title: const Text('客服')),
  body: FastCatSupportView(support: support),
);
```

嵌入模式默认不显示 SDK 标题栏；如需 SDK 标题栏，可设置 `showHeader: true`。原有 `support.open(context)` 行为保持兼容。账号切换时先移除旧页面，再创建对应账号的新 `FastCatSupport` 和视图。

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

## 语言、主题与会话继续

`FastCatChat` 和 `FastCatLauncher` 默认跟随宿主 `MaterialApp` 的 `Localizations.locale`（简体中文或英文）和 `ThemeData` 的明暗模式。主题色通过公开的平台配置接口读取，始终使用后台设置，不跟随宿主的主色。应用切换语言或明暗模式后，聊天控件随之更新。可传入 `locale: const Locale('en')` 或 `locale: const Locale('zh', 'CN')` 固定聊天语言；自定义 `title` 和服务端消息不做机器翻译。

客服结束会话后，输入和发送保持可用。下一条新消息会重新打开同一会话；服务端按该平台 AI 策略恢复接待，纯人工策略不被覆盖。失败消息仍使用原 clientId 重试，已成功消息的重试不会重开会话。

## 访客资料

首次 `start` 必须传邮箱，邮箱作为访客名称。`profile` 可传 `externalId`、`displayName`、`phone`、`company`、`jobTitle`、`source`、`timezone`、`platform`、`device`、`os`、`appVersion`、`browser`、`language`、`location`，以及 `custom` 自定义字段（字符串、数字或布尔值）。已建立会话时可调用 `await support.updateProfile(profile: {'device': 'Phone'})` 更新当前会话资料。

邮箱及客户端资料属于访客提供的信息，不作为已验证身份，也不会按邮箱合并不同会话。旧版仅传姓名的 SDK 调用需更新为传入邮箱。
