export function createServiceUI({
  api,
  E,
  modal,
  toast,
  isActive,
  openConversation,
}) {
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (error) {
      toast(error.message);
    }
  };
  const availability = { available: "可接待", away: "暂离", offline: "不接待" },
    priority = { low: "低", normal: "普通", high: "高", urgent: "紧急" };
  let epoch = 0,
    view = "policy";
  const field = (id, label, value = "", type = "text", required = true) =>
    `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" value="${E(value)}" ${required ? "required" : ""}></div>`;
  const opts = (rows, selected, empty = "未指定") =>
    `<option value="">${empty}</option>` +
    rows
      .map(
        (r) =>
          `<option value="${r.id}" ${r.id === selected ? "selected" : ""}>${E(r.name)}</option>`,
      )
      .join("");
  const heading = (title, description, button) =>
    `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${button}</div>`;
  async function render(page) {
    const revision = ++epoch;
    if (page === "teams") {
      const [teams, members] = await Promise.all([
        api("/teams"),
        api("/members"),
      ]);
      if (!isActive(page) || revision !== epoch) return;
      document.querySelector("#view").innerHTML =
        `<div class="content service-page">${heading("接待团队", "按业务组织客服，结合接待状态和容量进行自动分配。", '<button id="new-team" class="primary">＋ 创建团队</button>')}<div class="grid">${teams.map((t) => `<article class="card team-card"><div class="row"><div class="feature-icon blue">♧</div><span class="badge neutral">${t.members.length} 位成员</span><button data-delete-team="${t.id}" class="quiet danger" aria-label="删除 ${E(t.name)}" style="margin-left:auto">×</button></div><h3>${E(t.name)}</h3><p>${E(t.description || "暂无说明")}</p><div class="team-members">${t.members.map((m) => `<div><span class="avatar">${E(m.name[0])}</span><span>${E(m.name)}</span><span class="small">${m.active ? availability[m.availability] : "已停用"} · ${m.workload}/${m.capacity}</span></div>`).join("") || '<span class="small">尚未添加成员</span>'}</div><div class="card-actions"><button data-edit-team="${t.id}">管理成员</button></div></article>`).join("")}</div>${teams.length ? "" : '<section class="panel empty"><strong>创建接待团队</strong><p>例如售前、售后和技术支持。在自动接待中为不同问题选择团队。</p></section>'}<section class="panel capacity-panel"><div class="panel-head"><h2>成员接待状态与容量</h2><span class="small">已分配且未结束会话 / 容量</span></div><div class="table-scroll"><table class="table"><thead><tr><th>成员</th><th>接待状态</th><th>工作量</th><th>操作</th></tr></thead><tbody>${members.map((m) => `<tr><td><strong>${E(m.name)}</strong></td><td><span class="badge ${m.active && m.availability === "available" ? "success" : "neutral"}">${m.active ? availability[m.availability] : "已停用"}</span></td><td>${m.workload} / ${m.capacity}</td><td><button class="quiet" data-capacity="${m.id}">调整</button></td></tr>`).join("")}</tbody></table></div></section><p class="small">团队用于接待分流，不构成独立的数据权限或租户。</p></div>`;
      document.querySelector("#new-team").onclick = () =>
        teamDialog(null, members);
      document.querySelectorAll("[data-edit-team]").forEach(
        (b) =>
          (b.onclick = () =>
            teamDialog(
              teams.find((t) => t.id === b.dataset.editTeam),
              members,
            )),
      );
      document.querySelectorAll("[data-delete-team]").forEach(
        (b) =>
          (b.onclick = () =>
            modal(
              "删除团队",
              "<p>被接待规则使用或仍有未结束会话的团队不能删除。</p>",
              "删除",
              async () => {
                await api("/teams/" + b.dataset.deleteTeam, {
                  method: "DELETE",
                });
                render(page);
              },
            )),
      );
      document.querySelectorAll("[data-capacity]").forEach(
        (b) =>
          (b.onclick = () => {
            const m = members.find((m) => m.id === b.dataset.capacity);
            modal(
              "调整接待 · " + m.name,
              field("capacity", "同时处理容量", m.capacity, "number") +
                `<div class="field"><label for="availability">接待状态</label><select id="availability" name="availability">${Object.entries(
                  availability,
                )
                  .map(
                    ([key, label]) =>
                      `<option value="${key}" ${key === m.availability ? "selected" : ""}>${label}</option>`,
                  )
                  .join(
                    "",
                  )}</select></div><p class="small">自动分配仅选择已启用、可接待且未达到容量的成员。</p>`,
              "保存",
              async (data) => {
                await api("/service/members/" + m.id, {
                  method: "PATCH",
                  body: JSON.stringify({
                    ...data,
                    capacity: Number(data.capacity),
                  }),
                });
                toast("接待容量已更新");
                render(page);
              },
            );
          }),
      );
      return;
    }
    const [stored, teams, agents, tags] = await Promise.all([
      api("/service/settings"),
      api("/teams"),
      api("/resources?kind=agent"),
      api("/tags"),
    ]);
    if (!isActive(page) || revision !== epoch) return;
    const { revision: version, modelConfigured, ...config } = stored;
    let draft = structuredClone(config);
    draw();
    function draw() {
      document.querySelector("#view").innerHTML =
        `<div class="content service-page">${heading("自动接待", "配置欢迎语、团队分流、AI 答复和人工兜底。", view !== "runs" ? '<button class="primary" id="save-service">保存设置</button>' : '<button id="refresh-runs">刷新记录</button>')}<div class="management-tabs"><button data-service-tab="policy" class="${view === "policy" ? "active" : ""}">接待策略</button><button data-service-tab="hours" class="${view === "hours" ? "active" : ""}">工作时间</button><button data-service-tab="runs" class="${view === "runs" ? "active" : ""}">自动答复记录</button></div><div id="service-content"></div></div>`;
      document.querySelectorAll("[data-service-tab]").forEach(
        (b) =>
          (b.onclick = () => {
            collect();
            view = b.dataset.serviceTab;
            draw();
          }),
      );
      document.querySelector("#save-service")?.addEventListener(
        "click",
        safe(async (e) => {
          collect();
          e.target.disabled = true;
          try {
            await api("/service/settings", {
              method: "PUT",
              body: JSON.stringify({ value: draft, expectedRevision: version }),
            });
            toast("接待设置已保存");
            await render(page);
          } finally {
            e.target.disabled = false;
          }
        }),
      );
      document
        .querySelector("#refresh-runs")
        ?.addEventListener("click", () => draw());
      const content = document.querySelector("#service-content");
      if (view === "runs") {
        loadRuns(content);
        return;
      }
      if (view === "policy") {
        content.innerHTML = `<section class="panel service-section"><div class="service-section-title"><div><h2>自动接待</h2><p class="small">默认关闭。开启后，在新会话中应用欢迎语与接待规则。</p></div><label class="toggle-label"><input id="service-enabled" type="checkbox" ${draft.enabled ? "checked" : ""}>启用</label></div><div class="field"><label for="service-welcome">欢迎语</label><textarea id="service-welcome" maxlength="3000">${E(draft.welcomeMessage)}</textarea></div><div class="service-form-grid"><div class="field"><label for="service-assignment">人工分配方式</label><select id="service-assignment"><option value="manual" ${draft.assignment.mode === "manual" ? "selected" : ""}>手动分配</option><option value="least_busy" ${draft.assignment.mode === "least_busy" ? "selected" : ""}>优先空闲 · 按未结束会话数量</option><option value="round_robin" ${draft.assignment.mode === "round_robin" ? "selected" : ""}>轮询分配</option></select></div><div class="field"><label for="service-team">默认接待团队</label><select id="service-team">${opts(teams, draft.assignment.teamId, "全部成员")}</select></div></div><p class="small">达到接待容量、暂离或不接待的成员不参与自动分配。无可用成员时留在未分配队列。</p></section><section class="panel service-section"><div class="service-section-title"><div><h2>默认 AI 答复</h2><p class="small">生成中的内容可实时查看，人工接管后停止自动回复。</p></div><label class="toggle-label"><input id="service-ai" type="checkbox" ${draft.ai.enabled ? "checked" : ""}>启用</label></div>${!modelConfigured ? '<div class="notice">模型服务尚未配置。自动答复失败时会按兜底文案转人工。</div>' : ""}<div class="field"><label for="service-agent">默认智能体</label><select id="service-agent">${opts(agents, draft.ai.agentId, "默认客服助手")}</select></div>${field("service-keywords", "转人工关键词", draft.ai.handoffKeywords.join("，"))}<div class="field"><label for="service-fallback">失败兜底回复</label><textarea id="service-fallback">${E(draft.ai.fallbackMessage)}</textarea></div></section><section class="panel service-section"><div class="panel-head"><div><h2>关键词分流规则</h2><p class="small">按顺序匹配第一条访客消息。首条命中生效，不覆盖人工分配。</p></div><button id="new-routing-rule">＋ 添加规则</button></div><div id="routing-rules">${draft.rules.map((r, i) => `<div class="routing-rule"><span class="rule-order">${i + 1}</span><div><strong>${E(r.name)}</strong><div class="small">${E(r.keywords.join("、"))} → ${E(teams.find((t) => t.id === r.teamId)?.name || "默认团队")} · ${r.mode === "ai" ? "AI 答复" : "人工服务"}</div></div><span class="badge ${r.enabled ? "success" : "neutral"}">${r.enabled ? "启用" : "停用"}</span><div class="row"><button class="quiet" data-rule-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="上移 ${E(r.name)}">↑</button><button class="quiet" data-rule-down="${i}" ${i === draft.rules.length - 1 ? "disabled" : ""} aria-label="下移 ${E(r.name)}">↓</button><button class="quiet" data-rule-edit="${i}">编辑</button><button class="quiet danger" data-rule-delete="${i}" aria-label="删除规则 ${E(r.name)}">×</button></div></div>`).join("") || '<div class="empty"><strong>暂无分流规则</strong><p>可按退款、物流等关键词分配团队并标记优先级。</p></div>'}</div></section><p class="small">保存设置会停止当前正在生成的自动答复，已有会话由人工继续处理。</p>`;
        content.querySelector("#new-routing-rule").onclick = () => {
          collect();
          ruleDialog();
        };
        content.querySelectorAll("[data-rule-edit]").forEach(
          (b) =>
            (b.onclick = () => {
              collect();
              ruleDialog(Number(b.dataset.ruleEdit));
            }),
        );
        content.querySelectorAll("[data-rule-delete]").forEach(
          (b) =>
            (b.onclick = () => {
              collect();
              draft.rules.splice(Number(b.dataset.ruleDelete), 1);
              draw();
            }),
        );
        for (const [key, direction] of [
          ["up", -1],
          ["down", 1],
        ])
          content.querySelectorAll("[data-rule-" + key + "]").forEach(
            (b) =>
              (b.onclick = () => {
                collect();
                const index = Number(
                  b.dataset[key === "up" ? "ruleUp" : "ruleDown"],
                );
                [draft.rules[index], draft.rules[index + direction]] = [
                  draft.rules[index + direction],
                  draft.rules[index],
                ];
                draw();
              }),
          );
        return;
      }
      content.innerHTML = `<section class="panel service-section"><div class="service-section-title"><div><h2>工作时间</h2><p class="small">关闭时间限制表示全天服务，跨午夜时段按开始日期计算。</p></div><label class="toggle-label"><input id="hours-enabled" type="checkbox" ${draft.hours.enabled ? "checked" : ""}>启用限制</label></div>${field("hours-zone", "时区", draft.hours.timeZone)}<label>服务日</label><div class="weekday-picker">${[
        [1, "一"],
        [2, "二"],
        [3, "三"],
        [4, "四"],
        [5, "五"],
        [6, "六"],
        [0, "日"],
      ]
        .map(
          ([day, label]) =>
            `<label><input type="checkbox" data-weekday="${day}" ${draft.hours.weekdays.includes(day) ? "checked" : ""}>周${label}</label>`,
        )
        .join(
          "",
        )}</div><div class="service-form-grid">${field("hours-start", "开始时间", draft.hours.start, "time")}${field("hours-end", "结束时间", draft.hours.end, "time")}</div><div class="field"><label for="hours-offline">非工作时间回复</label><textarea id="hours-offline">${E(draft.hours.offlineMessage)}</textarea></div><p class="small">非工作时间不自动分配或启用 AI，消息仍会留在工作台，等待人工处理。</p></section>`;
    }
    function collect() {
      if (document.querySelector("#service-enabled")) {
        draft.enabled = document.querySelector("#service-enabled").checked;
        draft.welcomeMessage = document.querySelector("#service-welcome").value;
        draft.assignment = {
          mode: document.querySelector("#service-assignment").value,
          teamId: document.querySelector("#service-team").value,
        };
        draft.ai = {
          enabled: document.querySelector("#service-ai").checked,
          agentId: document.querySelector("#service-agent").value,
          handoffKeywords: document
            .querySelector("#service-keywords")
            .value.split(/[,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
          fallbackMessage: document.querySelector("#service-fallback").value,
        };
      }
      if (document.querySelector("#hours-enabled"))
        draft.hours = {
          enabled: document.querySelector("#hours-enabled").checked,
          timeZone: document.querySelector("#hours-zone").value,
          weekdays: [
            ...document.querySelectorAll("[data-weekday]:checked"),
          ].map((e) => Number(e.dataset.weekday)),
          start: document.querySelector("#hours-start").value,
          end: document.querySelector("#hours-end").value,
          offlineMessage: document.querySelector("#hours-offline").value,
        };
    }
    function ruleDialog(index) {
      const r =
        index === undefined
          ? {
              id: crypto.randomUUID(),
              name: "",
              enabled: true,
              keywords: [],
              teamId: "",
              priority: "normal",
              tagIds: [],
              mode: "human",
              agentId: "",
            }
          : draft.rules[index];
      const o = modal(
        index === undefined ? "添加分流规则" : "编辑分流规则",
        field("rule-name", "规则名称", r.name) +
          field("rule-keywords", "命中任一关键词", r.keywords.join("，")) +
          `<div class="service-form-grid"><div class="field"><label for="rule-team">接待团队</label><select id="rule-team" name="teamId">${opts(teams, r.teamId, "使用默认团队")}</select></div><div class="field"><label for="rule-priority">优先级</label><select id="rule-priority" name="priority">${Object.entries(
            priority,
          )
            .map(
              ([k, n]) =>
                `<option value="${k}" ${r.priority === k ? "selected" : ""}>${n}</option>`,
            )
            .join(
              "",
            )}</select></div></div><div class="field"><label for="rule-mode">处理方式</label><select id="rule-mode" name="mode"><option value="human" ${r.mode === "human" ? "selected" : ""}>人工服务</option><option value="ai" ${r.mode === "ai" ? "selected" : ""}>AI 答复</option></select></div><div class="field"><label for="rule-agent">智能体</label><select id="rule-agent" name="agentId">${opts(agents, r.agentId, "使用默认智能体")}</select></div><label>附加标签</label><div class="tag-picker">${tags.map((t) => `<label><input type="checkbox" class="switch" data-rule-tag="${t.id}" ${r.tagIds.includes(t.id) ? "checked" : ""}><span class="tag-chip ${t.color}">${E(t.name)}</span></label>`).join("")}</div><label class="row small"><input name="enabled" class="switch" type="checkbox" ${r.enabled ? "checked" : ""}>启用规则</label>`,
        "应用到草稿",
        async (b) => {
          const keywords = b["rule-keywords"]
            .split(/[,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (!keywords.length) throw Error("至少填写一个关键词");
          const rule = {
            ...r,
            name: b["rule-name"],
            enabled: !!b.enabled,
            keywords,
            teamId: b.teamId,
            priority: b.priority,
            mode: b.mode,
            agentId: b.agentId,
            tagIds: [...o.querySelectorAll("[data-rule-tag]:checked")].map(
              (e) => e.dataset.ruleTag,
            ),
          };
          if (index === undefined) draft.rules.push(rule);
          else draft.rules[index] = rule;
          draw();
          toast("规则已应用，请保存设置");
        },
      );
    }
    async function loadRuns(container) {
      try {
        const rows = await api("/service/runs");
        if (!container.isConnected) return;
        const names = {
          queued: "排队中",
          running: "生成中",
          succeeded: "成功",
          failed: "失败转人工",
          cancelled: "已取消",
          skipped: "已跳过",
          interrupted: "服务中断",
        };
        container.innerHTML = `<section class="panel"><div class="table-scroll"><table class="table"><thead><tr><th>访客</th><th>状态</th><th>说明</th><th>时间</th><th>操作</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${E(r.name)}</td><td><span class="badge ${r.status === "succeeded" ? "success" : "neutral"}">${names[r.status] || r.status}</span></td><td class="small">${E(r.error || "—")}</td><td class="small">${new Date(r.created).toLocaleString("zh-CN")}</td><td><button class="quiet" data-auto-conversation="${r.conversation_id}">查看会话 →</button></td></tr>`).join("")}</tbody></table></div>${rows.length ? "" : '<div class="empty"><strong>暂无自动答复记录</strong><p>启用自动接待后，新会话的生成结果会保存在这里。</p></div>'}</section>`;
        container
          .querySelectorAll("[data-auto-conversation]")
          .forEach(
            (b) =>
              (b.onclick = () => openConversation(b.dataset.autoConversation)),
          );
      } catch (error) {
        toast(error.message);
      }
    }
  }
  function teamDialog(team, members) {
    const o = modal(
      team ? "编辑接待团队" : "创建接待团队",
      field("name", "团队名称", team?.name || "") +
        field("description", "说明", team?.description || "", "text", false) +
        `<label>团队成员</label><div class="team-member-picker">${members.map((m) => `<label><input class="switch" type="checkbox" data-team-member="${m.id}" ${team?.members.some((v) => v.id === m.id) ? "checked" : ""}><span>${E(m.name)}</span><span class="small">${m.active ? availability[m.availability] : "已停用"}</span></label>`).join("")}</div>`,
      "保存",
      async (b) => {
        await api(team ? "/teams/" + team.id : "/teams", {
          method: team ? "PATCH" : "POST",
          body: JSON.stringify({
            ...b,
            memberIds: [
              ...o.querySelectorAll("[data-team-member]:checked"),
            ].map((e) => e.dataset.teamMember),
          }),
        });
        toast("团队已保存");
        render("teams");
      },
    );
  }
  return { render };
}
