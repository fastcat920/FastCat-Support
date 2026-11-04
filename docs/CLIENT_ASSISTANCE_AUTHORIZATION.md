# 分类授权（SDK 0.24.0）

当前默认：本次协助内，信息查询类和操作类分别授权一次，各自有效 30 分钟。有效范围内不再逐条弹确认。旧版 SDK 保持逐条确认兼容行为。

## 用户界面

- 首个查询请求到达时展示“信息查询授权”：列明客户端已注册的基础信息、连接状态、网络、脱敏日志、线路比较等能力。
- 首个修复请求到达时展示“操作类授权”：列明客户端已注册的重连、重启内核、代理及恢复能力，以及当前允许临时切换的备用线路。
- 查询授权不能用于操作。用户分别点击授权后，SDK在聊天窗口处于前台时自动处理各自范围内的请求。
- 有效期从服务端首次确认时算起，不因轮询、心跳或重复点击延长。
- 两类授权显示到期时间并各自提供撤回按钮；到期后下一个请求需要重新授权。
- 新增能力或新的备用线路不自动加入旧授权，SDK会提示“确认新增授权范围”。再次确认会重新建立该类授权的30分钟期限。
- 临时切换线路仍必须恢复原线路，不会因为操作类授权而变成永久切换。

## 客户端配合

现有 diagnosticHandlers、repairHandlers、routeOptions 回调可继续使用，不需要重新绘制界面或增加授权弹窗。更新 SDK 即可使用新界面与授权协议。

- 宿主仍负责回调去重、脱敏、执行前检查、复查和回滚。
- 操作系统要求的管理员/系统权限不由客服授权替代。
- 每个 FastCatSupport/FastCatClient 实例代表一次协助生命周期；同一实例重新打开聊天、仍在30分钟内时可沿用授权。新实例、新设备或应用重启会重新确认，旧授权不能被新实例继承。
- 退出登录、切换账号或结束协助时调用 `await support.client.endAssistance()`，随后释放原实例；`support.close()` 和 `reset()` 也会清理本地授权，并尽力通知服务端撤回。
- 本地关闭立即阻止开始新的操作。离线时撤回通知可能无法到达服务端，但新SDK实例的注册会使旧实例授权失效，服务端也会在到期后拒绝使用。
- 查询授权撤回时停止后续采集与报告提交。已提交报告仍按原保留期限供本会话AI及有权限人工查看。
- 操作授权撤回只阻止新操作；已经开始的操作要继续完成本地复查和必要回滚，并补报结果。不要因为授权撤回把代理或内核停在半修改状态。
- SDK会在新操作开始前复核本地授权与服务端任务有效期；宿主也应在实际系统修改开始前调用 `request.throwIfCannotStart()`。复查/回滚不应被此“开始操作”检查中断。

如果宿主自己另做了逐条确认弹窗，需自行调整；SDK不会绕过宿主或系统权限要求。

## HTTP 增量（与 repairProtocol:3 正交）

register 增加：

```
consentProtocol: 1
consentSessionId: 本次SDK实例生成的随机串（40–100位字母数字、下划线、连字符）
```

其余 deviceId、capabilities、repairCapabilities、routeOptions 保持原协议。

`POST /api/widget/assistance?appKey=...` 沿用访客 Bearer token，每次带 id、deviceId：

- scope_grant：加 scope:'query'|'operation'、consentSessionId。服务端根据当前已注册能力保存授权快照，固定30分钟，不能自行提交更大的能力范围。
- scope_revoke：加 scope、consentSessionId。仅撤回该类授权。
- scope_end：加 consentSessionId。结束该实例两类授权；旧实例不能撤回新实例的授权。
- accept（查询任务）：在既有参数中加 grantId:consents.query.id。
- repair_accept：在既有参数中加 grantId:consents.operation.id。保留原执行凭据、持久去重与结果恢复规则。

GET、register 和授权操作返回 consents:{query,operation}。每类为 null 或 {id,scope,capabilities,routes,expires}；expires 为服务端毫秒时间戳。授权绑定当前会话、设备及协助实例，不能跨用。只有新SDK声明 consentProtocol:1 才使用类别授权；旧SDK仍需原先的逐条确认。

服务端审计记录保存每个授权的创建、到期、撤回，以及任务关联的 grant_id。AI/人工仅创建任务，不能代替用户开启授权。

## 0.25.0 紧凑界面

顶部为36像素授权摘要，通过“管理”查看到期时间、范围及分别撤回。未授权时仅显示当前所需的一张短卡片，细节放在“查看范围”；任务进度/结果显示在滚动聊天记录中并可展开。无需修改现有诊断/修复回调。

新增 scope_decline（同样带 scope、deviceId、consentSessionId）：对应“暂不授权”，拒绝该类别当前待处理请求，不撤回之前仍有效的授权。该按钮不会代替用户授予任何权限。
