import { createModelPicker } from "./model-picker.js";
export function createModelCatalogUI({ api, E, modal, toast }) {
  async function add(providerId, onSaved = async () => {}) {
    const [providers, installed] = await Promise.all([
      api("/ai/providers"),
      api("/ai/models"),
    ]);
    if (!providers.length) return toast("请先添加供应商");
    const provider = providers.find((p) => p.id === providerId) || providers[0];
    let picker;
    const o = modal(
      "添加模型 · " + provider.name,
      "<div data-model-picker></div>",
      "添加所选模型",
      async () => {
        const models = picker.models();
        if (!models.length) throw Error("请选择或输入模型");
        await api("/ai/models/batch", {
          method: "POST",
          body: JSON.stringify({ provider_id: provider.id, models }),
        });
        toast(`已添加 ${models.length} 个模型`);
        await onSaved();
      },
    );
    picker = createModelPicker({
      target: o.querySelector("[data-model-picker]"),
      E,
      installed: installed.filter((m) => m.provider_id === provider.id),
      discover: () =>
        api("/ai/providers/" + provider.id + "/models/discover", {
          method: "POST",
        }),
    });
    await picker.load();
  }
  async function renderDefaults(target, onSaved = async () => {}, supplied) {
    const [d, models] = supplied
      ? [supplied.defaults, supplied.models]
      : await Promise.all([api("/ai/defaults"), api("/ai/models")]);
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
  async function render(target, options = {}) {
    const [allModels, providers] =
      options.models && options.providers
        ? [options.models, options.providers]
        : await Promise.all([api("/ai/models"), api("/ai/providers")]);
    const models = options.providerId
      ? allModels.filter((m) => m.provider_id === options.providerId)
      : allModels;
    const refresh = options.onSaved || (() => render(target, options));
    target.innerHTML = `<div class="toolbar"><span class="small">${models.length} 个已配置模型</span><button type="button" data-catalog-add>＋ 添加模型</button></div><div class="table-scroll"><table class="table"><thead><tr><th>名称 / 标识</th><th>用途</th><th>状态</th><th>操作</th></tr></thead><tbody>${models.map((m) => `<tr><td>${E(m.name)}<div class="small">${E(m.model)}</div></td><td>${m.model_type === "chat" ? "对话" : "Embedding"}${m.model_type === "embedding" ? `<div class="small">维度：${m.dimensions || "自动"}</div>` : ""}</td><td>${m.enabled && m.provider_enabled ? "可用" : !m.provider_enabled ? "供应商已停用" : "模型已停用"}</td><td><button type="button" data-catalog-test="${m.id}" ${!m.enabled || !m.provider_enabled ? "disabled" : ""}>测试</button><button type="button" data-catalog-edit="${m.id}">配置</button></td></tr>`).join("")}</tbody></table></div>${models.length ? "" : '<p class="small">尚未添加模型，请添加后再用于智能体或知识库。</p>'}`;
    target.querySelector("[data-catalog-add]").onclick = safe(() =>
      add(options.providerId, refresh),
    );
    target.querySelectorAll("[data-catalog-test]").forEach(
      (button) =>
        (button.onclick = safe(async () => {
          button.disabled = true;
          try {
            await api("/ai/models/" + button.dataset.catalogTest + "/test", {
              method: "POST",
            });
            toast("模型测试成功，用量已记录");
          } finally {
            button.disabled = false;
          }
        })),
    );
    target
      .querySelectorAll("[data-catalog-edit]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            edit(models.find((m) => m.id === b.dataset.catalogEdit))),
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
        existing ? "配置模型" : "添加模型",
        `<div class="field"><label>供应商<select name="provider_id" ${existing ? "disabled" : ""}>${providers.map((p) => `<option value="${p.id}" ${c.provider_id === p.id ? "selected" : ""}>${E(p.name)}</option>`).join("")}</select></label></div>${field("name", "显示名称", c.name)}${field("model", "模型标识", c.model)}<div class="field"><label>模型类型<select name="model_type" ${existing ? "disabled" : ""}><option value="chat" ${c.model_type === "chat" ? "selected" : ""}>对话模型</option><option value="embedding" ${c.model_type === "embedding" ? "selected" : ""}>Embedding 模型</option></select></label></div>${c.model_type === "embedding" ? field("dimensions", "Embedding 维度（0 表示自动）", c.dimensions, "number") : '<input type="hidden" name="dimensions" value="0">'}<p class="small">仅兼容 OpenAI 的供应商可用于 embedding。修改维度将使旧向量失效，需重新建立索引。</p><label class="row"><input type="checkbox" name="enabled" ${c.enabled ? "checked" : ""}> 启用模型</label>`,
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
          toast("模型已保存");
          await refresh();
        },
      );
      if (existing) o.querySelector("[name=model]").readOnly = true;
      o.querySelectorAll("input[type=number]").forEach((i) => (i.min = "0"));
    }
  }

  return { render, add, renderDefaults };
}
