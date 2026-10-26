import { teamNavigation } from "./team-navigation.js";
export function createServiceUI({ api, E, modal, toast, isActive }) {
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (error) {
      toast(error.message);
    }
  };
  const availability = { available: "可接待", away: "暂离", offline: "不接待" };
  let epoch = 0;
  const field = (id, label, value = "", type = "text", required = true) =>
    `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" value="${E(value)}" ${required ? "required" : ""}></div>`;
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
        `<div class="content service-page">${teamNavigation("teams")}${heading("团队管理", "按业务组织客服，管理成员接待状态和容量。", '<button id="new-team" class="primary">＋ 创建团队</button>')}<div class="grid">${teams.map((t) => `<article class="card team-card"><div class="row"><div class="feature-icon blue">♧</div><span class="badge neutral">${t.members.length} 位成员</span><button data-delete-team="${t.id}" class="quiet danger" aria-label="删除 ${E(t.name)}" style="margin-left:auto">×</button></div><h3>${E(t.name)}</h3><p>${E(t.description || "暂无说明")}</p><div class="team-members">${t.members.map((m) => `<div><span class="avatar">${E(m.name[0])}</span><span>${E(m.name)}</span><span class="small">${m.active ? availability[m.availability] : "已停用"} · ${m.workload}/${m.capacity}</span></div>`).join("") || '<span class="small">尚未添加成员</span>'}</div><div class="card-actions"><button data-edit-team="${t.id}">管理成员</button></div></article>`).join("")}</div>${teams.length ? "" : '<section class="panel empty"><strong>创建接待团队</strong><p>例如售前、售后和技术支持。为客服分组，统一维护成员与接待容量。</p></section>'}<section class="panel capacity-panel"><div class="panel-head"><h2>成员接待状态与容量</h2><span class="small">已分配且未结束会话 / 容量</span></div><div class="table-scroll"><table class="table"><thead><tr><th>成员</th><th>接待状态</th><th>工作量</th><th>操作</th></tr></thead><tbody>${members.map((m) => `<tr><td><strong>${E(m.name)}</strong></td><td><span class="badge ${m.active && m.availability === "available" ? "success" : "neutral"}">${m.active ? availability[m.availability] : "已停用"}</span></td><td>${m.workload} / ${m.capacity}</td><td><button class="quiet" data-capacity="${m.id}">调整</button></td></tr>`).join("")}</tbody></table></div></section><p class="small">团队用于接待分流，不构成独立的数据权限或租户。</p></div>`;
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
              "<p>仍有未结束会话的团队不能删除。</p>",
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
                  )}</select></div><p class="small">接待容量用于展示成员负载；会话由客服手动分配。</p>`,
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
    if (page !== "team-hours") return;
    const stored = await api("/team-hours");
    if (!isActive(page) || revision !== epoch) return;
    const { revision: version, ...draft } = stored;
    document.querySelector("#view").innerHTML =
      `<div class="content service-page">${teamNavigation("team-hours")}${heading("工作时间", "设置团队统一服务时段；已有会话和人工回复不受限制。", "")}<form id="hours-form"><div id="hours-form-content"></div><button class="primary" type="submit">保存工作时间</button></form></div>`;
    document.querySelector("#hours-form-content").innerHTML =
      `<section class="panel service-section"><div class="service-section-title"><div><h2>工作时间</h2><p class="small">关闭时间限制表示全天服务，跨午夜时段按开始日期计算。</p></div><label class="toggle-label"><input id="hours-enabled" type="checkbox" ${draft.enabled ? "checked" : ""}>启用限制</label></div>${field("hours-zone", "时区", draft.timeZone)}<label>服务日</label><div class="weekday-picker">${[
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
            `<label><input type="checkbox" data-weekday="${day}" ${draft.weekdays.includes(day) ? "checked" : ""}>周${label}</label>`,
        )
        .join(
          "",
        )}</div><div class="service-form-grid">${field("hours-start", "开始时间", draft.start, "time")}${field("hours-end", "结束时间", draft.end, "time")}</div><div class="field"><label for="hours-offline">非工作时间回复</label><textarea id="hours-offline">${E(draft.offlineMessage)}</textarea></div><p class="small">非工作时间不启用平台 AI 接待，消息仍会留在工作台，等待人工处理。</p></section>`;

    document.querySelector("#hours-form").onsubmit = safe(async (event) => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      try {
        await api("/team-hours", {
          method: "PUT",
          body: JSON.stringify({
            expectedRevision: version,
            value: {
              enabled: document.querySelector("#hours-enabled").checked,
              timeZone: document.querySelector("#hours-zone").value,
              weekdays: [
                ...document.querySelectorAll("[data-weekday]:checked"),
              ].map((e) => Number(e.dataset.weekday)),
              start: document.querySelector("#hours-start").value,
              end: document.querySelector("#hours-end").value,
              offlineMessage: document.querySelector("#hours-offline").value,
            },
          }),
        });
        toast("工作时间已保存");
        await render(page);
      } finally {
        button.disabled = false;
      }
    });
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
