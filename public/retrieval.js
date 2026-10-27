export function createRetrievalUI({
  api,
  E,
  modal,
  toast,
  isAdmin = () => false,
  onChange = () => {},
}) {
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (error) {
      toast(error.message);
    }
  };
  const label = {
    bm25: "关键词 BM25",
    semantic: "向量语义",
    hybrid: "混合召回 RRF",
    configured: "知识库配置",
  };
  const state = {
    queued: "等待执行",
    running: "正在建立",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  const field = (name, text, value, type = "text") =>
    `<div class="field"><label>${text}<input name="${name}" type="${type}" value="${E(value ?? "")}"></label></div>`;
  const snapshot = (id) => api("/knowledge/retrieval/collections/" + id);
  async function configure(collection) {
    const [{ config }, models] = await Promise.all([
      snapshot(collection.id),
      api("/ai/models"),
    ]);
    const options = models.filter((m) => m.model_type === "embedding");
    modal(
      "检索配置 · " + collection.name,
      `<p class="small">关键词模式沿用现有检索，不调用 embedding。语义或混合模式会将知识分块和查询发送至你选择的供应商；需要先建立完整索引。</p><div class="field"><label>默认检索模式<select name="mode">${["bm25", "semantic", "hybrid"].map((mode) => `<option value="${mode}" ${mode === config.mode ? "selected" : ""}>${label[mode]}</option>`).join("")}</select></label></div><div class="field"><label>Embedding 模型<select name="model_id"><option value="">继承默认 embedding 模型</option>${options.map((m) => `<option value="${m.id}" ${config.configured_model_id === m.id ? "selected" : ""}>${E(m.provider_name)} / ${E(m.name)}${m.enabled && m.provider_enabled ? "" : "（已停用）"}</option>`).join("")}</select></label></div><p class="small">若没有候选项，请先在模型管理的本地模型目录添加 embedding 模型。</p><label class="retrieval-checkbox"><input type="checkbox" name="auto_index" ${config.auto_index ? "checked" : ""}> 知识更新后自动补充索引（每 30 秒检查）</label><label class="retrieval-checkbox"><input type="checkbox" name="expand_query" ${config.expand_query ? "checked" : ""}> 查询扩展：额外调用默认对话模型，生成最多两个改写问题</label><label class="retrieval-checkbox"><input type="checkbox" name="build"> 保存后建立 / 更新索引</label><p class="small">当前 ${config.indexed}/${config.total} 个分块有有效向量。更换模型或维度需要重新索引；未就绪时不会伪装成语义检索成功。</p>${config.error ? `<p class="error">${E(config.error)}</p>` : ""}`,
      "保存",
      async (b) => {
        await api("/knowledge/retrieval/collections/" + collection.id, {
          method: "PUT",
          body: JSON.stringify({
            model_id: b.model_id || null,
            mode: b.mode,
            auto_index: !!b.auto_index,
            expand_query: !!b.expand_query,
            expectedRevision: config.revision,
          }),
        });
        onChange();
        if (b.build)
          await api(
            "/knowledge/retrieval/collections/" + collection.id + "/index",
            { method: "POST" },
          );
        if (b.build) onChange();
        toast(b.build ? "配置已保存，索引任务已入队" : "检索配置已保存");
      },
    );
  }
  async function jobs(collection) {
    const o = modal(
      "向量索引 · " + collection.name,
      '<div id="embedding-status"></div><button type="button" id="embedding-refresh">刷新</button>',
      "关闭",
    );
    const load = async () => {
      const { config, jobs } = await snapshot(collection.id);
      onChange();
      const target = o.querySelector("#embedding-status");
      if (!target) return;
      target.innerHTML = `<p><strong>${config.indexed} / ${config.total}</strong> 个分块有效 · 待处理 ${config.pending}</p>${config.error ? `<p class="error">${E(config.error)}</p>` : ""}${isAdmin() ? '<button type="button" id="embedding-build">按已保存配置建立 / 更新索引</button>' : ""}<p class="small">保留成功批次；失败最多尝试 3 次。取消或配置变化后停止后续请求，已发出的供应商请求可能仍产生用量。</p>${jobs.map((j) => `<article class="panel"><strong>${state[j.status] || E(j.status)} · ${j.done}/${j.total}</strong><p class="small">尝试 ${j.attempts} 次 · ${E(new Date(j.created).toLocaleString())}</p>${j.error ? `<p class="small">${E(j.error)}</p>` : ""}${isAdmin() && ["queued", "running"].includes(j.status) ? `<button type="button" data-cancel-index="${j.id}">取消</button>` : ""}</article>`).join("") || '<p class="small">暂无索引任务</p>'}`;
      target.querySelector("#embedding-build")?.addEventListener(
        "click",
        safe(async () => {
          await api(
            "/knowledge/retrieval/collections/" + collection.id + "/index",
            { method: "POST" },
          );
          await load();
        }),
      );
      target.querySelectorAll("[data-cancel-index]").forEach(
        (b) =>
          (b.onclick = safe(async () => {
            await api(
              "/knowledge/retrieval/jobs/" + b.dataset.cancelIndex + "/cancel",
              { method: "POST" },
            );
            await load();
          })),
      );
    };
    o.querySelector("#embedding-refresh").onclick = safe(load);
    await load();
  }
  async function test(collection) {
    const { config } = await snapshot(collection.id);
    const o = modal(
      "检索测试 · " + collection.name,
      `${field("question", "测试问题", "")}<div class="field"><label>检索模式<select name="mode">${["bm25", "semantic", "hybrid"].map((m) => `<option value="${m}" ${m === config.mode ? "selected" : ""}>${label[m]}</option>`).join("")}</select></label></div>${field("limit", "返回条数（1–50）", 8, "number")}<div class="field"><label>补充改写问题（可选，最多两行）<textarea name="variants" rows="2"></textarea></label></div><label class="retrieval-checkbox"><input name="expand" type="checkbox" ${config.expand_query ? "checked" : ""}> 使用默认对话模型自动扩展问题（额外调用模型）</label><p class="small">有效向量 ${config.indexed}/${config.total}。语义检索需先建立索引；关键词模式始终可以独立测试。</p><button type="button" class="primary" id="run-vector-search">检索</button><div id="vector-results"></div>`,
      "关闭",
    );
    o.querySelector("#run-vector-search").onclick = safe(async (e) => {
      const form = o.querySelector("form"),
        out = o.querySelector("#vector-results");
      e.target.disabled = true;
      try {
        const result = await api("/knowledge/retrieval/search", {
          method: "POST",
          body: JSON.stringify({
            query: form.elements.question.value,
            mode: form.elements.mode.value,
            limit: Number(form.elements.limit.value),
            collectionIds: [collection.id],
            variants: form.elements.variants.value
              .split("\n")
              .map((q) => q.trim())
              .filter(Boolean),
            expand: form.elements.expand.checked,
          }),
        });
        out.innerHTML = `<p class="small">${label[result.metadata.mode] || E(result.metadata.mode)} · ${result.metadata.elapsedMs} ms · ${result.results.length} 条命中</p><p class="small">问题变体：${result.metadata.queryVariants.map(E).join(" / ")}</p>${result.metadata.warnings.map((w) => `<p class="notice">${E(w)}</p>`).join("")}${result.results.map((r, i) => `<article class="retrieval-hit"><div class="row"><span class="badge">${i + 1}</span><strong>${E(r.name)}</strong><span class="small">分块 ${r.position + 1} · 得分 ${E(r.score)}</span></div><p class="small">${r.ranks.map((rank) => `${rank.kind === "semantic" ? "语义" : rank.kind === "keyword" ? "关键词" : E(rank.kind)} #${rank.rank}`).join(" · ")}${r.rrfScore ? " · RRF " + Number(r.rrfScore).toFixed(6) : ""}</p><p>${E(r.description)}</p></article>`).join("") || "<p>没有相关内容</p>"}`;
      } catch (error) {
        out.innerHTML = `<p class="error">${E(error.message)}</p>`;
      } finally {
        e.target.disabled = false;
      }
    });
  }
  return { configure, jobs, test };
}
