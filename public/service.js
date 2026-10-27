import { teamNavigation } from "./team-navigation.js";
export function createServiceUI({ api, E, modal, toast, isActive }) {
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (error) {
      toast(error.message);
    }
  };
  let epoch = 0;
  const field = (id, label, value = "", type = "text", required = true) =>
    `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" value="${E(value)}" ${required ? "required" : ""}></div>`;
  const heading = (title, description, button) =>
    `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${button}</div>`;
  async function render(page) {
    const revision = ++epoch;
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
  return { render };
}
