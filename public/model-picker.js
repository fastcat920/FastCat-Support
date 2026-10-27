export function createModelPicker({
  target,
  E,
  discover,
  installed = [],
  withDefaults = false,
  autoChatDefault = false,
}) {
  const selected = new Map();
  let remote = [],
    request = 0,
    chatDefaultTouched = false;
  target.innerHTML = `<section class="model-picker"><h3>选择模型</h3><p class="small">读取供应商模型后多选，或手动填写模型标识；可同时添加对话与 Embedding 模型。</p><div class="row"><button type="button" data-read-models>读取模型列表</button><span class="small" role="status" data-fetch-state></span></div><div class="service-form-grid"><label>模型类型<select data-model-type><option value="chat">对话模型</option><option value="embedding">Embedding 模型</option></select></label><label>搜索模型<input data-model-search placeholder="筛选已读取的模型" autocomplete="off"></label></div><div class="model-choices" data-model-choices></div><div class="model-manual row"><label>手动填写模型标识<input data-model-manual maxlength="200" placeholder="例如模型的 API 标识" autocomplete="off"></label><button type="button" data-add-model>加入选择</button></div><div class="model-selected" data-selected-models aria-live="polite"></div>${withDefaults ? '<div class="service-form-grid"><label>默认对话模型<select data-default-chat><option value="">保持现有设置</option></select></label><label>默认 Embedding 模型<select data-default-embedding><option value="">保持现有设置</option></select></label></div><p class="small">默认模型仅从本次选择中设置；保存后也可在页面顶部统一修改。</p>' : ""}</section>`;
  const q = (s) => target.querySelector(s),
    type = q("[data-model-type]"),
    search = q("[data-model-search]"),
    manual = q("[data-model-manual]");
  const key = (model, model_type) => model_type + ":" + model;
  const exists = (model, model_type) =>
    installed.some((m) => m.model === model && m.model_type === model_type);
  const status = (message) => (q("[data-fetch-state]").textContent = message);
  function draw() {
    q("[data-model-choices]").innerHTML = remote
      .filter(
        (m) =>
          m.suggestedType === type.value &&
          m.model.toLowerCase().includes(search.value.trim().toLowerCase()),
      )
      .map(
        (m) =>
          `<label class="retrieval-checkbox"><input type="checkbox" data-model-choice="${E(m.model)}" ${selected.has(key(m.model, type.value)) ? "checked" : ""} ${exists(m.model, type.value) ? "disabled" : ""}><span>${E(m.model)}${exists(m.model, type.value) ? "（已添加）" : ""}</span></label>`,
      )
      .join("");
    q("[data-model-choices]")
      .querySelectorAll("[data-model-choice]")
      .forEach(
        (input) =>
          (input.onchange = () => {
            const model = input.dataset.modelChoice,
              model_type = type.value;
            if (input.checked)
              selected.set(key(model, model_type), { model, model_type });
            else selected.delete(key(model, model_type));
            draw();
          }),
      );
    q("[data-selected-models]").innerHTML =
      `<p class="small">已选择 ${selected.size} 个模型</p>` +
      [...selected.entries()]
        .map(
          ([id, m]) =>
            `<button type="button" data-remove-model="${E(id)}" aria-label="移除 ${E(m.model)}">${E(m.model)} · ${m.model_type === "chat" ? "对话" : "Embedding"} ×</button>`,
        )
        .join("");
    q("[data-selected-models]")
      .querySelectorAll("[data-remove-model]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            selected.delete(b.dataset.removeModel);
            draw();
          }),
      );
    if (withDefaults)
      for (const t of ["chat", "embedding"]) {
        const el = q("[data-default-" + t + "]"),
          previous = el.value,
          rows = [...selected.values()].filter((m) => m.model_type === t);
        el.innerHTML =
          '<option value="">保持现有设置</option>' +
          rows
            .map((m) => `<option value="${E(m.model)}">${E(m.model)}</option>`)
            .join("");
        el.value = rows.some((m) => m.model === previous) ? previous : "";
        if (
          t === "chat" &&
          autoChatDefault &&
          !chatDefaultTouched &&
          rows.length
        )
          el.value = previous || rows[0].model;
      }
  }
  function addManual() {
    const model = manual.value.trim();
    if (!model) return;
    if (model.length > 200) throw Error("模型标识最多 200 字符");
    if (exists(model, type.value)) throw Error("此模型已添加");
    selected.set(key(model, type.value), { model, model_type: type.value });
    manual.value = "";
    draw();
  }
  function safeAdd() {
    try {
      addManual();
      status("");
    } catch (e) {
      status(e.message);
    }
  }
  async function load() {
    const seq = ++request,
      button = q("[data-read-models]");
    button.disabled = true;
    remote = [];
    draw();
    status("正在读取模型列表…");
    try {
      const result = await discover();
      if (seq !== request || !target.isConnected) return;
      remote = result.models;
      status(
        `读取到 ${remote.length} 个模型，模型用途由名称推测，可切换类型或手动补充。`,
      );
      draw();
    } catch (e) {
      if (seq === request && target.isConnected)
        status("读取失败，仍可手动添加：" + e.message);
    } finally {
      if (target.isConnected && seq === request) button.disabled = false;
    }
  }
  q("[data-read-models]").onclick = load;
  q("[data-add-model]").onclick = safeAdd;
  manual.onkeydown = (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      safeAdd();
    }
  };
  type.onchange = draw;
  search.oninput = draw;
  if (withDefaults)
    q("[data-default-chat]").onchange = () => (chatDefaultTouched = true);
  draw();
  return {
    load,
    invalidate() {
      request++;
      remote = [];
      q("[data-read-models]").disabled = false;
      status("连接配置已变化，请重新读取模型列表。");
      draw();
    },
    models() {
      addManual();
      return [...selected.values()];
    },
    defaults() {
      return withDefaults
        ? {
            chat_model: q("[data-default-chat]").value || null,
            embedding_model: q("[data-default-embedding]").value || null,
          }
        : {};
    },
  };
}
