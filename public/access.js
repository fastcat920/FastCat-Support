export function platformSnippet(type, origin, key) {
  return type === "web"
    ? `<script src="${origin}/embed.js" data-app-key="${key}" charset="utf-8" defer></script>`
    : `final support = FastCatClient(\n  baseUrl: Uri.parse('${origin}'),\n  appKey: '${key}',\n);\nawait support.start(email: 'customer@example.com');\n// FastCatChat(client: support)`;
}
export function createAccessUI({ api, E, modal, toast }) {
  const safe = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    }
  };
  const input = (label, name, value = "", type = "text") =>
    `<div class="field"><label>${label}${type === "color" ? `<span class="color-control"><input name="${name}" type="color" value="${E(value)}"><output>${E(value.toUpperCase())}</output></span>` : `<input name="${name}" type="${type}" value="${E(value)}">`}</label></div>`;
  const widgetDefaults = {
    themeColor: "#5b4ee8",
    language: "auto",
    theme: "auto",
    position: "bottom-right",
    welcomeMessage: "",
    welcomeMessageZh: "",
    welcomeMessageEn: "",
    logoUrl: "",
    launcherIconUrl: "",
    allowLocalFilePreview: false,
    showHandoffButton: true,
  };
  const modeName = (mode) =>
    ({
      inherit: "人工接待（默认）",
      auto: "AI 自动",
      assist: "人工优先",
      off: "人工接待（默认）",
    })[mode] || mode;
  let selected = null,
    selectedConfigTab = "basic",
    telegramCheck = null,
    renderRevision = 0;
  let previewUpdate = null;
  window.addEventListener("message", (event) => {
    if (
      event.origin === location.origin &&
      event.data?.type === "fastcat:preview-ready"
    )
      previewUpdate?.(event.source);
  });
  const setPlatformRoute = (id) => {
    const hash = id ? "#channel/" + encodeURIComponent(id) : "#channel";
    if (location.hash !== hash) history.pushState(null, "", hash);
  };
  function platformForm(title, html, submit, onSubmit) {
    const target = document.querySelector("#platform-detail");
    target.innerHTML = `<div class="platform-config-body"><div class="platform-form-main"><nav class="tabs" id="platform-config-tabs"></nav><form>${html}<p class="error" role="alert" id="platform-form-error"></p><footer class="platform-save-bar"><button type="button" id="platform-cancel">取消修改</button><button type="submit" class="primary">${submit}</button></footer></form></div><aside class="platform-preview" hidden></aside></div>`;
    target.querySelector("#platform-cancel").onclick = () => render();
    const sections = [...target.querySelectorAll("[data-platform-section]")];
    const titles = {
      basic: "基本设置",
      ai: "AI 接待",
      appearance: "组件外观",
      integration: "安装与接入",
      operators: "客服绑定",
      diagnostics: "连接与消息",
    };
    if (sections.length) {
      target.querySelector("#platform-config-tabs").innerHTML = sections
        .map(
          (s) =>
            `<button type="button" data-config-tab="${s.dataset.platformSection}">${titles[s.dataset.platformSection]}</button>`,
        )
        .join("");
      const selectTab = (id) => {
        selectedConfigTab = id;
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
      selectTab(
        sections.some((s) => s.dataset.platformSection === selectedConfigTab)
          ? selectedConfigTab
          : sections[0].dataset.platformSection,
      );
    }
    const preview = target.querySelector("#widget-design-preview");
    if (preview) {
      const aside = target.querySelector(".platform-preview");
      aside.hidden = false;
      aside.innerHTML =
        '<h3>实时预览</h3><p class="small">网页组件预览会实时显示未保存的外观；Flutter SDK 使用相同配置，界面以客户端实际效果为准。预览消息不会发送。</p>';
      aside.append(preview);
      const launcher = document.createElement("div");
      launcher.className = "platform-launcher-preview";
      launcher.innerHTML =
        "<span data-preview-launcher>F</span><span data-preview-position></span>";
      aside.append(launcher);
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
    previewUpdate = null;
    const revision = ++renderRevision;
    const route = location.hash.match(/^#channel\/([^/]+)$/);
    if (route) {
      try {
        selected = decodeURIComponent(route[1]);
      } catch {
        selected = null;
      }
    } else if (location.hash === "#channel") selected = null;
    const [channels, tg] = await Promise.all([
      api("/access/channels"),
      api("/access/telegram"),
    ]);
    if (revision !== renderRevision) return;
    if (!selected) {
      selected =
        channels.find((c) => c.type === "web" && c.is_default)?.id ||
        channels.find((c) => c.type === "web")?.id ||
        null;
      if (selected) setPlatformRoute(selected);
    }
    const root = document.querySelector("#view");
    if (
      selected &&
      selected !== "telegram" &&
      !channels.some((c) => c.id === selected)
    )
      selected = null;
    const telegramStatus =
      telegramCheck?.revision === tg.revision
        ? telegramCheck.message
        : tg.tokenConfigured && tg.chatId
          ? "已配置 · 未检测连接"
          : "待配置";
    root.innerHTML = `<div class="platform-workspace"><aside class="platform-list"><header><div><h2>接入平台</h2><p class="small">${channels.filter((c) => c.enabled).length + (tg.enabled ? 1 : 0)} 个已启用</p></div><button id="access-create" class="primary" aria-label="添加网页或 SDK 平台">＋ 添加平台</button></header><nav aria-label="平台列表">${channels.map((c) => `<button class="platform-list-item ${selected === c.id ? "active" : ""}" data-platform="${c.id}"><span class="platform-kind">${c.type === "web" ? "网" : "SDK"}</span><span><strong>${E(c.name)}</strong><small>${c.type === "web" ? "网页端" : "Flutter / Dart"} · ${c.enabled ? "已启用" : "已停用"}</small></span><span class="platform-status ${c.enabled ? "enabled" : ""}"></span></button>`).join("")}${`<button class="platform-list-item ${selected === "telegram" ? "active" : ""}" data-platform="telegram"><span class="platform-kind">TG</span><span><strong>Telegram 客服话题</strong><small data-tg-state>${tg.enabled ? "已启用" : "未启用"} · ${E(telegramStatus)}</small></span><span class="platform-status ${tg.enabled ? "enabled" : ""}"></span></button>`}</nav></aside><section id="platform-detail" class="platform-detail"></section></div>`;
    root.querySelector("#access-create").onclick = () =>
      modal(
        "添加接入平台",
        `<p class="small">选择要连接的网站或应用。Telegram 客服话题可在左侧单独配置。</p><div class="field"><label>平台类型<select name="type"><option value="web">网页端</option><option value="sdk">Flutter / Dart SDK</option></select></label></div>`,
        "继续",
        async (values) => {
          selected = "new";
          selectedConfigTab = "basic";
          await edit(null, values.type);
        },
      );
    root.querySelectorAll("[data-platform]").forEach(
      (b) =>
        (b.onclick = safe(async () => {
          selected = b.dataset.platform;
          setPlatformRoute(selected);
          selectedConfigTab = "basic";
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
          setPlatformRoute(selected);
          selectedConfigTab = "basic";
          await render();
        })),
    );
  }
  async function edit(existing, initialType = "web") {
    const revision = renderRevision;
    const c = existing || {
      type: initialType,
      name: initialType === "sdk" ? "新应用" : "新网站",
      title: "你好，有什么可以帮你？",
      enabled: false,
      origins: [],
      widget: widgetDefaults,
      ai_mode: "off",
      agent_id: "",
      fallback_timeout: 0,
    };
    if (!existing && c.type === "sdk") {
      const saved = await api("/access/channels", {
        method: "POST",
        body: JSON.stringify(c),
      });
      selected = saved.id;
      setPlatformRoute(selected);
      await render();
      return;
    }
    if (existing && c.type === "sdk") {
      const target = document.querySelector("#platform-detail");
      target.innerHTML = `<div class="platform-config-body sdk-config-body"><section class="platform-form-main"><nav class="tabs"><button class="active" type="button">安装与接入</button></nav><div class="sdk-integration-card"><p class="notice">Key、功能、AI 接待与组件外观由默认网页端统一管理，SDK 与网页使用相同 Key。</p><pre class="code">${E(platformSnippet("sdk", location.origin, c.public_key))}</pre><button id="sdk-copy" type="button">复制接入代码</button><p><a href="/fastcat_support_sdk.zip" download>下载 Flutter SDK 与示例</a></p><button id="sdk-web" type="button">前往网页端设置</button></div></section></div>`;
      target.querySelector("#sdk-copy").onclick = safe(async () => {
        await navigator.clipboard.writeText(
          platformSnippet("sdk", location.origin, c.public_key),
        );
        toast("已复制");
      });
      target.querySelector("#sdk-web").onclick = safe(async () => {
        const channels = await api("/access/channels");
        const web = channels.find(
          (channel) => channel.type === "web" && channel.is_default,
        );
        if (web) {
          selected = web.id;
          setPlatformRoute(selected);
          await render();
        }
      });
      return;
    }
    const agents = await api("/resources?kind=agent"),
      w = { ...widgetDefaults, ...c.widget };
    if (
      revision !== renderRevision ||
      !document.querySelector("#platform-detail")
    )
      return;
    const code = () => platformSnippet(c.type, location.origin, c.public_key);
    let uploadedIcon = w.launcherIconUrl.startsWith("data:")
      ? w.launcherIconUrl
      : "";
    let uploadedLogo = w.logoUrl.startsWith("data:") ? w.logoUrl : "";
    const o = platformForm(
      existing ? c.name + " 配置" : "添加网页 / SDK 平台",
      `<section data-platform-section="basic">${!existing ? `<div class="field"><label>平台类型<select name="type"><option value="web" ${c.type === "web" ? "selected" : ""}>网页端</option><option value="sdk" ${c.type === "sdk" ? "selected" : ""}>Flutter / Dart SDK</option></select></label></div>` : ""}${input("平台名称", "name", c.name)}<label><input type="checkbox" name="enabled" ${c.enabled ? "checked" : ""}> 启用平台</label><div class="field"><label>允许的网站来源（每行一个完整 origin）<textarea name="origins" rows="2" placeholder="https://www.example.com">${E(c.origins.join("\n"))}</textarea></label><p class="small">网页嵌入与 Flutter Web 需要配置；原生 SDK 无需来源。</p><div data-local-preview><label class="retrieval-checkbox"><input type="checkbox" name="allowLocalFilePreview" ${w.allowLocalFilePreview ? "checked" : ""}>允许本地文件预览（file://）</label><p class="small">本地文件预览会允许来源为 null 的页面访问该平台；正式网站请配置具体来源。</p></div></div></section><section data-platform-section="ai"><h3>AI 接待策略</h3><div class="field"><label>接待模式<select name="ai_mode">${Object.entries(
        {
          off: "人工接待（默认）",
          auto: "AI 自动接待",
          assist: "人工优先，超时由 AI 回复",
        },
      )
        .map(
          ([v, label]) =>
            `<option value="${v}" ${v === c.ai_mode ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select></label></div><div class="field"><label>平台智能体<select name="agent_id"><option value="">工作空间默认模型助手</option>${agents.map((a) => `<option value="${a.id}" ${a.id === c.agent_id ? "selected" : ""}>${E(a.name)}</option>`).join("")}</select></label></div><div data-assist>${input("等待人工回复超时（秒；0 表示不回落 AI）", "fallback_timeout", c.fallback_timeout, "number")}</div><p class="small">人工回复、转交和主动接管会停止 AI；工作时间沿用团队管理设置，人工接待模式会在访客发送消息后自动分配在线且未满容量的客服，无人可接待时排队。修改接待策略会终止该平台正在生成的 AI 回复。</p></section><section data-platform-section="appearance"><h3>组件外观与欢迎语</h3><div class="field"><label><input type="checkbox" name="showHandoffButton" ${w.showHandoffButton ? "checked" : ""}> 显示联系人工按钮</label><p class="small">关闭后，访客会话窗口不显示联系人工按钮。</p></div><div class="platform-theme-colors">${input("浅色模式主题色", "themeColorLight", w.themeColorLight || w.themeColor, "color")}${input("深色模式主题色", "themeColorDark", w.themeColorDark || w.themeColor, "color")}</div><div class="field"><label>语言跟随方式<select name="language">${Object.entries(
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
        )}</select></label></div>${input("客服入口图标 HTTPS 地址（选填）", "launcherIconUrl", w.launcherIconUrl.startsWith("data:") ? "" : w.launcherIconUrl)}<div class="field"><label>上传客服入口图标<input id="launcher-icon-file" type="file" accept="image/png,image/jpeg,image/webp"></label><div class="upload-image-preview" id="launcher-upload-preview"></div><button type="button" id="clear-launcher-icon">使用默认图标</button><span id="launcher-icon-status" class="small">${w.launcherIconUrl.startsWith("data:") ? "已上传图标" : ""}</span></div><p class="small">留空使用项目图标；上传后统一裁切为 100×100 像素；建议使用透明 PNG 或 WebP 图片。打开会话后显示关闭图标。</p>${input("Logo HTTPS 地址（选填）", "logoUrl", uploadedLogo ? "" : w.logoUrl)}<div class="field"><label>上传聊天窗口 Logo（100×100 像素）<input id="platform-logo-file" type="file" accept="image/png,image/jpeg,image/webp"></label><div class="upload-image-preview" id="logo-upload-preview"></div><button type="button" id="clear-platform-logo">移除 Logo</button><span id="platform-logo-status" class="small">${uploadedLogo ? "已上传 Logo" : ""}</span></div><div class="field"><label>悬浮位置<select name="position">${["bottom-right", "bottom-left", "top-right", "top-left"].map((v, i) => `<option value="${v}" ${v === w.position ? "selected" : ""}>${["右下角", "左下角", "右上角", "左上角"][i]}</option>`).join("")}</select></label></div><div class="field"><label>欢迎语（中文，选填）<textarea name="welcomeMessageZh" rows="3" maxlength="3000">${E(w.welcomeMessageZh || w.welcomeMessage)}</textarea></label></div><div class="field"><label>欢迎语（English，选填）<textarea name="welcomeMessageEn" rows="3" maxlength="3000">${E(w.welcomeMessageEn || "")}</textarea></label></div><p class="small">主题色按浅色／深色模式分别配置；选择“跟随”时根据网页或客户端的明暗模式切换。Logo 与位置用于网页组件。</p><iframe id="widget-design-preview" title="聊天组件实时预览" src="/widget?preview=1" sandbox="allow-scripts allow-same-origin allow-forms"></iframe></section><section data-platform-section="integration">${existing ? `<div class="field"><label>接入 Key（网页与 SDK 通用）<input id="shared-platform-key" value="${E(c.public_key)}" minlength="16" maxlength="128" pattern="[a-zA-Z0-9_-]+"></label><button type="button" id="save-shared-platform-key">保存 Key</button><p class="small">重新部署时可填回原 Key。修改后旧 Key 失效，需要同步更新接入端。</p></div>` : ""}${existing ? `<details><summary>嵌入代码与接入标识</summary><pre class="code">${E(code())}</pre><button type="button" id="copy-platform-code">复制接入代码</button>${c.type === "sdk" ? '<p><a href="/fastcat_support_sdk.zip" download>下载 Flutter SDK 与示例</a></p>' : `<p><a href="/embed-demo.html?appKey=${c.public_key}" target="_blank" rel="noopener">打开实际嵌入演示 ↗</a></p><button type="button" id="download-platform-example">下载 HTML 接入示例</button>`}</details>` : '<p class="small">保存后即可复制接入代码；新平台默认停用。</p>'}</section>`,
      "保存",
      async (f) => {
        const payload = {
          type: f.type || c.type,
          name: f.name,
          title: c.title || c.name,
          enabled: !!f.enabled,
          origins: String(f.origins)
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
          widget: {
            themeColor: f.themeColorLight,
            themeColorLight: f.themeColorLight,
            themeColorDark: f.themeColorDark,
            language: f.language,
            theme: f.theme,
            position: f.position,
            welcomeMessage: "",
            welcomeMessageZh: f.welcomeMessageZh,
            welcomeMessageEn: f.welcomeMessageEn,
            logoUrl: f.logoUrl.trim() || uploadedLogo,
            launcherIconUrl: f.launcherIconUrl.trim() || uploadedIcon,
            allowLocalFilePreview: !!f.allowLocalFilePreview,
            showHandoffButton: !!f.showHandoffButton,
            titleZh: w.titleZh || "",
            titleEn: w.titleEn || "",
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
        setPlatformRoute(selected);
        toast("平台已保存");
        await render();
      },
    );
    for (const [id, value] of [
      ["copy-platform-code", code()],
      ["copy-platform-key", c.public_key],
    ]) {
      o.querySelector("#" + id)?.addEventListener(
        "click",
        safe(async () => {
          if (!navigator.clipboard?.writeText)
            throw Error("当前浏览器无法自动复制，请手动选择并复制。");
          await navigator.clipboard.writeText(value);
          toast("已复制");
        }),
      );
    }
    o.querySelector("#download-platform-example")?.addEventListener(
      "click",
      () => {
        const html = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>客服接入示例</title></head><body><h1>客服接入示例</h1><p>点击客服入口开始咨询。</p>\n${code()}\n</body></html>\n`;
        const url = URL.createObjectURL(
          new Blob([html], { type: "text/html;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = "fastcat-embed-example.html";
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    );
    const iconFile = o.querySelector("#launcher-icon-file"),
      iconURL = o.querySelector('[name="launcherIconUrl"]'),
      iconStatus = o.querySelector("#launcher-icon-status");
    iconURL.addEventListener("input", () => {
      uploadedIcon = "";
      iconStatus.textContent = "";
    });
    o.querySelector("#clear-launcher-icon").onclick = () => {
      uploadedIcon = "";
      iconURL.value = "";
      iconFile.value = "";
      iconStatus.textContent = "";
      update();
    };
    iconFile.onchange = async () => {
      const file = iconFile.files[0];
      if (!file) return;
      const submit = o.querySelector("button[type=submit]");
      submit.disabled = true;
      try {
        if (
          file.size > 5 * 1024 * 1024 ||
          !["image/png", "image/jpeg", "image/webp"].includes(file.type)
        )
          throw Error("请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片");
        const image = await createImageBitmap(file),
          canvas = document.createElement("canvas");
        canvas.width = canvas.height = 100;
        const side = Math.min(image.width, image.height);
        canvas
          .getContext("2d")
          .drawImage(
            image,
            (image.width - side) / 2,
            (image.height - side) / 2,
            side,
            side,
            0,
            0,
            100,
            100,
          );
        image.close();
        uploadedIcon = canvas.toDataURL("image/webp", 0.85);
        iconURL.value = "";
        iconStatus.textContent = "已上传图标";
        update();
      } catch (error) {
        iconFile.value = "";
        toast(error.message);
      } finally {
        submit.disabled = false;
      }
    };
    const logoInput = o.querySelector('[name="logoUrl"]');
    const logoFile = o.querySelector("#platform-logo-file");
    const logoStatus = o.querySelector("#platform-logo-status");
    logoInput.addEventListener("input", () => {
      uploadedLogo = "";
      logoStatus.textContent = "";
    });
    o.querySelector("#clear-platform-logo").onclick = () => {
      uploadedLogo = "";
      logoInput.value = "";
      logoFile.value = "";
      logoStatus.textContent = "";
      update();
    };
    logoFile.onchange = async () => {
      const file = logoFile.files[0];
      if (!file) return;
      const submit = o.querySelector("button[type=submit]");
      submit.disabled = true;
      try {
        if (
          file.size > 5 * 1024 * 1024 ||
          !["image/png", "image/jpeg", "image/webp"].includes(file.type)
        )
          throw Error("请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片");
        const image = await createImageBitmap(file),
          canvas = document.createElement("canvas");
        canvas.width = canvas.height = 100;
        const side = Math.min(image.width, image.height);
        canvas
          .getContext("2d")
          .drawImage(
            image,
            (image.width - side) / 2,
            (image.height - side) / 2,
            side,
            side,
            0,
            0,
            100,
            100,
          );
        image.close();
        uploadedLogo = canvas.toDataURL("image/webp", 0.85);
        logoInput.value = "";
        logoStatus.textContent = "已上传 Logo";
        update();
      } catch (error) {
        logoFile.value = "";
        toast(error.message);
      } finally {
        submit.disabled = false;
      }
    };
    const integrationDetails = o.querySelector(
      '[data-platform-section="integration"] details',
    );
    if (integrationDetails) integrationDetails.open = true;
    const update = () => {
      for (const [id, source, label] of [
        [
          "launcher-upload-preview",
          iconURL.value.trim() || uploadedIcon,
          "入口图标预览",
        ],
        [
          "logo-upload-preview",
          logoInput.value.trim() || uploadedLogo,
          "Logo 预览",
        ],
      ]) {
        const container = o.querySelector("#" + id);
        if (
          source &&
          /^(https:\/\/|data:image\/(?:png|jpeg|webp);base64,)/i.test(source)
        ) {
          if (container.dataset.source !== source) {
            const image = document.createElement("img");
            image.alt = label;
            image.src = source;
            image.referrerPolicy = "no-referrer";
            image.onerror = () => {
              container.textContent = "图片加载失败，请检查图片地址";
            };
            container.replaceChildren(image);
            container.dataset.source = source;
          }
        } else {
          container.textContent = "暂无图片";
          delete container.dataset.source;
        }
      }

      const form = o.querySelector("form"),
        mode = form.elements.ai_mode.value;
      o.querySelector("[data-assist]").hidden = mode !== "assist";
      const isWeb = (form.elements.type?.value || c.type) === "web";
      o.querySelector("[data-local-preview]").hidden = !isWeb;
      o.querySelector(".platform-launcher-preview").hidden = !isWeb;
      form.elements.allowLocalFilePreview.disabled = !isWeb;
      const preview = o.querySelector("#widget-design-preview");
      for (const name of ["themeColorLight", "themeColorDark"])
        form.elements[name].parentElement.querySelector("output").textContent =
          form.elements[name].value.toUpperCase();
      const previewMode =
        form.elements.theme.value === "auto"
          ? document.documentElement.dataset.theme || "light"
          : form.elements.theme.value;
      const previewColor =
        form.elements[
          previewMode === "dark" ? "themeColorDark" : "themeColorLight"
        ].value;
      const logoURL = form.elements.logoUrl.value.trim() || uploadedLogo;
      preview.contentWindow?.postMessage(
        {
          type: "fastcat:preview-config",
          config: {
            showHandoffButton: form.elements.showHandoffButton.checked,

            themeColor: form.elements.themeColorLight.value,
            themeColorLight: form.elements.themeColorLight.value,
            themeColorDark: form.elements.themeColorDark.value,
            welcomeMessageZh: form.elements.welcomeMessageZh.value,
            welcomeMessageEn: form.elements.welcomeMessageEn.value,
            logoUrl: logoURL,
            language: form.elements.language.value,
            theme: form.elements.theme.value,
            hostLanguage: document.documentElement.lang,
            hostTheme: document.documentElement.dataset.theme,
          },
        },
        location.origin,
      );
      const launcher = o.querySelector("[data-preview-launcher]");
      const icon = iconURL.value.trim() || uploadedIcon;
      launcher.replaceChildren();
      if (/^(https:\/\/|data:image\/(?:png|jpeg|webp);base64,)/i.test(icon)) {
        const image = document.createElement("img");
        image.alt = "";
        image.referrerPolicy = "no-referrer";
        image.onerror = () => {
          launcher.textContent = "F";
        };
        image.src = icon;
        launcher.append(image);
      } else launcher.textContent = "F";
      launcher.style.background = previewColor;
      const rgb = [1, 3, 5]
        .map(
          (index) => parseInt(previewColor.slice(index, index + 2), 16) / 255,
        )
        .map((value) =>
          value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
        );
      launcher.style.color =
        0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.179
          ? "#000"
          : "#fff";
      o.querySelector("[data-preview-position]").textContent =
        "网页入口位置：" +
        ({
          "bottom-right": "右下角",
          "bottom-left": "左下角",
          "top-right": "右上角",
          "top-left": "左上角",
        }[form.elements.position.value] || "右下角");
    };
    const preview = o.querySelector("#widget-design-preview");
    previewUpdate = (source) => {
      if (o.isConnected && source === preview.contentWindow) update();
    };
    preview.addEventListener("load", update);
    o.querySelector("form").addEventListener("input", update);
    update();
    o.querySelector("#save-shared-platform-key")?.addEventListener(
      "click",
      safe(async () => {
        const key = o.querySelector("#shared-platform-key").value.trim();
        await api("/access/channels/" + c.id + "/key", {
          method: "POST",
          body: JSON.stringify({ key, expectedRevision: c.revision }),
        });
        toast("Key 已保存");
        await render();
      }),
    );
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
      `<section data-platform-section="basic"><p class="small">将 Bot 加入启用话题的超级群组，并设为具有管理话题权限的管理员。客服需绑定个人 Telegram 数字 ID；匿名管理员消息不支持。客服权限与工作台一致。</p><label><input name="enabled" type="checkbox" ${c.enabled ? "checked" : ""}> 启用人工话题转发</label>${input("Bot Token（留空保留，服务端加密）", "botToken", "", "password")}${input("或密钥环境变量（FC_SECRET_ 前缀）", "tokenEnv", c.tokenEnv)}${input("目标超级群组 ID", "chatId", c.chatId)}${input("服务公网 HTTPS 地址", "publicBaseUrl", c.publicBaseUrl)}${input("首次带入最近消息数（0 表示仅最近一条）", "contextMessages", c.contextMessages, "number")}</section><section data-platform-section="operators"><h3>客服身份绑定</h3><div id="tg-operators"></div><button type="button" id="tg-add">＋ 绑定客服</button><p class="small">只将已绑定的客服话题回复传给用户。内部备注不转发，已结束会话不接收回复。</p></section><section data-platform-section="diagnostics"><div class="row"><button type="button" id="tg-status">消息与话题</button><button type="button" id="tg-test">检测已保存连接</button><button type="button" id="tg-webhook">注册已保存回调</button></div><p class="small">${c.pollingEnabled ? "当前使用轮询接收 Telegram 回复，无需公网 HTTPS 回调。" : "首次配置或更换 Bot / 群组后，保存并注册回调。"} Token ${c.tokenConfigured ? "已配置" : "未配置"}。</p></section>`,
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
    const connectionState = document.createElement("p");
    connectionState.className = "small";
    connectionState.setAttribute("role", "status");
    connectionState.textContent =
      telegramCheck?.revision === c.revision
        ? telegramCheck.message
        : c.tokenConfigured && c.chatId
          ? "已配置，尚未检测连接"
          : "待配置 Bot 和群组";
    o.querySelector("#tg-test").closest(".row").after(connectionState);
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
        try {
          await api("/access/telegram/" + path, { method: "POST" });
          if (path === "test") {
            telegramCheck = {
              revision: c.revision,
              message: "最近一次检测：群组与机器人权限正常",
            };
            connectionState.textContent = telegramCheck.message;
            const label = document.querySelector("[data-tg-state]");
            if (label)
              label.textContent =
                (c.enabled ? "已启用 · " : "未启用 · ") + telegramCheck.message;
          }
          toast(path === "test" ? "群组与机器人权限正常" : "回调注册成功");
        } catch (error) {
          if (path === "test") {
            telegramCheck = {
              revision: c.revision,
              message: "最近一次检测失败：" + error.message,
            };
            connectionState.textContent = telegramCheck.message;
            const label = document.querySelector("[data-tg-state]");
            if (label)
              label.textContent =
                (c.enabled ? "已启用 · " : "未启用 · ") + telegramCheck.message;
          }
          throw error;
        }
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
