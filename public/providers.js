import { createModelPicker } from "./model-picker.js";
import { createModelCatalogUI } from "./model-catalog.js";
export function createProviderUI({ api, E, modal, toast }) {
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (x) {
      toast(x.message);
    }
  };
  const scene = (context) =>
    context.startsWith("collaboration:")
      ? "成员讨论"
      : context.startsWith("synthesis:")
        ? "协调汇总"
        : context.startsWith("automatic:")
          ? "平台 AI 回复"
          : context.startsWith("conversation:")
            ? "会话草稿"
            : {
                debug: "智能体调试",
                workflow: "工作流",
                "connection-test": "连接测试",
              }[context] || context;
  const statusName = (s) =>
    ({
      running: "进行中",
      succeeded: "成功",
      failed: "失败",
      cancelled: "已取消",
      interrupted: "已中断",
      uncertain: "结果待核对",
    })[s] || s;
  const modelCatalogUI = createModelCatalogUI({ api, E, modal, toast });
  let view = "providers";
  async function render() {
    const root = document.querySelector("#view");
    root.innerHTML = `<div class="content feature-content"><div class="page-heading"><div><h1>模型服务</h1><p>配置模型连接，选择对话与 Embedding 模型。</p></div>${view === "providers" ? '<button class="primary" id="new-provider">＋ 添加模型服务</button>' : ""}</div><div class="tabs"><button data-model-view="providers">模型配置</button><button data-model-view="records">调用记录</button></div>${view !== "providers" ? '<div class="management-tabs"><button data-record-view="usage">模型调用</button><button data-record-view="collaboration">智能体协作</button><button data-record-view="tool-calls">工具执行</button></div>' : ""}<div id="model-content"></div></div>`;
    root
      .querySelector("#new-provider")
      ?.addEventListener("click", safe(create));
    root.querySelectorAll("[data-model-view]").forEach((b) => {
      b.classList.toggle(
        "active",
        b.dataset.modelView === "providers"
          ? view === "providers"
          : view !== "providers",
      );
      b.onclick = safe(async () => {
        view = b.dataset.modelView === "records" ? "usage" : "providers";
        await render();
      });
    });
    root.querySelectorAll("[data-record-view]").forEach((b) => {
      b.classList.toggle("active", b.dataset.recordView === view);
      b.onclick = safe(async () => {
        view = b.dataset.recordView;
        await render();
      });
    });
    const target = root.querySelector("#model-content");
    if (view === "providers") {
      const [rows, models, d] = await Promise.all([
        api("/ai/providers"),
        api("/ai/models"),
        api("/ai/defaults"),
      ]);
      const defaults = document.createElement("div");
      target.before(defaults);
      await modelCatalogUI.renderDefaults(defaults, render, {
        defaults: d,
        models,
      });
      target.innerHTML = `<div class="provider-services">${rows.map((r) => `<article class="panel provider-service"><header class="panel-head"><div><h2>${E(r.name)}</h2><p class="small">${E(r.endpoint)}</p></div><div class="row"><span class="badge neutral">${r.protocol === "anthropic" ? "Anthropic Messages" : "Chat Completions"}</span><span class="badge ${r.enabled && r.keyConfigured ? "success" : "neutral"}">${!r.enabled ? "已停用" : r.keyConfigured ? "密钥已配置" : "待配置密钥"}</span><button type="button" data-edit-provider="${r.id}">连接配置</button></div></header><div data-provider-models="${r.id}"></div></article>`).join("")}</div>${rows.length ? "" : '<section class="panel empty"><strong>添加第一个模型服务</strong><p>配置连接并选择模型，一次保存后即可用于智能体和知识库。</p><button type="button" id="empty-add-provider" class="primary">添加模型服务</button></section>'}`;
      target
        .querySelector("#empty-add-provider")
        ?.addEventListener("click", safe(create));
      target
        .querySelectorAll("[data-edit-provider]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              edit(rows.find((r) => r.id === b.dataset.editProvider))),
        );
      for (const el of target.querySelectorAll("[data-provider-models]"))
        await modelCatalogUI.render(el, {
          providerId: el.dataset.providerModels,
          providers: rows,
          models,
          onSaved: render,
        });
    }
    if (view === "usage") {
      target.innerHTML =
        '<div class="toolbar"><label>开始日期<input type="date" id="usage-start"></label><label>结束日期<input type="date" id="usage-end"></label><button id="usage-filter">查询</button><button id="usage-export">导出当前明细</button></div><p class="small">仅保留调用状态和 token 用量，不配置价格或计算费用。明细最多展示最近 500 条，汇总包含日期范围内全部请求（UTC 日期）。</p><div id="usage-results"></div>';
      let data;
      const load = async () => {
        const p = new URLSearchParams();
        if (target.querySelector("#usage-start").value)
          p.set("start", target.querySelector("#usage-start").value);
        if (target.querySelector("#usage-end").value)
          p.set("end", target.querySelector("#usage-end").value);
        data = await api("/ai/usage?" + p);
        target.querySelector("#usage-results").innerHTML =
          `<div class="grid">${data.summary.map((s) => `<article class="card"><h3>调用汇总</h3><p>${s.requests} 次请求</p><p class="small">已知 ${s.inputTokens ?? "未知"} 输入 / ${s.outputTokens ?? "未知"} 输出 token</p></article>`).join("")}</div><div class="table-scroll"><table class="table usage-table"><thead><tr><th>时间 / 场景</th><th>供应商 / 模型</th><th>状态</th><th>输入 / 输出</th></tr></thead><tbody>${data.items.map((r) => `<tr><td>${new Date(r.created).toLocaleString("zh-CN")}<div class="small">${E(scene(r.context))}</div></td><td>${E(r.provider_name)}<div class="small">${E(r.model)}</div></td><td><span class="badge ${r.status === "succeeded" ? "success" : "neutral"}">${E(statusName(r.status))}</span>${r.error ? `<div class="small">${E(r.error)}</div>` : ""}</td><td>${r.input_tokens ?? "未知"} / ${r.output_tokens ?? "未知"}</td></tr>`).join("")}</tbody></table></div>`;
      };
      target.querySelector("#usage-filter").onclick = safe(load);
      target.querySelector("#usage-export").onclick = () => {
        if (!data) return;
        const cell = (v) =>
          '"' +
          String(v ?? "未知")
            .replaceAll('"', '""')
            .replace(/^\s*[=+@-]/, "'$&") +
          '"';
        const keys = [
          "created",
          "provider_name",
          "model",
          "context",
          "status",
          "input_tokens",
          "output_tokens",
          "cache_read_tokens",
          "cache_write_tokens",
        ];
        const csv =
          "\uFEFF" +
          [keys, ...data.items.map((r) => keys.map((k) => r[k]))]
            .map((row) => row.map(cell).join(","))
            .join("\r\n");
        const url = URL.createObjectURL(
            new Blob([csv], { type: "text/csv;charset=utf-8" }),
          ),
          a = document.createElement("a");
        a.href = url;
        a.download = "model-usage.csv";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      await load();
    }
    if (view === "tool-calls") {
      const rows = await api("/ai/tool-calls");
      target.innerHTML = `<p class="small">显示最近 100 次智能体工具执行。为减少敏感数据留存，不保存工具参数与返回正文；失败、取消或重启后的未知结果均不自动重试。</p><div class="table-scroll"><table class="table"><thead><tr><th>工具操作</th><th>场景</th><th>状态</th><th>耗时</th><th>时间 / 说明</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${E(r.tool_name)}</td><td>${E(scene(r.context))}</td><td>${E(statusName(r.status))}</td><td>${r.duration_ms ?? "—"} ms</td><td>${E(new Date(r.created).toLocaleString())}<div class="small">${E(r.error || "")}</div></td></tr>`).join("")}</tbody></table></div>${rows.length ? "" : '<p class="small">暂无工具执行记录</p>'}`;
    }
    if (view === "collaboration") {
      const rows = await api("/ai/collaborations");
      target.innerHTML = `<p class="small">仅展示内部成员意见与运行状态，不向访客开放。每次最多 4 位成员、3 轮讨论，然后由主智能体汇总。</p>${rows.map((r) => `<details class="panel"><summary>${new Date(r.created).toLocaleString("zh-CN")} · ${E(statusName(r.status))} · ${r.steps.length} 条成员意见</summary>${r.error ? `<p class="error">${E(r.error)}</p>` : ""}${r.steps.map((s) => `<article><h3>第 ${s.round} 轮 · ${E(s.name)}</h3><pre class="code">${E(s.output)}</pre></article>`).join("")}</details>`).join("") || "<p>还没有协作记录。</p>"}`;
    }
  }
  const presets = {
    openai: ["OpenAI", "https://api.openai.com/v1", "openai"],
    deepseek: ["DeepSeek", "https://api.deepseek.com/v1", "openai"],
    qwen: [
      "通义千问",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "openai",
    ],
    moonshot: ["月之暗面", "https://api.moonshot.cn/v1", "openai"],
    baichuan: ["百川智能", "https://api.baichuan-ai.com/v1", "openai"],
    ollama: ["Ollama", "http://localhost:11434/v1", "openai"],
    anthropic: ["Anthropic", "https://api.anthropic.com/v1", "anthropic"],
  };
  const input = (name, label, value = "", type = "text") =>
    `<div class="field"><label>${label}<input name="${name}" type="${type}" value="${E(value ?? "")}"></label></div>`;
  const presetOptions = () =>
    '<option value="custom">自定义兼容接口</option>' +
    Object.entries(presets)
      .map(([id, p]) => `<option value="${id}">${p[0]}</option>`)
      .join("");
  async function create() {
    const defaults = await api("/ai/defaults");
    let picker;
    const o = modal(
      "添加模型服务",
      `<section><h3>连接供应商</h3><div class="service-form-grid"><label>供应商类型<select id="provider-preset">${presetOptions()}</select></label>${input("name", "显示名称", "OpenAI")}</div><div class="field"><label>API 密钥<input type="password" name="key" autocomplete="new-password" placeholder="输入供应商提供的密钥"></label></div><details><summary>高级连接设置</summary>${input("endpoint", "接口基础地址（包含 /v1）", "https://api.openai.com/v1", "url")}<label>协议<select name="protocol"><option value="openai">Chat Completions</option><option value="anthropic">Anthropic Messages</option></select></label>${input("keyEnv", "密钥环境变量（可替代手动密钥）")}<label><input name="includeUsage" type="checkbox" checked>请求流式用量</label>${input("maxTokens", "Anthropic 输出 token 上限", 2048, "number")}</details></section><div data-create-model-picker></div><p class="small">取消不会保存供应商或模型。密钥保存后不回显；读取失败可直接手动添加。</p>`,
      "保存模型服务",
      async (b) => {
        const models = picker.models();
        if (!models.length) throw Error("请至少选择或手动添加一个模型");
        if (!b.name.trim()) throw Error("请填写显示名称");
        if (!b.key && !b.keyEnv) throw Error("请填写密钥或密钥环境变量");
        await api("/ai/services", {
          method: "POST",
          body: JSON.stringify({
            provider: {
              name: b.name,
              protocol: b.protocol,
              endpoint: b.endpoint,
              keyEnv: b.keyEnv,
              ...(b.key ? { key: b.key } : {}),
              enabled: true,
              includeUsage: !!b.includeUsage,
              maxTokens: Number(b.maxTokens),
            },
            models,
            defaults: picker.defaults(),
            expectedDefaultsRevision: defaults.revision,
          }),
        });
        toast(`已添加模型服务及 ${models.length} 个模型`);
        view = "providers";
        await render();
      },
    );
    o.querySelector(".modal").classList.add("model-service-modal");
    const connection = () =>
      Object.fromEntries(new FormData(o.querySelector("form")));
    picker = createModelPicker({
      target: o.querySelector("[data-create-model-picker]"),
      E,
      withDefaults: true,
      autoChatDefault: !defaults.chat_id,
      discover: () =>
        api("/ai/providers/preview-models", {
          method: "POST",
          body: JSON.stringify(connection()),
        }),
    });
    const preset = o.querySelector("#provider-preset");
    preset.value = "openai";
    preset.onchange = () => {
      const p = presets[preset.value];
      if (p) {
        o.querySelector("[name=name]").value = p[0];
        o.querySelector("[name=endpoint]").value = p[1];
        o.querySelector("[name=protocol]").value = p[2];
      }
      picker.invalidate();
      if (preset.value === "custom") {
        o.querySelector("details").open = true;
        o.querySelector("[name=endpoint]").focus();
      }
    };
    for (const name of ["endpoint", "protocol", "key", "keyEnv"])
      o.querySelector(`[name="${name}"]`).addEventListener("input", () =>
        picker.invalidate(),
      );
  }
  function edit(r) {
    const o = modal(
      "连接配置 · " + r.name,
      `${input("name", "显示名称", r.name)}${input("key", "替换密钥（留空保留）", "", "password")}<details><summary>高级连接设置</summary>${input("endpoint", "接口基础地址（包含 /v1）", r.endpoint, "url")}<label>协议<select name="protocol"><option value="openai">Chat Completions</option><option value="anthropic">Anthropic Messages</option></select></label>${input("keyEnv", "密钥环境变量", r.key_env)}<label><input type="checkbox" name="clearKey">清除已保存的加密密钥</label><label><input type="checkbox" name="enabled" ${r.enabled ? "checked" : ""}>启用供应商</label><label><input type="checkbox" name="includeUsage" ${r.include_usage !== 0 ? "checked" : ""}>请求流式用量</label>${input("maxTokens", "Anthropic 输出 token 上限", r.max_tokens || 2048, "number")}</details><p class="small">连接配置由该供应商下所有模型共用。默认模型请在页面顶部统一设置。</p>`,
      "保存连接",
      async (b) => {
        await api("/ai/providers/" + r.id, {
          method: "PUT",
          body: JSON.stringify({
            name: b.name,
            protocol: b.protocol,
            endpoint: b.endpoint,
            model: r.model,
            keyEnv: b.keyEnv,
            enabled: !!b.enabled,
            isDefault: r.is_default,
            includeUsage: !!b.includeUsage,
            clearKey: !!b.clearKey,
            maxTokens: Number(b.maxTokens),
            expectedRevision: r.revision,
            ...(b.key ? { key: b.key } : {}),
          }),
        });
        toast("连接配置已保存");
        await render();
      },
    );
    o.querySelector("[name=protocol]").value = r.protocol;
    o.querySelector("[name=key]").autocomplete = "new-password";
  }
  return { render };
}
