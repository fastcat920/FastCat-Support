# iOS 客服 APP 推送接入

后台已提供 APNs 推送接口。此文档是 APP 适配协议；无需修改用户咨询 SDK。

## 服务端配置

使用 Apple Developer 的 APNs Authentication Key（.p8），配置环境变量后重启服务：

```
APNS_KEY_FILE=/app/secrets/AuthKey.p8
APNS_KEY_ID=苹果 Key ID
APNS_TEAM_ID=苹果 Team ID
APNS_TOPIC=客服APP的Bundle ID
```

Docker 需将密钥文件只读挂载进容器，并在 compose 的 environment 显式添加以上变量；仅修改宿主机环境文件而未传入容器不会生效。密钥不要提交仓库或打包进 APP。

没有上述配置时 configured=false，不尝试连接苹果。设备绑定接口仍可使用。开发构建使用 sandbox，TestFlight/App Store 使用 production。APNs 请求使用 HTTP/2、ES256 token authentication；参考 [Apple 文档](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)。

## 登录与设备绑定

使用现有 POST /api/login 登录，APP 保存服务端 Set-Cookie 的 fc_session，通过 Cookie 请求下列接口。会话有效期目前为 24 小时，重新登录后必须重新绑定设备。服务端不在响应中返回推送 Token、私钥或登录凭据。

所有设备请求均为当前登录客服操作，不接受其他 userId。deviceId 使用 APP 首次安装生成并持久化的随机 UUID，不用硬件设备号。Token 更新、账号切换、重新登录或通知设置变化时重新 PUT。

PUT /api/push/device

```json
{
  "deviceId": "installation_uuid_123456",
  "token": "APNs十六进制Token",
  "environment": "sandbox",
  "language": "zh",
  "enabled": true
}
```

language 支持 zh/en；enabled=false 停止该设备推送。一个安装标识或 Token 只能绑定一个账号。绑定随当前登录会话到期而失效，避免退出后的设备收到消息。

DELETE /api/push/device

```json
{ "deviceId": "installation_uuid_123456" }
```

退出登录前调用 DELETE；随后调用现有 /api/logout。即使 DELETE 因断网失败，服务端也会在登录会话失效后停止推送。

## 前台状态

PATCH /api/push/device

```json
{
  "deviceId": "installation_uuid_123456",
  "foreground": true,
  "activeConversationId": "当前正在看的会话ID"
}
```

前台每 30 秒更新，切换会话立即更新；离开聊天页传 activeConversationId=null；进入后台传 foreground=false。状态 60 秒自动过期。服务端只抑制同一设备正在查看的会话，其余设备继续正常通知。iOS 前台通知展示由 APP 的 UNUserNotificationCenterDelegate 决定，防止前后台切换时重复横幅。

## 状态、未读和通知跳转

GET /api/push/status

```json
{ "configured": false, "provider": "apns", "unreadCount": 0 }
```

设备接口也返回 configured 和 unreadCount。未读数沿用后台“未读访客消息”口径：负责会话加未分配会话；按消息条数，不是会话数。APP 使用现有消息及已读接口同步实时界面、未读数和系统角标；APNs 的 badge 仅为发送时快照，APNs 不保证送达或顺序，不能作为消息来源。

推送载荷示例：

```json
{
  "aps": {
    "alert": { "title": "FastCat Support", "body": "收到一条新的访客消息" },
    "sound": "default",
    "badge": 3,
    "thread-id": "会话ID"
  },
  "type": "conversation.message",
  "conversationId": "会话ID",
  "messageId": "消息ID"
}
```

点击通知后先检查登录状态，再通过现有接口加载 conversationId；访问被拒绝或会话不存在时返回收件箱。推送只含通用提醒，不包含消息正文、邮箱、诊断资料、附件地址或 Token。

## 通知范围与可靠性

访客文字、图片、附件触发；AI、客服回复及历史内部备注不触发。已分配会话仅通知负责客服；未分配会话通知启用的 admin/agent 设备。客服账号被停用、会话改派、已读、设备解绑或登录过期时，尚未发送的任务取消。

任务持久化在 SQLite，按消息+设备去重；每 5 秒处理，失败退避重试，最多 5 次、最长 1 小时。失效 Token 自动停用。历史消息不补推，未读通过拉取恢复。APNs 网络超时不能确定是否已接收，极端情况下重试可能重复；APP 结合 messageId 去重。任务记录保留 7 天，可从 push_jobs 查看 sent/failed/skipped、reason 和 attempts，设备 Token 不应写日志。

APP 完成适配且苹果密钥配置后，需要在真实 iPhone 测试前台、后台、锁屏、账号切换、Token 更新及通知跳转。当前未连接真实 APNs 验证送达。
