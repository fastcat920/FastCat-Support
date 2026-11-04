export function openAssistance({ api, E, modal, toast, conversationId }) {
  const labels = {
    basic: "客户端与系统信息",
    status: "连接及代理状态",
    network: "网络诊断",
    logs: "脱敏日志",
    routes: "线路对比检测（最多3条）",
  };
  const states = {
    pending: "等待用户同意",
    running: "诊断中",
    succeeded: "已完成",
    failed: "失败",
    declined: "用户已拒绝",
    revoked: "授权已撤回",
    expired: "已过期",
    unknown: "结果待确认",
    rolled_back: "已回滚（问题未必解决）",
    not_started: "未执行",
  };
  const box = modal(
    "诊断与修复",
    '<div id="assistance-content" role="status">正在加载…</div>',
    "关闭",
  );
  let stopped = false,
    busy = false,
    lastState = "";
  const render = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const state = await api(`/conversations/${conversationId}/assistance`);
      if (stopped) return;
      const nextState = JSON.stringify(state);
      if (nextState === lastState) return;
      lastState = nextState;
      const root = box.querySelector("#assistance-content");
      const repairLabels = {
        switch_route: "切换线路并验证",
        reconnect: "重新连接",
        restart_core: "重启内核",
        reapply_proxy: "重新应用代理",
        restore_settings: "恢复修改前的设置",
      };
      const consentMarkup = state.device?.consentRequired
        ? `<div class="notice">${["query", "operation"]
            .map((scope) => {
              const g = state.consents?.[scope];
              return `${scope === "query" ? "信息查询" : "操作类"}：${g ? "已授权，至 " + E(new Date(g.expires).toLocaleTimeString()) : "未授权或已失效"}`;
            })
            .join(" · ")}</div>`
        : "";
      const repairs = state.repairs || [];
      const blocked = repairs.some(
        (r) =>
          r.device_id === state.device?.deviceId &&
          ["pending", "running", "unknown"].includes(r.status),
      );
      const snapshot = repairs.find(
        (r) =>
          r.device_id === state.device?.deviceId &&
          r.result?.snapshotAvailable &&
          [
            "reconnect",
            "restart_core",
            "reapply_proxy",
            "switch_route",
          ].includes(r.operation),
      );
      const repairMarkup = `<h3>修复操作</h3>${state.device?.routeOptions?.length ? `<label>备用线路<select id="repair-route">${state.device.routeOptions.map((r) => `<option value="${E(r.id)}">${E(r.label)}</option>`).join("")}</select></label><p class="small">临时切换验证后恢复原线路，不自动保留新线路。</p>` : ""}<p class="small">查询类和操作类分别授权，30分钟内按已授权范围自动处理，可随时撤回。执行中或结果待确认时不能重复下发。断线后的复查、快照和回滚由客户端在本地完成。</p>${blocked ? '<p class="notice">已有修复等待确认、执行中或结果待确认，请先等待原请求结果。</p>' : ""}<div class="row" style="flex-wrap:wrap">${Object.entries(
        repairLabels,
      )
        .map(
          ([operation, label]) =>
            `<button type="button" data-repair="${operation}" ${!state.device?.online || !state.device?.repairCapabilities?.includes(operation) || blocked || (operation === "restore_settings" && !snapshot) || (operation === "switch_route" && !state.device?.routeOptions?.length) ? "disabled" : ""}>${label}</button>`,
        )
        .join(
          "",
        )}</div>${!state.device?.repairCapabilities?.length ? '<p class="small">客户端尚未注册修复回调，修复按钮暂不可用。</p>' : ""}${
        snapshot
          ? `<label class="small">恢复目标快照<select id="repair-snapshot">${repairs
              .filter(
                (r) =>
                  r.device_id === state.device?.deviceId &&
                  r.result?.snapshotAvailable &&
                  [
                    "reconnect",
                    "restart_core",
                    "reapply_proxy",
                    "switch_route",
                  ].includes(r.operation),
              )
              .map(
                (r) =>
                  `<option value="${E(r.id)}">${E(repairLabels[r.operation])} · ${E(new Date(r.created).toLocaleString())}</option>`,
              )
              .join("")}</select></label>`
          : ""
      }${repairs.map((r) => `<section class="agent-editor-section"><div class="panel-head"><strong>${E(repairLabels[r.operation])}</strong><span class="badge">${E(r.status === "running" ? "执行及复查中" : states[r.status] || r.status)}</span></div><p>${E(r.reason)}</p>${r.target_route_label ? `<p>目标线路：${E(r.target_route_label)}</p>` : ""}<p class="small">${E(r.impact)} · ${E(new Date(r.created).toLocaleString())}</p>${r.result ? `<p>${E(r.result.summary)}</p>${r.operation === "switch_route" ? `<p>原线路：${r.result.originalRouteRestored ? "已恢复" : "未确认恢复"}</p>` : ""}<p class="small">复查：${r.result.verified ? "通过" : "未通过或未确认"} · 回滚：${E({ not_needed: "不需要", succeeded: "已完成", failed: "失败", not_attempted: "未执行" }[r.result.rollback] || r.result.rollback)}</p>` : ""}</section>`).join("")}`;
      root.innerHTML = `${consentMarkup}<p class="small">诊断仅在用户确认后执行。报告由本次会话 AI 与有权限的人工客服共享，最长保留 7 天。操作类需单独授权，不能使用查询授权执行操作。</p><p>${state.device ? (state.device.online ? "客户端在线" : "客户端离线") : "客户端尚未接入诊断能力"}</p><div class="row" style="flex-wrap:wrap">${(state.device?.capabilities || []).map((c) => `<button type="button" data-diagnostic="${E(c)}" ${state.device.online ? "" : "disabled"}>请求${E(labels[c] || c)}</button>`).join("")}</div>${repairMarkup}<h3>诊断记录</h3>${state.requests.map((r) => `<section class="agent-editor-section"><div class="panel-head"><strong>${E(labels[r.capability] || r.capability)}</strong><span class="badge">${E(states[r.status] || r.status)}</span></div><p>${E(r.reason)}</p><p class="small">${E(new Date(r.created).toLocaleString())}${r.finished ? " · 完成于 " + E(new Date(r.finished).toLocaleString()) : ""}</p>${r.error ? `<p class="error">${E(r.error)}</p>` : ""}${r.report ? `<details><summary>查看诊断报告</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${E(JSON.stringify(r.report, null, 2))}</pre></details>` : r.status === "succeeded" ? '<p class="small">报告保留期限已过</p>' : ""}</section>`).join("")}`;
      root.querySelectorAll("[data-repair]").forEach(
        (button) =>
          (button.onclick = async () => {
            button.disabled = true;
            try {
              await api(`/conversations/${conversationId}/assistance`, {
                method: "POST",
                body: JSON.stringify({
                  kind: "repair",
                  ...(button.dataset.repair === "switch_route"
                    ? {
                        targetRouteId:
                          root.querySelector("#repair-route")?.value,
                      }
                    : {}),
                  operation: button.dataset.repair,
                  reason: "客服建议：" + repairLabels[button.dataset.repair],
                  ...(button.dataset.repair === "restore_settings"
                    ? {
                        restoreRequestId:
                          root.querySelector("#repair-snapshot")?.value,
                      }
                    : {}),
                }),
              });
              await render();
            } catch (e) {
              toast(e.message);
            } finally {
              if (button.isConnected) button.disabled = false;
            }
          }),
      );
      root.querySelectorAll("[data-diagnostic]").forEach(
        (b) =>
          (b.onclick = async () => {
            b.disabled = true;
            try {
              await api(`/conversations/${conversationId}/assistance`, {
                method: "POST",
                body: JSON.stringify({
                  capability: b.dataset.diagnostic,
                  reason:
                    "客服请求排查当前问题：" + labels[b.dataset.diagnostic],
                }),
              });
              await render();
            } catch (e) {
              toast(e.message);
            } finally {
              if (b.isConnected) b.disabled = false;
            }
          }),
      );
    } catch (e) {
      if (!stopped)
        box.querySelector("#assistance-content").textContent = e.message;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(render, 4000);
  box.addEventListener("dialogclose", () => {
    stopped = true;
    clearInterval(timer);
  });
  render();
}
