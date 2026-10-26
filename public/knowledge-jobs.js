export function createKnowledgeJobsUI({
  api,
  E,
  modal,
  toast,
  refresh,
  isAvailable = () => true,
}) {
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (error) {
      toast(error.message);
    }
  };
  const names = {
    queued: "等待执行",
    running: "采集中",
    succeeded: "已完成",
    partial: "部分完成",
    failed: "失败",
    cancelled: "已取消",
  };
  async function open(collectionId) {
    const [sources, jobs] = await Promise.all([
      api("/knowledge/sources"),
      api("/knowledge/jobs"),
    ]);
    if (!isAvailable()) return;
    const rows = sources.filter((s) => s.collection_id === collectionId),
      ids = new Set(rows.map((s) => s.id));
    const o = modal(
      "网站采集与同步",
      `<p class="small">采集同一网站、指定路径内的静态页面，每次最多 30 页。定时同步默认关闭。失败任务最多尝试 3 次，重启可继续排队；同步不会自动删除本次未发现的旧页面。</p><div class="row"><button type="button" id="new-web-source" class="primary">＋ 添加网站来源</button><button type="button" id="refresh-web-jobs">刷新任务</button></div><div class="website-source-list">${rows.map((s) => `<article class="panel"><div class="panel-head"><div><h3>${E(s.name)}</h3><p class="small">${E(s.root_url)}</p></div><span class="badge neutral">${s.page_count} 页</span></div><p class="small">路径 ${E(s.path_prefix)} · 深度 ${s.depth} · 最多 ${s.max_pages} 页 · ${s.enabled ? "每 " + s.interval_minutes + " 分钟同步" : "仅手动同步"}</p><div class="row"><button type="button" data-web-run="${s.id}">立即采集</button><button type="button" data-web-edit="${s.id}">配置</button><button type="button" data-web-pages="${s.id}">已采集页面</button><button type="button" class="quiet danger" data-web-remove="${s.id}">移除来源</button></div></article>`).join("") || '<p class="small">当前知识库还没有网站采集来源。</p>'}</div><h3>最近采集任务</h3><div class="table-scroll"><table class="table"><thead><tr><th>来源 / 时间</th><th>状态 / 进度</th><th>说明</th><th>操作</th></tr></thead><tbody>${jobs
        .filter((j) => ids.has(j.source_id))
        .map(
          (j) =>
            `<tr><td>${E(j.source_name)}<div class="small">${new Date(j.created).toLocaleString("zh-CN")} · 第 ${j.attempts} 次尝试 · ${j.trigger === "schedule" ? "定时" : "手动"}</div></td><td><span class="badge ${j.status === "succeeded" ? "success" : "neutral"}">${names[j.status] || E(j.status)}</span><div class="small">${j.progress.imported !== undefined ? "已采集 " + j.progress.imported + " 页 / 更新 " + j.progress.changed + " 页" : "已访问 " + (j.progress.visited || 0) + " 页"}</div></td><td class="small">${E(j.error || "—")}${Array.isArray(j.progress.errors) && j.progress.errors.length ? `<details><summary>${j.progress.errors.length} 个页面失败</summary>${j.progress.errors.map((x) => `<p>${E(x.url)}<br>${E(x.error)}</p>`).join("")}</details>` : ""}</td><td>${["queued", "running"].includes(j.status) ? `<button type="button" data-web-cancel="${j.id}">取消</button>` : `<button type="button" data-web-retry="${j.id}">重新采集</button>`}</td></tr>`,
        )
        .join("")}</tbody></table></div>`,
      "关闭",
    );
    o.querySelector(".modal").classList.add("website-jobs-dialog");
    const reload = async () => {
      o.querySelector("[data-close]").click();
      await refresh();
      await open(collectionId);
    };
    o.querySelector("#refresh-web-jobs").onclick = safe(reload);
    o.querySelector("#new-web-source").onclick = safe(() =>
      edit(collectionId, null, reload),
    );
    o.querySelectorAll("[data-web-edit]").forEach(
      (b) =>
        (b.onclick = safe(() =>
          edit(
            collectionId,
            rows.find((s) => s.id === b.dataset.webEdit),
            reload,
          ),
        )),
    );
    o.querySelectorAll("[data-web-run]").forEach(
      (b) =>
        (b.onclick = safe(async () => {
          await api("/knowledge/sources/" + b.dataset.webRun + "/run", {
            method: "POST",
          });
          toast("采集任务已进入队列");
          await reload();
        })),
    );
    o.querySelectorAll("[data-web-cancel]").forEach(
      (b) =>
        (b.onclick = safe(async () => {
          await api("/knowledge/jobs/" + b.dataset.webCancel + "/cancel", {
            method: "POST",
          });
          await reload();
        })),
    );
    o.querySelectorAll("[data-web-retry]").forEach(
      (b) =>
        (b.onclick = safe(async () => {
          await api("/knowledge/jobs/" + b.dataset.webRetry + "/retry", {
            method: "POST",
          });
          await reload();
        })),
    );
    o.querySelectorAll("[data-web-remove]").forEach(
      (b) =>
        (b.onclick = () =>
          modal(
            "移除网站来源",
            "<p>移除该来源及其任务记录，已采集的知识文档会保留，并可单独编辑和删除。存在未完成任务时请先取消。</p>",
            "移除来源",
            async () => {
              await api("/knowledge/sources/" + b.dataset.webRemove, {
                method: "DELETE",
              });
              toast("来源已移除，知识文档保留");
              await reload();
            },
          )),
    );
    o.querySelectorAll("[data-web-pages]").forEach(
      (b) =>
        (b.onclick = safe(async () => {
          const pages = await api(
            "/knowledge/sources/" + b.dataset.webPages + "/pages",
          );
          modal(
            "已采集页面",
            pages
              .map(
                (p) =>
                  `<article><h3>${E(p.name)}</h3><a href="${E(p.url)}" target="_blank" rel="noopener noreferrer">${E(p.url)}</a><p class="small">最近同步 ${new Date(p.synced).toLocaleString("zh-CN")}</p></article>`,
              )
              .join("") || "<p>尚未采集页面。</p>",
            "关闭",
          );
        })),
    );
  }
  async function edit(collectionId, source, onSave) {
    const collections = await api("/knowledge/collections");
    const field = (name, label, value = "", type = "text") =>
      `<div class="field"><label for="web-${name}">${label}</label><input id="web-${name}" name="${name}" type="${type}" value="${E(value)}" required></div>`;
    const o = modal(
      source ? "配置网站来源" : "添加网站来源",
      `${field("name", "来源名称", source?.name || "")}<div class="field"><label for="web-collection">所属知识库</label><select id="web-collection" name="collectionId">${collections.map((c) => `<option value="${c.id}" ${c.id === collectionId ? "selected" : ""}>${E(c.name)}</option>`).join("")}</select></div>${field("url", "入口地址", source?.root_url || "", "url")}<div class="field"><label for="web-pathPrefix">路径范围（留空使用入口路径）</label><input id="web-pathPrefix" name="pathPrefix" value="${E(source?.path_prefix || "")}" placeholder="例如 /help；/ 表示整个网站"></div><div class="service-form-grid">${field("maxPages", "单次最多页面", source?.max_pages || 10, "number")}${field("depth", "链接深度", source?.depth ?? 2, "number")}</div><label class="row"><input type="checkbox" name="enabled" ${source?.enabled ? "checked" : ""}>启用定时同步</label>${field("intervalMinutes", "同步间隔（分钟）", source?.interval_minutes || 60, "number")}<p class="small">仅采集入口同源、路径范围内的静态正文，不执行 JavaScript。网站 origin 需加入服务器允许列表。保存配置后，使用“立即采集”开始首次任务。</p>`,
      "保存配置",
      async (b) => {
        await api(
          source ? "/knowledge/sources/" + source.id : "/knowledge/sources",
          {
            method: source ? "PUT" : "POST",
            body: JSON.stringify({
              ...b,
              collectionId: b.collectionId || collectionId,
              maxPages: Number(b.maxPages),
              depth: Number(b.depth),
              intervalMinutes: Number(b.intervalMinutes),
              enabled: !!b.enabled,
              expectedRevision: source?.revision,
            }),
          },
        );
        toast("来源配置已保存");
        await onSave();
      },
    );
    o.querySelector("#web-maxPages").min = 1;
    o.querySelector("#web-maxPages").max = 30;
    o.querySelector("#web-depth").min = 0;
    o.querySelector("#web-depth").max = 5;
    o.querySelector("#web-intervalMinutes").min = 15;
    o.querySelector("#web-intervalMinutes").max = 43200;
  }
  return { open };
}
