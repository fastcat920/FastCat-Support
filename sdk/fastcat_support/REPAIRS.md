# 客户端受控修复对接（SDK 0.23.0，兼容协议 2/3）

SDK 0.24.0 起默认使用两类30分钟授权，取代下文旧版逐次确认；详见 `CLIENT_ASSISTANCE_AUTHORIZATION.md`（包内 `AUTHORIZATION.md`）。执行去重、设备隔离、快照与回滚要求保持不变。
客服后台与 SDK 已提供请求、单次确认、持久去重记录、结果补报和结果待确认状态。实际网络/内核/代理操作仍由宿主实现。本版不会执行任意命令或静默修改设置。

## 注册能力

在创建 FastCatSupport 时增加 `repairHandlers`，或在打开聊天前设置 `support.client.repairHandlers`。可与第一版 `diagnosticHandlers` 同时使用。

```dart
final support = FastCatSupport(
  baseUrl: Uri.parse('https://support.fastcat.lol'),
  appKey: sdkAppKey,
  user: FastCatUser(id: stableAccountId, email: email),
  repairHandlers: {
    'reconnect': FastCatRepairHandler(
      execute: (request) async {
        request.throwIfCannotStart();
        // 宿主原子检查本地持久账本：该 request.id 已开始/已结束时不得再次执行。
        // 在执行前记录 intent，保存必要快照，再执行、复查、必要时本地回滚并记录最终结果。
        return repairService.executeOnce(request);
      },
      recover: (request) async {
        // 只查询本地持久账本，不允许在这里重新执行。
        // 返回最终结果；仍在进行或无法确认时返回 null。
        return repairService.lookupResult(request.id);
      },
    ),
  },
);
```

`repairService`、用户变量由宿主实现，不是 SDK 内置函数。宿主只能注册已完整实现的能力；SDK 未配置持久 FastCatSessionStore 时，不开放任何修复能力。FastCatSupport 默认使用安全存储。

### 操作名称

| operation | 含义 | 宿主要求 |
|---|---|---|
| reconnect | 使用当前节点重新连接 | 保留当前配置，恢复原连接意图，复查实际链路 |
| restart_core | 重启内核 | 恢复原连接状态，不静默更换节点或配置 |
| reapply_proxy | 重新应用 FastCat 管理的系统代理 | supportsRollback:true，保存原设置，本地复查，失败时回滚 |
| restore_settings | 恢复指定修复前的设置 | supportsRollback:true，用 restoreRequestId 找到本机快照；先校验当前设置未被用户或其他程序改动，禁止盲目覆盖 |

`supportsRollback` 是宿主对已经实现的能力声明，不能仅为了显示按钮而设为 true。只声明回调但未实际实现快照与回滚，不满足接入条件。

### 请求类型 FastCatRepairRequest

- id：全局唯一请求编号。宿主持久去重的唯一键，不能以操作名称代替。
- operation：四项白名单操作之一。
- expiresAt：允许开始操作的截止时间。执行前调用 throwIfCannotStart；已开始后的复查和回滚不依赖此有效期，也不依赖客服网络在线。
- restoreRequestId：仅恢复设置时提供，指向另一条已上报 snapshotAvailable:true 的本机修复记录。快照和敏感设置永远留在客户端，不上传到客服。

### 结果类型 FastCatRepairResult

```
FastCatRepairResult(
  outcome: 'succeeded',
  summary: '重新连接完成，链路复查通过',
  verified: true,
  snapshotAvailable: false,
  rollback: 'not_needed',
)
```

outcome：
- succeeded：操作完成且复查通过；verified 必须为 true。
- failed：已知操作失败；必须有可靠本地记录，不能把超时、断网或抛异常直接当作已知失败。
- rolled_back：修复未达预期，但原设置已恢复；rollback 必须为 succeeded。不代表原问题已解决。
- not_started：确定未发生任何系统修改。

rollback：not_needed / succeeded / failed / not_attempted。

summary：最多 1000 字符，宿主脱敏，不包含订阅地址、凭据、原始设置或日志。snapshotAvailable:true 只表示本机确实保留了可用于恢复的快照。不要承诺不存在的回滚能力。

## 执行与断线恢复

1. SDK 获取 pending 请求只展示卡片，不执行。
2. 用户点击“确认修复”，SDK先把请求与随机执行凭据写入安全存储，再向服务端确认。
3. 服务端单次授权后，SDK先持久记录 dispatched，然后调用 execute 一次。
4. 宿主独立完成操作、复查、必要的本地回滚，并持久记录结果。即使客服窗口关闭或网络中断，也应完成复查/回滚。
5. SDK持久保存结果并尝试上传；失败后重新打开原账号原会话、恢复连接时补报，不重新调用 execute。
6. 应用重启或 execute 抛异常/超过 120 秒后，SDK只调用 recover 查询结果，绝不自动再次执行。超时不代表底层任务已停止，宿主必须持续记录其最终结果。
7. 用户点击同意但接受响应丢失时，SDK不会猜测执行。恢复后可补报 not_started，随后由客服重新发起新的确认请求。

宿主账本必须跨进程/应用重启保存：requestId、操作、开始状态、快照引用、修改后设置指纹、复查、回滚和最终结果。SDK去重不能替代系统操作侧的原子去重。

修复开始后不提供“撤回立即中断”按钮，防止把代理或内核停在半修改状态。用户可在执行前拒绝；执行后由宿主完成安全收尾。

同一设备有 pending/running/unknown 修复时，后台禁止新增修复。unknown 只能由原请求的真实结果解除，不能通过点击重试绕过。不确定是否执行时返回 recover:null 并转人工判断。

服务端重启、超时、会话关闭会将执行中请求标为结果待确认，但仍允许携带原执行凭据补报最终结果。关闭会话禁止新修复或确认未开始请求，不阻断已发生操作的审计结果。

不同用户、会话、平台的本地账本隔离；SDK不会把旧账号结果上传给新账号。宿主退出登录时应停止发起新操作，并确保已开始的本地安全收尾有明确生命周期管理。

## HTTP 协议

沿用 `/api/widget/assistance?appKey=...` 的访客凭据与会话校验。

- register：`{id,action:'register',deviceId,capabilities:[诊断能力],repairProtocol:2,repairCapabilities:[修复能力]}`。
- repair_accept：`{id,action:'repair_accept',deviceId,requestId,executionKey}`；executionKey 40–100 位字母数字下划线连字符随机串。先持久保存，再请求；不能写入普通日志。
- repair_decline：`{id,action:'repair_decline',deviceId,requestId}`。
- repair_result：`{id,action:'repair_result',deviceId,requestId,executionKey,result:{outcome,summary,verified,snapshotAvailable,rollback}}`。重复提交不覆盖既有结果；断网后仍用同一个编号和凭据补报。
- GET 查询/心跳返回 `repairs`，包含 operation、restore_request_id、status、accepted、expires、result。永不返回 executionKey 或其哈希。

后台 POST `/api/conversations/:id/assistance`：`{kind:'repair',operation,reason,restoreRequestId?}`。只创建用户确认请求，不直接执行。需要原有后台登录及会话访问权限。

旧 SDK 只登记诊断能力时保持兼容，不会被开放修复操作。

## 0.23.0：线路比较与临时切换验证（协议 3）

新增两项独立能力，旧版诊断及四项修复保持兼容。

### 只读线路比较：diagnosticHandlers['routes']

用户同意诊断后比较当前线路及最多两条备用线路。不得修改用户当前选中线路、系统代理或连接状态。使用客户端现有的独立检测通道；若无法在不切换连接的情况下检查实际代理链路，应把该步骤标为 skipped，不能把 DNS/TCP 探测冒充线路可用。

报告仍使用已有白名单字段：

```json
{"summary":"已测2条线路；当前线路HTTPS失败，备用线路通过。仅代表已测范围。","checks":[{"routeId":"current","label":"当前线路","dns":"passed","transport":"passed","proxy":"passed","https":"failed","outcome":"failed"},{"routeId":"alt_1","label":"备用一","dns":"passed","transport":"passed","proxy":"passed","https":"passed","outcome":"passed"}]}
```

checks 必须为 1–3 条，建议每个检测结果记录测试阶段和耗时；不能检测的项目标记 skipped。不上传节点地址、密码、订阅 URL 或原始配置。多个失败只能说明已测线路失败，还需要排除本地网络、DNS、内核、检测目标异常，不能断言全部节点故障。

### 临时切换：repairHandlers['switch_route']

必须同时提供：

1. `routeOptions: Future<List<FastCatRouteOption>> Function()`：读取本地可用备用线路的元数据，不能触发探测或切换。最多 3 个候选项，仅提供稳定 opaque ID 和脱敏显示名称，不包含当前已选线路、地址、凭据。ID 限字母数字、下划线、连字符，最多 80 字符；label 最多 100 字符。
2. `FastCatRepairHandler(execute:..., recover:..., supportsRollback:true)`：支持本地原线路快照、恢复及持久去重。

```dart
routeOptions: () async => [
  const FastCatRouteOption(id: 'alt_1', label: '备用线路一'),
],
repairHandlers: {
  'switch_route': FastCatRepairHandler(
    supportsRollback: true,
    execute: (request) => localRepairService.testRouteOnce(
      request.id,
      targetRouteId: request.targetRouteId!,
      restoreOriginalAfterTest: true,
    ),
    recover: (request) => localRepairService.lookupResult(request.id),
  ),
},
```

`localRepairService` 由宿主实现。客户端根据 request.targetRouteId 查找本地线路；必须再次确认目标仍可用，不能在指定目标消失时静默换成另一条。request.targetRouteLabel 用于显示/审计，不能作为执行 ID。

流程：保存原线路及选择状态 → 切换到用户确认的目标 → 检查真实代理链路 → 无论检测成功或失败均恢复原线路 → 验证已恢复 → 持久记录结果并补报。关闭窗口、短暂断网或 SDK 超时不能中断恢复动作。

结果需额外提供 `originalRouteRestored: true/false`。succeeded 必须 verified:true 且 originalRouteRestored:true；这只表示对比验证流程完成，不代表原线路已修好。备用失败但已恢复可返回 rolled_back、rollback:succeeded、originalRouteRestored:true；无法恢复则返回已知失败及 rollback:failed，不得假报成功。

此版不提供“自动保留备用线路”，也不会自动遍历全部线路。用户后续是否长期使用备用线路由用户另行决定。

### HTTP 增量

register 使用 repairProtocol:3，增加 routeOptions:[{id,label}]。注册 switch_route 时必须提供非空候选列表；SDK 在没有候选项或没有回滚能力时不登记切换能力。

后台 POST 新增 `{kind:'repair',operation:'switch_route',targetRouteId:'alt_1',reason:'比较连接效果'}`，AI 工具也只能指定候选列表中的 ID。

请求记录和 SDK FastCatRepairRequest 增加 target_route_id/target_route_label（Dart 为 targetRouteId/targetRouteLabel）。用户确认时服务端复核候选 ID 和显示名是否仍一致，候选变化会拒绝执行，需重新发起确认。
