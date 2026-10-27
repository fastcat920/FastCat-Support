export function createAccessUI({ api, E, modal, toast }) {
  const safe = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    }
  };
  const input = (label, name, value = "", type = "text") =>
    `<div class="field"><label>${label}<input name="${name}" type="${type}" value="${E(value)}"></label></div>`;
  const widgetDefaults = {
    themeColor: "#5b4ee8",
    language: "auto",
    theme: "auto",
    position: "bottom-right",
    welcomeMessage: "",
    logoUrl: "",
  };
  const modeName = (mode) =>
    ({
      inherit: "人工接待（默认）",
      auto: "AI 自动",
      assist: "人工优先",
      off: "纯人工",
    })[mode] || mode;
  let selected = null,
    renderRevision = 0;
  function platformForm(title, html, submit, onSubmit) {
    const target = document.querySelector("#platform-detail");
    target.innerHTML = `<header class="platform-detail-head"><div><p class="small">平台配置</p><h1>${E(title)}</h1></div><button type="button" data-close>返回平台概览</button></header><div class="platform-config-body"><div class="platform-form-main"><nav class="tabs" id="platform-config-tabs"></nav><form>${html}<p class="error" role="alert" id="platform-form-error"></p><footer class="platform-save-bar"><button type="button" id="platform-cancel">取消修改</button><button type="submit" class="primary">${submit}</button></footer></form></div><aside class="platform-preview" hidden></aside></div>`;
    target.querySelector("[data-close]").onclick = () => {
      selected = null;
      render();
    };
    target.querySelector("#platform-cancel").onclick = () => render();
    const sections = [...target.querySelectorAll("[data-platform-section]")];
    const titles = {
      basic: "基本设置",
      ai: "AI 接待",
      appearance: "组件外观",
      integration: "安装与接入",
    };
    if (sections.length) {
      target.querySelector("#platform-config-tabs").innerHTML = sections
        .map(
          (s) =>
            `<button type="button" data-config-tab="${s.dataset.platformSection}">${titles[s.dataset.platformSection]}</button>`,
        )
        .join("");
      const selectTab = (id) => {
        sections.forEach((s) => (s.hidden = s.dataset.platformSection !== id));
        target
          .querySelectorAll("[data-config-tab]")
          .forEach((b) =>
            b.classList.toggle("active", b.dataset.configTab === id),
          );
      };
      target
        .querySelectorAll("[data-config-tab]")
        .forEach((b) => (b.onclick = () => selectTab(b.dataset.configTab)));
      selectTab("basic");
    }
    const preview = target.querySelector("#widget-design-preview");
    if (preview) {
      const aside = target.querySelector(".platform-preview");
      aside.hidden = false;
      aside.innerHTML =
        '<h3>实时预览</h3><p class="small">调整组件标题、主题色和欢迎语，即时查看效果。</p>';
      aside.append(preview);
    }
    target.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      event.submitter.disabled = true;
      target.querySelector("#platform-form-error").textContent = "";
      try {
        await onSubmit(Object.fromEntries(new FormData(event.target)));
      } catch (e) {
        if (target.isConnected) {
          target.querySelector("#platform-form-error").textContent = e.message;
          toast(e.message);
        }
      } finally {
        event.submitter.disabled = false;
      }
    };
    return target;
  }
  async function render() {
    const revision = ++renderRevision;
    const [channels, tg] = await Promise.all([
      api("/access/channels"),
      api("/access/telegram"),
    ]);
    if (revision !== renderRevision) return;
    const root = document.querySelector("#view");
    if (
      selected &&
      selected !== "telegram" &&
      !channels.some((c) => c.id === selected)
    )
      selected = null;
    root.innerHTML = `<div class="platform-workspace"><aside class="platform-list"><header><h2>接入平台</h2><button id="access-create" aria-label="添加网页或 SDK 平台">＋</button></header><nav aria-label="平台列表">${channels.map((c) => `<button class="platform-list-item ${selected === c.id ? "active" : ""}" data-platform="${c.id}"><span class="platform-kind">${c.type === "web" ? "网" : "SDK"}</span><span><strong>${E(c.name)}</strong><small>${c.type === "web" ? "网页端" : "Flutter / Dart"} · ${c.enabled ? "已启用" : "已停用"}</small></span><span class="platform-status ${c.enabled ? "enabled" : ""}"></span></button>`).join("")}${`<button class="platform-list-item ${selected === "telegram" ? "active" : ""}" data-platform="telegram"><span class="platform-kind">TG</span><span><strong>Telegram 客服话题</strong><small>${tg.enabled ? "已启用" : "未启用"} · 仅客服回复</small></span><span class="platform-status ${tg.enabled ? "enabled" : ""}"></span></button>`}</nav></aside><section id="platform-detail" class="platform-detail"></section></div>`;
    root.querySelector("#access-create").onclick = safe(() => {
      selected = "new";
      edit();
    });
    root.querySelectorAll("[data-platform]").forEach(
      (b) =>
        (b.onclick = safe(async () => {
          selected = b.dataset.platform;
          await render();
        })),
    );
    if (selected === "telegram") {
      await editTelegram(tg);
      return;
    }
    const current = channels.find((c) => c.id === selected);
    if (current) {
      await edit(current);
      return;
    }
    const detail = root.querySelector("#platform-detail");
    detail.innerHTML = `<header class="platform-detail-head"><div><h1>接入平台</h1><p class="small">从左侧选择平台，配置接入方式、AI 接待和组件外观。</p></div></header><div class="platform-overview"><h2>${current ? E(current.name) : "连接你的网页与应用"}</h2><p>网页、Flutter / Dart SDK 和 Telegram 客服群话题。</p><div class="platform-overview-options">${channels.map((c) => `<article class="panel"><span class="badge ${c.enabled ? "success" : "neutral"}">${c.enabled ? "已启用" : "已停用"}</span><h3>${E(c.name)}</h3><p class="small">${E(modeName(c.ai_mode))}</p><button data-open-platform="${c.id}">配置平台 →</button></article>`).join("")}</div><p class="notice">Telegram 仅作为客服群话题桥接，不提供用户私聊 Bot 咨询入口。</p></div>`;
    detail.querySelectorAll("[data-open-platform]").forEach(
      (b) =>
        (b.onclick = safe(async () => {
          selected = b.dataset.openPlatform;
          await render();
        })),
    );
  }
  async function edit(existing) {
    const revision = renderRevision;
    const c = existing || {
      type: "web",
      name: "新网站",
      title: "你好，有什么可以帮你？",
      enabled: false,
      origins: [],
      widget: widgetDefaults,
      ai_mode: "inherit",
      agent_id: "",
      fallback_timeout: 0,
    };
    const agents = await api("/resources?kind=agent"),
      w = { ...widgetDefaults, ...c.widget };
    if (
      revision !== renderRevision ||
      !document.querySelector("#platform-detail")
    )
      return;
    const code = () =>
      c.type === "web"
        ? `<script src="${location.origin}/embed.js" data-app-key="${c.public_key}" defer></script>`
        : `final support = FastCatClient(\n  baseUrl: Uri.parse('${location.origin}'),\n  appKey: '${c.public_key}',\n);\nawait support.start(name: '客户称呼');\n// FastCatChat(client: support)`;
    const o = platformForm(
      existing ? c.name + " 配置" : "添加网页 / SDK 平台",
      `<section data-platform-section="basic">${!existing ? '<div class="field"><label>平台类型<select name="type"><option value="web">网页端</option><option value="sdk">Flutter / Dart SDK</option></select></label></div>' : ""}${input("平台名称", "name", c.name)}${input("组件标题", "title", c.title)}<label><input type="checkbox" name="enabled" ${c.enabled ? "checked" : ""}> 启用平台</label><div class="field"><label>允许的网站来源（每行一个完整 origin）<textarea name="origins" rows="2" placeholder="https://www.example.com">${E(c.origins.join("\n"))}</textarea></label><p class="small">网页嵌入与 Flutter Web 需要配置；原生 SDK 无需来源。</p></div></section><section data-platform-section="ai"><h3>AI 接待策略</h3><div class="field"><label>接待模式<select name="ai_mode">${Object.entries(
        {
          inherit: "人工接待（默认）",
          auto: "AI 自动接待",
          assist: "人工优先，超时由 AI 回复",
          off: "纯人工，关闭 AI",
        },
      )
        .map(
          ([v, label]) =>
            `<option value="${v}" ${v === c.ai_mode ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select></label></div><div class="field"><label>平台智能体<select name="agent_id"><option value="">工作空间默认模型助手</option>${agents.map((a) => `<option value="${a.id}" ${a.id === c.agent_id ? "selected" : ""}>${E(a.name)}</option>`).join("")}</select></label></div><div data-assist>${input("等待人工回复超时（秒；0 表示不回落 AI）", "fallback_timeout", c.fallback_timeout, "number")}</div><p class="small">人工回复、转交和主动接管会停止 AI；工作时间沿用团队管理设置，会话由客服手动分配。修改接待策略会终止该平台正在生成的 AI 回复。</p></section><section data-platform-section="appearance"><h3>组件外观与欢迎语</h3>${input("主题色", "themeColor", w.themeColor, "color")}<div class="field"><label>语言跟随方式<select name="language">${Object.entries(
        { auto: "跟随网页 / 客户端", "zh-CN": "简体中文", en: "English" },
      )
        .map(
          ([k, v]) =>
            `<option value="${k}" ${w.language === k ? "selected" : ""}>${v}</option>`,
        )
        .join(
          "",
        )}</select></label></div><div class="field"><label>主题跟随方式<select name="theme">${Object.entries(
        { auto: "跟随网页 / 客户端", light: "浅色", dark: "深色" },
      )
        .map(
          ([k, v]) =>
            `<option value="${k}" ${w.theme === k ? "selected" : ""}>${v}</option>`,
        )
        .join(
          "",
        )}</select></label></div>${input("Logo HTTPS 地址（选填）", "logoUrl", w.logoUrl)}<div class="field"><label>悬浮位置<select name="position">${["bottom-right", "bottom-left", "top-right", "top-left"].map((v, i) => `<option value="${v}" ${v === w.position ? "selected" : ""}>${["右下角", "左下角", "右上角", "左上角"][i]}</option>`).join("")}</select></label></div><div class="field"><label>欢迎语（留空人工接待（默认））<textarea name="welcomeMessage" rows="3" maxlength="3000">${E(w.welcomeMessage)}</textarea></label></div><p class="small">主题色使用后台配置；语言和明暗模式可跟随网页或客户端。Logo 与位置用于网页组件。</p><div id="widget-design-preview"><header><strong data-preview-title></strong></header><div class="platform-preview-messages"><p data-preview-welcome></p><div class="platform-preview-question">你好，我想咨询一个问题</div><p class="small">客服会在这里回复你</p></div><div class="platform-preview-composer">输入你的问题…</div></div></section><section data-platform-section="integration">${existing ? `<details><summary>嵌入代码与接入标识</summary><pre class="code">${E(code())}</pre><div class="code">${E(c.public_key)}</div><button type="button" id="rotate-platform-key">重新生成接入标识</button>${c.type === "sdk" ? '<p><a href="/fastcat_support_sdk.zip" download>下载 Flutter SDK 与示例</a></p>' : `<p><a href="/embed-demo.html?appKey=${c.public_key}" target="_blank" rel="noopener">打开实际嵌入演示 ↗</a></p>`}</details>` : '<p class="small">保存后即可复制接入代码；新平台默认停用。</p>'}</section>`,
      "保存",
      async (f) => {
        const payload = {
          type: f.type || c.type,
          name: f.name,
          title: f.title,
          enabled: !!f.enabled,
          origins: String(f.origins)
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
          widget: {
            themeColor: f.themeColor,
            language: f.language,
            theme: f.theme,
            position: f.position,
            welcomeMessage: f.welcomeMessage,
            logoUrl: f.logoUrl,
          },
          ai_mode: f.ai_mode,
          agent_id: f.agent_id || "",
          fallback_timeout: Number(f.fallback_timeout),
          expectedRevision: c.revision,
        };
        const saved = await api(
          "/access/channels" + (existing ? "/" + c.id : ""),
          {
            method: existing ? "PUT" : "POST",
            body: JSON.stringify(payload),
          },
        );
        selected = saved.id || c.id || null;
        toast("平台已保存");
        await render();
      },
    );
    o.querySelectorAll("details").forEach((d) => (d.open = true));
    const update = () => {
      const form = o.querySelector("form"),
        mode = form.elements.ai_mode.value;
      o.querySelector("[data-assist]").hidden = mode !== "assist";
      const preview = o.querySelector("#widget-design-preview");
      preview.querySelector("header").style.background =
        form.elements.themeColor.value;
      preview.querySelector("[data-preview-title]").textContent =
        form.elements.title.value;
      preview.querySelector("[data-preview-welcome]").textContent =
        form.elements.welcomeMessage.value || "欢迎语人工接待（默认）";
    };
    o.querySelector("form").addEventListener("input", update);
    update();
    const rotate = o.querySelector("#rotate-platform-key");
    if (rotate)
      rotate.onclick = () =>
        modal(
          "重新生成接入标识",
          `<p>旧嵌入代码与 SDK 配置将失效，需要更新所有接入代码。访客和历史消息仍保留。</p>`,
          "重新生成",
          async () => {
            await api("/access/channels/" + c.id + "/rotate", {
              method: "POST",
              body: JSON.stringify({ expectedRevision: c.revision }),
            });
            o.querySelector("[data-close]").click();
            toast("已重新生成，请重新打开配置复制新标识");
            await render();
          },
        );
  }
  async function editTelegram(c) {
    const revision = renderRevision;
    const members = (await api("/members")).filter((m) => m.active);
    if (
      revision !== renderRevision ||
      !document.querySelector("#platform-detail")
    )
      return;
    const o = platformForm(
      "Telegram 客服话题配置",
      `<p class="small">将 Bot 加入启用话题的超级群组，并设为具有管理话题权限的管理员。客服需绑定个人 Telegram 数字 ID；匿名管理员消息不支持。客服权限与工作台一致。</p><label><input name="enabled" type="checkbox" ${c.enabled ? "checked" : ""}> 启用人工话题转发</label>${input("Bot Token（留空保留，服务端加密）", "botToken", "", "password")}${input("或密钥环境变量（FC_SECRET_ 前缀）", "tokenEnv", c.tokenEnv)}${input("目标超级群组 ID", "chatId", c.chatId)}${input("服务公网 HTTPS 地址", "publicBaseUrl", c.publicBaseUrl)}${input("首次带入最近消息数（0 表示仅最近一条）", "contextMessages", c.contextMessages, "number")}<h3>客服身份绑定</h3><div id="tg-operators"></div><button type="button" id="tg-add">＋ 绑定客服</button><p class="small">只将已绑定的客服话题回复传给用户。内部备注不转发，已结束会话不接收回复。</p><div class="row"><button type="button" id="tg-status">消息与话题</button><button type="button" id="tg-test">检测已保存连接</button><button type="button" id="tg-webhook">注册已保存回调</button></div><p class="small">首次配置或更换 Bot / 群组后，保存并注册回调。Token ${c.tokenConfigured ? "已配置" : "未配置"}。</p>`,
      "保存",
      async (f) => {
        const operators = [...o.querySelectorAll("[data-operator]")].map(
          (row) => ({
            telegramId: row.querySelector("input").value.trim(),
            userId: row.querySelector("select").value,
          }),
        );
        const data = {
          enabled: !!f.enabled,
          chatId: f.chatId,
          tokenEnv: f.tokenEnv,
          publicBaseUrl: f.publicBaseUrl,
          contextMessages: Number(f.contextMessages),
          operators,
          expectedRevision: c.revision,
        };
        if (f.botToken) data.botToken = f.botToken;
        await api("/access/telegram", {
          method: "PUT",
          body: JSON.stringify(data),
        });
        toast("配置已保存；更换 Bot 或群组后请注册回调");
        await render();
      },
    );
    o.querySelector("#tg-status").onclick = safe(status);
    const add = (value = {}) => {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.operator = "";
      row.innerHTML = `<input aria-label="Telegram 用户数字 ID" placeholder="Telegram 用户数字 ID" value="${E(value.telegramId || "")}"><select aria-label="工作台客服">${members.map((m) => `<option value="${m.id}" ${m.id === value.userId ? "selected" : ""}>${E(m.name)}</option>`).join("")}</select><button type="button" aria-label="移除绑定">移除</button>`;
      row.querySelector("button").onclick = () => row.remove();
      o.querySelector("#tg-operators").append(row);
    };
    c.operators.forEach(add);
    o.querySelector("#tg-add").onclick = () => add();
    for (const [id, path] of [
      ["tg-test", "test"],
      ["tg-webhook", "webhook"],
    ])
      o.querySelector("#" + id).onclick = safe(async () => {
        await api("/access/telegram/" + path, { method: "POST" });
        toast(path === "test" ? "群组与机器人权限正常" : "回调注册成功");
      });
  }
  async function status() {
    const d = await api("/access/telegram/status");
    const o = modal(
      "Telegram 消息与话题",
      `<h3>会话话题</h3>${d.topics.map((t) => `<div class="panel"><strong>${E(t.name)}</strong><p class="small">${E(t.conversation_id)} · 话题 ${t.thread_id || "等待创建"} · ${E(t.conversation_status)}</p><button type="button" data-bind="${t.conversation_id}">绑定已有话题</button></div>`).join("") || '<p class="small">转人工后自动创建话题。</p>'}<h3>发送记录（最近 100 条）</h3>${d.deliveries.map((j) => `<div class="panel"><span>${E(j.kind)} · ${E(j.status)}</span><p class="small">${E(j.error || j.conversation_id)}</p>${["failed", "uncertain"].includes(j.status) ? `<button type="button" data-retry="${j.id}" data-state="${j.status}">核对后重试</button>` : ""}</div>`).join("") || '<p class="small">暂无发送记录</p>'}<h3>客服回复</h3>${d.updates.map((j) => `<p class="small">#${j.update_id} · ${E(j.status)} ${E(j.error)} ${j.status === "failed" ? `<button type="button" data-update-retry="${j.update_id}">重试回复</button>` : ""}</p>`).join("") || '<p class="small">暂无回复记录</p>'}`,
      "关闭",
    );
    o.querySelectorAll("[data-update-retry]").forEach(
      (b) =>
        (b.onclick = safe(async () => {
          await api(
            "/access/telegram/updates/" + b.dataset.updateRetry + "/retry",
            { method: "POST" },
          );
          toast("回复已加入重试队列");
          b.disabled = true;
        })),
    );
    o.querySelectorAll("[data-retry]").forEach(
      (b) =>
        (b.onclick = () => {
          modal(
            "确认重试",
            `<p>${b.dataset.state === "uncertain" ? "上次发送结果不确定，重试可能产生重复消息或话题。请先检查群组；若话题已存在，请绑定已有话题。" : "请先修复配置或权限问题。"}</p>`,
            "重试",
            async () => {
              await api(
                "/access/telegram/deliveries/" + b.dataset.retry + "/retry",
                { method: "POST" },
              );
              toast("已加入重试队列");
            },
          );
        }),
    );
    o.querySelectorAll("[data-bind]").forEach(
      (b) =>
        (b.onclick = () =>
          modal(
            "绑定已有群话题",
            input("目标话题的 message_thread_id", "threadId", "", "number"),
            "绑定",
            async (f) => {
              await api("/access/telegram/topics/" + b.dataset.bind, {
                method: "PUT",
                body: JSON.stringify({ threadId: Number(f.threadId) }),
              });
              toast("话题已绑定");
            },
          )),
    );
  }
  return { render };
}
