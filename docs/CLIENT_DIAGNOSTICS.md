# 客户端诊断协助接入（第一版）

SDK 0.24.0 起默认使用两类30分钟授权，取代下文旧版逐次确认；详见 `CLIENT_ASSISTANCE_AUTHORIZATION.md`（包内 `AUTHORIZATION.md`）。执行去重、设备隔离、快照与回滚要求保持不变。
本版只开放只读诊断。SDK 内置授权卡片，后台收件箱“诊断协助”入口和 AI 均可发起请求。客户端无需重新绘制聊天页面。

## Flutter 接入

更新 SDK 至 0.21.0。在创建 FastCatSupport 时传入 diagnosticHandlers，或在显示聊天前设置 support.client.diagnosticHandlers。

```dart
final support = FastCatSupport(
  baseUrl: Uri.parse('https://support.fastcat.lol'),
  appKey: sdkAppKey,
  user: FastCatUser(id: stableAccountId, email: email),
  diagnosticHandlers: {
    'basic': (request) async {
      request.throwIfCancelled();
      return {
        'appVersion': appVersion,
        'osVersion': osVersion,
        'platform': platformName,
        'summary': '基础信息采集完成',
      };
    },
    'status': (request) async {
      request.throwIfCancelled();
      final state = await collectRedactedConnectionState();
      request.throwIfCancelled();
      return state; // 仅使用下文允许的报告字段
    },
  },
);
```

上例中的版本变量、collectRedactedConnectionState 由宿主实现，不是 SDK 内置函数。只注册实际可用能力，缺失能力不会展示或提供给 AI。

### 回调契约

`Future<Map<String,dynamic>> Function(FastCatDiagnosticRequest request)`

- `id`：单次请求编号，宿主也应以此去重。
- `capability`：basic / status / network / logs。
- `expiresAt`：服务端确认后的本次采集截止时间。
- `isCancelled`、`throwIfCancelled()`：宿主在每个采集步骤前后检查；用于撤回、超时、页面关闭、设备/会话变化。不能只在开始时检查。
- SDK 在用户点击“同意并诊断”、服务端确认请求仍有效后才调用一次回调。不会在轮询、重新打开页面时自动重复执行回调。
- 回调最长 90 秒；超时不会自动重试采集，下一次需重新请求并授权。
- 页面退出后 SDK 不再提交结果；宿主须主动检查取消标记，停止尚未完成的工作。关闭页面不是底层系统任务的强制中断。
- 采集失败抛出异常；SDK 提交通用失败说明，不直接上传异常里的路径或凭据。

### 报告字段

顶层仅允许：summary、appVersion、osVersion、platform、connection、kernel、proxy、tun、checks、logs。报告为 JSON，总长度上限 24000 字符；checks/logs 建议使用结构化数组。

宿主必须在返回前脱敏：禁止密码、订阅 URL、访问令牌、完整节点配置、私钥、任意文件内容及浏览记录。服务端另有敏感字段过滤与 URL 隐藏，但不能替代宿主脱敏。不要通过日志字段上传完整配置。

### 状态和生命周期

- 设备标识由 SDK 生成并通过会话存储持久化，与账号隔离；不采集硬件序列号。宿主提供稳定账号 ID，不用邮箱作为设备标识。
- 聊天打开且有诊断回调时，每 4 秒登记能力/更新心跳；30 秒无心跳标为离线。后台进程或关闭聊天时本版不持续接收诊断。
- 请求授权窗口 5 分钟；同意后采集窗口 2 分钟。每次只授权所列的一项诊断，不是长期远程控制授权。
- 可拒绝、执行中可撤回。新设备接入同一会话会撤销旧设备未完成请求。
- 已提交报告供本次会话 AI 和有会话权限的人工客服共同查看，最多保留 7 天；每小时清理一次，访问时也清理。撤回停止后续采集，不会删除已提交历史。
- 结束会话后不再接受采集或上传；退出登录应关闭并释放原 FastCatSupport 实例。
- 提交报告后 SDK 发送“诊断报告已提交，请根据报告继续排查。”，沿用现有 AI/人工接待状态继续处理，人工接管后不会强制重新交给 AI。

## HTTP 协议（非 Flutter 接入）

访客接口沿用当前访客 Bearer token、id 和 appKey 校验，不能使用后台管理员凭据：

`GET /api/widget/assistance?id=会话ID&appKey=平台KEY`

`POST /api/widget/assistance?appKey=平台KEY`，公共字段 `{id, action, deviceId}`。

- register：加 capabilities 数组，返回 device 与 requests。
- accept / decline / revoke：加 requestId。
- result：加 requestId 与 report，或 error。重复提交已完成结果不会覆盖历史。

必须先 accept 成功才采集，不允许收到 pending 请求直接上传。

后台接口：`GET/POST /api/conversations/:id/assistance`，沿用后台登录、来源与会话权限校验。POST `{capability,reason}` 发起请求。

## 诊断授权边界

诊断授权不包含修改代理、重启内核等操作。SDK 0.22.0 新增独立修复确认，详见 `CLIENT_REPAIRS.md`（SDK 包内 `REPAIRS.md`）。仍不提供任意命令、远程桌面、静默采集或后台推送。
