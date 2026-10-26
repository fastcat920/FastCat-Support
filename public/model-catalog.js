export function createModelCatalogUI({ api, E, modal, toast }) {
  async function add(providerId, onSaved = async () => {}) {
    const [providers, installed] = await Promise.all([
      api("/ai/providers"),
      api("/ai/models"),
    ]);
    if (!providers.length) return toast("请先添加供应商");
    const selected = new Map();
    let remote = [],
      request = 0;
    const o = modal(
      "添加模型",
      `<div class="field"><label>供应商<select name="provider_id">${providers.map((p) => `<option value="${p.id}">${E(p.name)}</option>`).join("")}</select></label></div><div class="field"><label>模型类型<select name="model_type"><option value="chat">对话模型</option><option value="embedding">Embedding 模型</option></select></label></div><div class="field"><label>搜索或手动输入模型标识<input name="model" autocomplete="off" placeholder="输入模型标识，按回车加入待添加列表"></label></div><button type="button" id="queue-model">加入待添加</button><div id="selected-models" class="small" aria-live="polite"></div><p id="model-fetch-state" class="small" role="status"></p><button type="button" id="refresh-model-list">重新读取</button><div id="model-choices" class="model-choices"></div><p class="small">可多选后一次保存。读取失败可手动添加；名称和维度可在保存后配置。</p>`,
      "添加所选模型",
      async (b) => {
        if (b.model.trim()) queue();
        if (!selected.size) throw Error("请先选择或输入模型");
        await api("/ai/models/batch", {
          method: "POST",
          body: JSON.stringify({
            provider_id: provider.value,
            models: [...selected.values()],
          }),
        });
        toast(`已添加 ${selected.size} 个模型`);
        await onSaved();
      },
    );
    const provider = o.querySelector("[name=provider_id]"),
      type = o.querySelector("[name=model_type]"),
      input = o.querySelector("[name=model]");
    provider.value = providerId || providers[0].id;
    const key = (m, t) => t + ":" + m;
    const exists = (m, t) =>
      installed.some(
        (x) =>
          x.provider_id === provider.value &&
          x.model === m &&
          x.model_type === t,
      );
    function draw() {
      const pending = o.querySelector("#selected-models");
      pending.replaceChildren(
        document.createTextNode(`待添加 ${selected.size} 个：`),
      );
      for (const [k, m] of selected) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = m.model + " ×";
        remove.setAttribute("aria-label", "移除待添加模型 " + m.model);
        remove.onclick = () => {
          selected.delete(k);
          draw();
        };
        pending.append(remove);
      }
      const list = o.querySelector("#model-choices");
      list.replaceChildren();
      for (const m of remote.filter(
        (m) =>
          m.suggestedType === type.value &&
          m.model.toLowerCase().includes(input.value.trim().toLowerCase()),
      )) {
        const label = document.createElement("label");
        label.className = "retrieval-checkbox";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(key(m.model, type.value));
        checkbox.disabled = exists(m.model, type.value);
        const t = type.value;
        checkbox.onchange = () => {
          if (checkbox.checked)
            selected.set(key(m.model, t), { model: m.model, model_type: t });
          else selected.delete(key(m.model, t));
          draw();
        };
        label.append(
          checkbox,
          document.createTextNode(
            m.model + (checkbox.disabled ? "（已添加）" : ""),
          ),
        );
        list.append(label);
      }
    }
    function queue() {
      const m = input.value.trim();
      if (!m) return;
      if (m.length > 200) throw Error("模型标识最多 200 字符");
      if (exists(m, type.value)) throw Error("此模型已添加");
      selected.set(key(m, type.value), { model: m, model_type: type.value });
      input.value = "";
      draw();
    }
    async function load() {
      const seq = ++request,
        p = provider.value;
      remote = [];
      draw();
      const status = o.querySelector("#model-fetch-state");
      status.textContent = "正在读取供应商模型列表…";
      try {
        const result = await api("/ai/providers/" + p + "/models/discover", {
          method: "POST",
        });
        if (seq !== request || !o.isConnected) return;
        remote = result.models;
        status.textContent = `读取到 ${remote.length} 个模型；类型由名称推测，请核对。`;
        draw();
      } catch (e) {
        if (seq === request)
          status.textContent = "读取失败，可手动添加：" + e.message;
      }
    }
    o.querySelector("#queue-model").onclick = safe(queue);
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        safe(queue)();
      }
    };
    input.oninput = draw;
    type.onchange = draw;
    provider.onchange = () => {
      selected.clear();
      load();
    };
    o.querySelector("#refresh-model-list").onclick = load;
    await load();
  }
  async function renderDefaults(target, onSaved = async () => {}) {
    const [d, models] = await Promise.all([
      api("/ai/defaults"),
      api("/ai/models"),
    ]);
    const options = (type) =>
      '<option value="">未设置</option>' +
      models
        .filter((m) => m.model_type === type && m.enabled && m.provider_enabled)
        .map(
          (m) =>
            `<option value="${m.id}">${E(m.name)} · ${E(m.provider_name)}</option>`,
        )
        .join("");
    target.innerHTML = `<section class="panel"><h3>默认模型配置</h3><p class="small">智能体可覆盖对话模型，知识库可覆盖 embedding 模型。设置默认 embedding 不会自动开启语义检索或发送知识。</p><form id="ai-default-form"><div class="service-form-grid"><div class="field"><label>默认对话模型<select name="chat_id">${options("chat")}</select></label></div><div class="field"><label>默认 embedding 模型<select name="embedding_id">${options("embedding")}</select></label></div></div><button class="primary">保存默认模型</button><p role="status" id="default-save-state"></p></form></section>`;
    const form = target.querySelector("form");
    form.elements.chat_id.value = d.chat_id || "";
    form.elements.embedding_id.value = d.embedding_id || "";
    form.onsubmit = async (e) => {
      e.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        const result = await api("/ai/defaults", {
          method: "PUT",
          body: JSON.stringify({
            ...Object.fromEntries(new FormData(form)),
            expectedRevision: d.revision,
          }),
        });
        d.revision = result.revision;
        target.querySelector("#default-save-state").textContent =
          "默认模型已保存";
        toast("默认模型已保存");
        await onSaved();
      } catch (error) {
        target.querySelector("#default-save-state").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
  }
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (error) {
      toast(error.message);
    }
  };
  const field = (name, label, value = "", type = "text") =>
    `<div class="field"><label>${label}<input name="${name}" type="${type}" value="${E(value ?? "")}"></label></div>`;
  async function render(target) {
    const [models, providers] = await Promise.all([
      api("/ai/models"),
      api("/ai/providers"),
    ]);
    target.innerHTML = `<div class="toolbar"><p class="small">本地维护供应商下的对话与 embedding 模型，不包含商店或安装功能。</p><div class="row"><button id="model-discover">读取供应商模型列表</button><button class="primary" id="catalog-add">＋ 添加模型</button></div></div><div class="table-scroll"><table class="table"><thead><tr><th>名称 / 标识</th><th>供应商</th><th>类型</th><th>维度</th><th>状态</th><th>操作</th></tr></thead><tbody>${models.map((m) => `<tr><td>${E(m.name)}<div class="small">${E(m.model)}</div></td><td>${E(m.provider_name)}</td><td>${m.model_type === "chat" ? "对话" : "Embedding"}</td><td>${m.model_type === "embedding" ? m.dimensions || "由响应确定" : "—"}</td><td>${m.enabled && m.provider_enabled ? "可用" : "已停用"}</td><td><button data-catalog-edit="${m.id}">配置</button></td></tr>`).join("")}</tbody></table></div>${models.length ? "" : '<p class="small">尚未添加本地模型。</p>'}`;
    target.querySelector("#catalog-add").onclick = safe(() =>
      add(null, () => render(target)),
    );
    target
      .querySelectorAll("[data-catalog-edit]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            edit(models.find((m) => m.id === b.dataset.catalogEdit))),
      );
    target.querySelector("#model-discover").onclick = safe(() =>
      add(null, () => render(target)),
    );
    function edit(existing, seed = {}) {
      if (!providers.length) {
        toast("请先添加供应商");
        return;
      }
      const c = existing || {
        provider_id: seed.provider_id || providers[0].id,
        model: seed.model || "",
        name: seed.model || "",
        model_type: seed.model_type || "chat",
        enabled: true,
        dimensions: 0,
        pricing: null,
      };
      const o = modal(
        existing ? "配置本地模型" : "添加本地模型",
        `<div class="field"><label>供应商<select name="provider_id" ${existing ? "disabled" : ""}>${providers.map((p) => `<option value="${p.id}" ${c.provider_id === p.id ? "selected" : ""}>${E(p.name)}</option>`).join("")}</select></label></div>${field("name", "显示名称", c.name)}${field("model", "模型标识", c.model)}<div class="field"><label>模型类型<select name="model_type" ${existing ? "disabled" : ""}><option value="chat" ${c.model_type === "chat" ? "selected" : ""}>对话模型</option><option value="embedding" ${c.model_type === "embedding" ? "selected" : ""}>Embedding 模型</option></select></label></div>${field("dimensions", "Embedding 维度（0 表示不发送 dimensions 参数）", c.dimensions, "number")}<p class="small">仅兼容 OpenAI 的供应商可用于 embedding。修改维度将使旧向量失效，需重新建立索引。</p><label class="row"><input type="checkbox" name="enabled" ${c.enabled ? "checked" : ""}> 启用模型</label>`,
        "保存",
        async (b) => {
          const payload = {
            provider_id: existing ? c.provider_id : b.provider_id,
            model: existing ? c.model : b.model,
            name: b.name,
            model_type: existing ? c.model_type : b.model_type,
            enabled: !!b.enabled,
            dimensions: Number(b.dimensions),
            expectedRevision: c.revision,
          };
          await api("/ai/models" + (existing ? "/" + c.id : ""), {
            method: existing ? "PUT" : "POST",
            body: JSON.stringify(payload),
          });
          toast("本地模型已保存");
          await render(target);
        },
      );
      if (existing) o.querySelector("[name=model]").readOnly = true;
      o.querySelectorAll("input[type=number]").forEach((i) => (i.min = "0"));
    }
  }

  return { render, add, renderDefaults };
}
