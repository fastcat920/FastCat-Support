# 用户 Flutter 客户端推送接入（SDK 0.28.0）

本项目已提供用户端 APNs（iOS）与 FCM HTTP v1（Android）发送通道；与客服 APP 的推送设备表、任务表和密钥配置分开。没有修改宿主客户端源代码，也不在 SDK 内引入 Firebase 或系统权限插件。

## 服务端配置

```
USER_APNS_KEY_FILE=/app/secrets/UserAuthKey.p8
USER_APNS_KEY_ID=用户APP的KeyID
USER_APNS_TEAM_ID=苹果TeamID
USER_APNS_TOPIC=用户APP的BundleID
USER_FCM_SERVICE_ACCOUNT_FILE=/app/secrets/firebase-user-service-account.json
```

用户 APP 与客服 APP 即使共用 Apple Team/密钥，也必须明确配置各自 topic。Firebase 服务账号需具备目标项目的 FCM 发送权限并启用 HTTP v1 API。密钥文件在 Docker 内只读挂载，并显式传入对应环境变量，重启服务生效。未配置通道时不尝试发送；不能通过 APP 提交任意 Bundle ID 或 Firebase 项目来改变发送目标。

参考：[Apple APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)、[FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api)。Android FCM 依赖设备的 Google 服务及网络可用性，当前未接入华为、小米等厂商通道。桌面系统推送尚未接入。

## 宿主 APP 配合

1. 获取通知权限；iOS 开启 Push Notifications capability，获取 APNs token；Android 配置 Firebase 并获取 FCM token，创建 `fastcat_support` 通知渠道。
2. 生成并持久化安装级随机 deviceId（UUID，16–128 位字母、数字、下划线或横线），同一安装切换账号继续使用该 deviceId。不要使用用户邮箱、硬件 ID 或每次随机变化的临时标识。
3. 使用本账号、本设备的会话凭据完成 SDK start/restore，随后注册推送。每次登录、恢复会话、token 更新和语言/通知偏好变化后重新注册。绑定只对当前 conversationId 生效，不能按邮箱跨会话广播。

```dart
await support.registerPushDevice(
  deviceId: installationId,
  token: pushToken,
  provider: 'apns', // Android 使用 fcm
  environment: 'production', // iOS 开发签名使用 sandbox，TestFlight/App Store 使用 production
  language: 'zh', // zh 或 en
  enabled: true,
);
final status = await support.pushStatus();
// status: {configured:{apns:bool,fcm:bool},unreadCount:int}
```

4. FastCatChat 挂载后会自动上报可见状态，前台每 30 秒续约；退后台或卸载聊天组件会清除可见状态，服务端最长 60 秒自动过期。若宿主将聊天页保持在 Offstage/Tab 页面而不销毁，隐藏时必须自行调用 `setPushChatVisible(false)`，且不要让隐藏的 FastCatChat 继续运行；可按需挂载/卸载聊天组件。自绘聊天页可每 30 秒调用 `setPushChatVisible(true)`，离开时传 false。
5. 退出账号前 **await support.unregisterPushDevice()**，随后 reset。SDK reset 也会先解绑，失败会抛错而不会静默清除绑定。close 只关闭连接/更新前台状态，不代表退出账号，不会删除推送绑定，允许关闭聊天后继续接收通知。解绑因网络失败时应重试；新的账号登录需使用同一 installationId 重新注册，覆盖旧绑定。
6. 通知点击与前台接收由宿主处理。收到 payload 后先检查当前账号和本设备恢复的会话，再比较 conversationId；不匹配的通知直接忽略，**不能直接信任通知的 ID 去恢复他人会话**。一致时打开现有 FastCatChat。iOS 前台通知是否显示仍由宿主 delegate 控制。

## 通知内容与规则

客服文本、图片、附件与 AI 最终回复触发；系统提示、欢迎语、内部历史备注、访客自己的消息以及 AI 思考片段不触发。相同消息与设备去重；已经阅读、解绑、账号切换、凭据变化或聊天页处于前台时取消待发送任务。设备注册超过 30 天不活跃会停止发送，重新注册后恢复。

```
{
  "aps":{"alert":{"title":"FastCat Support","body":"客服有一条新回复"},"sound":"default","badge":2,"thread-id":"conversationId"},
  "type":"support.reply","conversationId":"...","messageId":"..."
}
```

Android FCM notification 包含通用标题/正文，data 含 type、conversationId、messageId、unreadCount（字符串）。不会携带聊天正文、用户邮箱、附件链接或诊断报告。未读数为当前绑定会话中未读的客服/AI消息数；SDK/APP应以实际拉取与已读回执为准，同步应用角标。

## HTTP 接口

基于当前 widget 会话，`Authorization: Bearer <visitor token>`，所有请求继续带 appKey query。

- `GET /api/widget/push/status?id=<conversationId>`
- `PUT /api/widget/push/device`：JSON `{id,deviceId,provider,token,environment,language,enabled}`
- `PATCH /api/widget/push/device`：JSON `{id,deviceId,foreground}`
- `DELETE /api/widget/push/device`：JSON `{id,deviceId}`

注册/解绑只改变当前凭据允许的绑定；新账号用同一 installationId 注册会替换该安装的旧账号绑定。客户端仍负责正确保管各账号、设备的会话凭据。本实现不根据自报邮箱/用户ID合并会话，也不修改既有会话分配规则。

任务持久化，最多 5 次退避重试、最长 1 小时；无通道配置时不消耗重试次数。记录保留 7 天，失效 token 自动停用。APNs/FCM 不保证送达或严格顺序，超时重试可能重复，宿主按 messageId 去重并从后台拉取真实消息。尚未配置真实密钥及完成真机送达联调。
