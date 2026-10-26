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
    root.innerHTML = `<div class="content feature-content"><div class="page-heading"><div><h1>模型服务</h1><p>管理供应商、服务端密钥与模型用量。</p></div><button class="primary" id="new-provider">＋ 添加供应商</button></div><div class="tabs"><button data-model-view="providers">供应商</button><button data-model-view="models">本地模型目录</button><button data-model-view="usage">调用记录</button><button data-model-view="collaboration">智能体协作记录</button><button data-model-view="tool-calls">工具执行记录</button></div><div id="model-content"></div></div>`;
    root.querySelector("#new-provider").onclick = () => edit();
    root.querySelectorAll("[data-model-view]").forEach((b) => {
      b.classList.toggle("active", b.dataset.modelView === view);
      b.onclick = safe(async () => {
        view = b.dataset.modelView;
        await render();
      });
    });
    const target = root.querySelector("#model-content");
    if (view === "models") await modelCatalogUI.render(target);
    if (view === "providers") {
      const defaults = document.createElement("div");
      target.before(defaults);
      await modelCatalogUI.renderDefaults(defaults, render);
      const rows = await api("/ai/providers");
      target.innerHTML = `<p class="small">支持 Chat Completions 与原生 Anthropic Messages。密钥加密保存在服务端，也可引用 FC_SECRET_ 环境变量；留空不会覆盖原密钥。未设置默认供应商时沿用服务器默认连接。</p><div class="grid">${rows.map((r) => `<article class="card"><div class="row"><span class="badge neutral">${r.protocol === "anthropic" ? "Anthropic Messages" : "Chat Completions"}</span>${r.is_default ? '<span class="badge success">默认</span>' : ""}</div><h3>${E(r.name)}</h3><p>${E(r.model)}</p><p class="small">${E(r.endpoint)}</p><p class="small">${r.enabled ? "启用" : "停用"} · ${r.keyConfigured ? "密钥已配置" : "缺少密钥"}</p><div class="row"><button data-add-provider-model="${r.id}">添加模型</button><button data-edit-provider="${r.id}">配置</button><button data-test-provider="${r.id}">测试连接</button></div></article>`).join("")}</div>${rows.length ? "" : "<p>尚未添加供应商。已有 AI_BASE_URL / AI_API_KEY / AI_MODEL 可继续使用。</p>"}`;
      target
        .querySelectorAll("[data-add-provider-model]")
        .forEach(
          (b) =>
            (b.onclick = safe(() =>
              modelCatalogUI.add(b.dataset.addProviderModel, render),
            )),
        );
      target
        .querySelectorAll("[data-edit-provider]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              edit(rows.find((r) => r.id === b.dataset.editProvider))),
        );
      target.querySelectorAll("[data-test-provider]").forEach(
        (b) =>
          (b.onclick = safe(async () => {
            b.disabled = true;
            try {
              await api("/ai/providers/" + b.dataset.testProvider + "/test", {
                method: "POST",
              });
              toast("连接测试成功，用量已记录");
            } finally {
              b.disabled = false;
            }
          })),
      );
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
  function edit(r) {
    const input = (name, label, value = "", type = "text") =>
      `<div class="field"><label for="p-${name}">${label}</label><input id="p-${name}" name="${name}" type="${type}" value="${E(value ?? "")}"></div>`;
    const o = modal(
      r ? "配置供应商" : "添加供应商",
      `<div class="field"><label for="provider-preset">供应商类型</label><select id="provider-preset"><option value="custom">自定义兼容接口</option><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="qwen">通义千问</option><option value="moonshot">月之暗面</option><option value="baichuan">百川智能</option><option value="ollama">Ollama（兼容接口）</option><option value="anthropic">Anthropic</option></select></div>${input("name", "名称", r?.name)}${input("key", "设置/替换密钥（留空保留）", "", "password")}<details><summary>高级设置：接口与协议</summary><div class="field"><label for="p-protocol">协议</label><select id="p-protocol" name="protocol"><option value="openai">Chat Completions</option><option value="anthropic">Anthropic Messages</option></select></div>${input("endpoint", "接口基础地址（包含 /v1）", r?.endpoint, "url")}${input("model", "默认对话模型（仅用 embedding 可留空）", r?.model)}${input("keyEnv", "密钥环境变量（优先于加密密钥）", r?.key_env)}<label class="row"><input type="checkbox" name="clearKey">清除已保存的加密密钥</label><p class="small">当前：${r?.keyConfigured ? "密钥已配置" : "尚未配置密钥"}。密钥仅提交到服务端，保存后不回显。</p><label class="row"><input type="checkbox" name="enabled" ${r?.enabled !== false ? "checked" : ""}>启用供应商</label><label class="row"><input type="checkbox" name="isDefault" ${r?.is_default ? "checked" : ""}>作为默认供应商</label><label class="row"><input type="checkbox" name="includeUsage" ${r?.include_usage !== 0 ? "checked" : ""}>请求流式用量（兼容接口可关闭）</label>${input("maxTokens", "Anthropic 输出 token 上限", r?.max_tokens || 2048, "number")}</details>`,
      r ? "保存" : "保存并添加模型",
      async (b) => {
        const payload = {
          name: b.name,
          protocol: b.protocol,
          endpoint: b.endpoint,
          model: b.model,
          keyEnv: b.keyEnv,
          enabled: !!b.enabled,
          isDefault: !!b.isDefault,
          includeUsage: !!b.includeUsage,
          clearKey: !!b.clearKey,
          maxTokens: Number(b.maxTokens),
          expectedRevision: r?.revision,
          ...(b.key ? { key: b.key } : {}),
        };
        const saved = await api(r ? "/ai/providers/" + r.id : "/ai/providers", {
          method: r ? "PUT" : "POST",
          body: JSON.stringify(payload),
        });
        toast("供应商已保存");
        view = "providers";
        await render();
        if (!r)
          setTimeout(
            () =>
              modelCatalogUI
                .add(saved.id, render)
                .catch((e) => toast(e.message)),
            0,
          );
      },
    );
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
    const preset = o.querySelector("#provider-preset");
    preset.value = r ? "custom" : "openai";
    preset.onchange = () => {
      const p = presets[preset.value];
      if (p) {
        o.querySelector("[name=name]").value = p[0];
        o.querySelector("[name=endpoint]").value = p[1];
        o.querySelector("[name=protocol]").value = p[2];
      }
    };
    if (!r) preset.onchange();
    o.querySelector("#p-protocol").value = r?.protocol || "openai";
    o.querySelector('[name="key"]').autocomplete = "new-password";
  }
  return { render };
}
