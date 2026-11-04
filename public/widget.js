import { localizedError } from "./error-message.js";
import {
  configurationKey,
  readConfiguration,
  saveConfiguration,
  validConfiguration,
} from "./configuration-cache.js";
import { randomId } from "./ids.js";
import { widgetChatMarkup } from "./widget-chat-markup.js";
import { withMessageDays } from "./message-days.js";
import { receiptMarkup } from "./message-status.js";
import { setLanguage, observeLanguage } from "./i18n.js";
import { resolveAppearance, applyAppearance } from "./appearance.js";
import { bindComposer, createMessageSound } from "./chat-controls.js";
import { renderMessage, bindMessageActions } from "./message-renderer.js";
import { createOutbox, outboxHTML, bindOutbox, purgeOutbox } from "./outbox.js";
import { createMediaUI } from "./media.js";
const root = document.querySelector("#widget-content"),
  E = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const appKey = new URL(location.href).searchParams.get("appKey") || "";
const storageKey = "fc_visitor" + (appKey ? ":" + appKey : "");
function widgetURL(path) {
  const u = new URL("/api/widget" + path, location.origin);
  if (appKey) u.searchParams.set("appKey", appKey);
  return u.href;
}
let followLatest = true,
  hostOpened = false;
function scrollLatest() {
  requestAnimationFrame(() => {
    const messages = document.querySelector("#messages");
    if (messages) messages.scrollTop = messages.scrollHeight;
  });
}
for (const type of ["wheel", "touchmove", "pointerdown"]) {
  document.addEventListener(
    type,
    (event) => {
      if (event.target.closest?.("#messages")) followLatest = false;
    },
    { passive: true },
  );
}
let appearanceConfig = {},
  hostAppearance = {},
  hostVisitor = {},
  lastVisitor = "";
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
function updateAppearance() {
  const appearance = resolveAppearance(appearanceConfig, hostAppearance, {
    language: navigator.language,
    dark: systemTheme.matches,
  });
  setLanguage(appearance.language);
  applyAppearance(appearance);
  const notice = root.querySelector(".error");
  if (notice?.textContent && notice.dataset.error) error(notice.dataset.error);
  for (const node of document.querySelectorAll("[data-welcome]")) {
    node.textContent =
      (appearance.language === "en"
        ? appearanceConfig.welcomeMessageEn
        : appearanceConfig.welcomeMessageZh) || node.textContent;
  }
  const title =
    appearance.language === "en"
      ? appearanceConfig.titleEn
      : appearanceConfig.titleZh;
  if (title || appearanceConfig.fallbackTitle)
    document.querySelector(".widget-shell header h2").textContent =
      title || appearanceConfig.fallbackTitle;
}
observeLanguage();
updateAppearance();
systemTheme.addEventListener("change", updateAppearance);
window.addEventListener("languagechange", updateAppearance);
let parentOrigin;
try {
  parentOrigin = new URL(document.referrer).origin;
} catch {}
window.addEventListener("message", (event) => {
  if (
    event.source !== parent ||
    !(parentOrigin && parentOrigin !== "null"
      ? event.origin === parentOrigin
      : appearanceConfig.allowLocalFilePreview && event.origin === "null") ||
    event.data?.type !== "fastcat:appearance"
  )
    return;
  const value = event.data;
  if (value.opened === true && !hostOpened) {
    followLatest = true;
    scrollLatest();
    refreshConfiguration();
    if (session) refresh();
  }
  if (typeof value.opened === "boolean") hostOpened = value.opened;
  if (
    value.visitor &&
    typeof value.visitor === "object" &&
    !Array.isArray(value.visitor)
  ) {
    hostVisitor = value.visitor;
    const input = root.querySelector("#email");
    if (input && !input.value && typeof hostVisitor.email === "string")
      input.value = hostVisitor.email;
    const current = JSON.stringify(hostVisitor);
    if (session && Object.keys(hostVisitor).length && current !== lastVisitor) {
      lastVisitor = current;
      api("/profile", "POST", { ...hostVisitor, id: session.id }).catch(() => {
        if (lastVisitor === current) lastVisitor = "";
      });
    }
  }
  hostAppearance = {
    language:
      typeof value.language === "string"
        ? value.language.slice(0, 35)
        : undefined,
    theme: value.theme,
  };
  updateAppearance();
});
if (parent !== window && parentOrigin && parentOrigin !== "null")
  parent.postMessage({ type: "fastcat:ready" }, parentOrigin);
const appearanceStorageKey = configurationKey(location.origin, appKey);
function applyConfiguration(c) {
  if (c.title)
    document.querySelector(".widget-shell header h2").textContent = c.title;
  const w = c.widget || {};
  appearanceConfig = { ...w, fallbackTitle: c.title };
  document.querySelector("#widget-handoff").hidden =
    w.showHandoffButton === false;
  if (
    parent !== window &&
    (!parentOrigin || parentOrigin === "null") &&
    w.allowLocalFilePreview
  )
    parent.postMessage({ type: "fastcat:ready" }, "*");
  updateAppearance();
  document.body.classList.remove("widget-loading");
  document.querySelector("#widget-loading-status")?.remove();
}
let cachedConfiguration = window.__fastcatCachedConfiguration;
try {
  cachedConfiguration ||= readConfiguration(appearanceStorageKey);
} catch {}
if (cachedConfiguration) applyConfiguration(cachedConfiguration);
let configurationRequest;
function refreshConfiguration() {
  if (configurationRequest) return configurationRequest;
  const prefetched = window.__fastcatConfigurationRequest;
  delete window.__fastcatConfigurationRequest;
  configurationRequest = (
    prefetched ||
    fetch(widgetURL("/config"), { signal: AbortSignal.timeout(15000) }).then(
      (response) => {
        if (!response.ok) throw Error("Configuration unavailable");
        return response.json();
      },
    )
  )
    .then((c) => {
      if (!validConfiguration(c)) throw Error("Invalid configuration");
      saveConfiguration(appearanceStorageKey, c);
      applyConfiguration(c);
    })
    .catch(() => {
      const status = document.querySelector("#widget-loading-status");
      if (status)
        status.textContent =
          "加载失败，请刷新重试 / Unable to load. Please refresh.";
    })
    .finally(() => {
      configurationRequest = null;
    });
  return configurationRequest;
}
refreshConfiguration();
const messageSound = createMessageSound();
let knownMessages = null;
let session;
try {
  session = JSON.parse(sessionStorage.getItem(storageKey));
} catch {}
const directMessages = new Map();
function drawDirectMessages() {
  const box = document.querySelector("#messages");
  if (!box) return;
  box
    .querySelectorAll("[data-direct-message]")
    .forEach((node) => node.remove());
  for (const record of directMessages.values()) {
    if (record.session.id !== session?.id) continue;
    const node = document.createElement("div");
    node.className = "message agent";
    node.dataset.directMessage = record.id;
    node.innerHTML = `<div class="message-line"><div class="bubble"><div class="bubble-content">${record.file ? (record.file.type.startsWith("image/") ? `<img src="${E(record.preview)}" style="max-width:200px;max-height:280px" alt="${E(record.file.name)}">` : E(record.file.name)) : E(record.body)}</div><button type="button" class="direct-send-status ${record.state}" aria-label="${record.state === "failed" ? "发送失败，点击重试" : record.state === "sent" ? "已发送" : "发送中"}" title="${E(record.error ? localizedError(record.error, document.documentElement.lang) : "")}" ${record.state !== "failed" ? "disabled" : ""}>${record.state === "failed" ? "!" : record.state === "sent" ? "✓" : '<span class="send-spinner"></span>'}</button></div></div>`;
    node.querySelector("button").onclick = () => sendDirect(record);
    const preview = node.querySelector("img");
    if (preview) {
      preview.style.cursor = "zoom-in";
      preview.onclick = () => {
        const overlay = document.createElement("div");
        overlay.className = "image-lightbox";
        overlay.innerHTML = `<button type="button" aria-label="关闭图片预览">×</button><img src="${E(record.preview)}" alt="图片预览">`;
        overlay.onclick = () => overlay.remove();
        document.body.append(overlay);
      };
    }
    box.append(node);
  }
}
async function sendDirect(record) {
  if (record.active || record.session.id !== session?.id) return;
  record.active = true;
  record.state = "sending";
  drawDirectMessages();
  try {
    if (record.file) {
      const response = await fetch(
        widgetURL("/attachments?id=" + record.session.id),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + record.session.token,
            "X-Filename": encodeURIComponent(record.file.name),
            "X-Client-Id": record.id,
          },
          body: record.file,
        },
      );
      if (!response.ok)
        throw Error((await response.json()).error || "发送失败");
    } else
      await api("/messages", "POST", {
        id: record.session.id,
        body: record.body,
        clientId: record.id,
      });
    record.state = "sent";
    await refresh();
  } catch (error) {
    record.state = "failed";
    record.error = error.message;
  } finally {
    record.active = false;
    drawDirectMessages();
  }
}
const media = createMediaUI({ E, getSession: () => session }),
  requestIds = new Map();
let timer,
  last = "",
  busy = false,
  queued = false,
  streamController,
  reconnectTimer,
  uploading = false,
  sending = false;
let outbox,
  pending = [],
  receiptCursor = 0,
  readCursor = 0;
async function api(path, method = "GET", data) {
  const current = session;
  const response = await fetch(widgetURL(path), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(current ? { Authorization: "Bearer " + current.token } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const d = await response.json();
  if (!response.ok) {
    if (response.status === 403 && session?.id === current?.id) {
      sessionStorage.removeItem(storageKey);
      session = null;
      start();
    }
    throw Object.assign(Error(d.error), { status: response.status });
  }
  return d;
}
function error(message) {
  const el = root.querySelector(".error");
  if (!el) return;
  el.dataset.error = message;
  el.textContent = localizedError(message, document.documentElement.lang);
}

function start() {
  clearInterval(timer);
  streamController?.abort();
  clearTimeout(reconnectTimer);
  outbox?.close();
  media.clear();
  requestIds.clear();
  document.querySelector("#widget-handoff").hidden = true;
  document.querySelector("#widget-service-status").textContent = "";
  root.innerHTML =
    '<form class="start"><h2>开始一段对话</h2><p class="muted">留下邮箱，我们会尽快回复你。</p><div class="field"><label for="email">邮箱</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="email" placeholder="请输入邮箱"></div><p class="error" role="alert"></p><button class="primary">开始咨询 →</button></form>';
  if (typeof hostVisitor.email === "string")
    root.querySelector("#email").value = hostVisitor.email;
  root.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    try {
      session = await api("/start", "POST", {
        ...hostVisitor,
        ...Object.fromEntries(new FormData(e.target)),
      });
      lastVisitor = JSON.stringify(hostVisitor);
      sessionStorage.setItem(storageKey, JSON.stringify(session));
      chat();
    } catch (err) {
      error(err.message);
      button.disabled = false;
    }
  };
}
function chat() {
  followLatest = true;
  const currentSession = session;
  knownMessages = null;
  receiptCursor = 0;
  readCursor = 0;
  outbox?.close();
  root.innerHTML = widgetChatMarkup;
  document.querySelector("#widget-handoff").hidden =
    appearanceConfig.showHandoffButton === false;
  bindComposer(root.querySelector("form"));
  document.querySelector("#widget-sound").onclick = (e) => {
    const enabled = messageSound.toggle();

    e.currentTarget.setAttribute(
      "aria-label",
      enabled ? "声音：开" : "声音：关",
    );
    e.currentTarget.title = enabled ? "声音：开" : "声音：关";
    e.currentTarget.setAttribute("aria-pressed", String(enabled));
  };
  document.querySelector("#upload-file").onclick = () =>
    document.querySelector("#widget-file").click();
  document.querySelector("#widget-file").onchange = upload;
  root.querySelector("form").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const text = form.body.value.trim();
    if (!text || !session) return;
    const record = {
      id: randomId(),
      body: text,
      session: { ...session },
      state: "sending",
    };
    followLatest = true;
    directMessages.set(record.id, record);
    form.body.value = "";
    form.body.dispatchEvent(new Event("input", { bubbles: true }));
    drawDirectMessages();
    sendDirect(record);
  };
  document.querySelector("#widget-handoff").onclick = async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      await api("/handoff", "POST", { id: session.id });
      await refresh();
    } catch (err) {
      error(err.message);
      button.disabled = false;
    }
  };
  last = "";
  refresh();
  streamController?.abort();
  streamController = new AbortController();
  connectEvents(session, streamController.signal);
  clearInterval(timer);
  timer = setInterval(refresh, 30000);
}
async function upload(e) {
  const file = e.target.files[0],
    current = session;
  if (!file) return;
  if (file.size > 8 * 1024 * 1024 || !file.size) {
    error("请选择不超过 8 MB 的非空文件");
    e.target.value = "";
    return;
  }
  try {
    const record = {
      id: randomId(),
      body: "",
      file,
      preview: URL.createObjectURL(file),
      session: { ...current },
      state: "sending",
    };
    followLatest = true;
    directMessages.set(record.id, record);
    await sendDirect(record);
  } catch (err) {
    error(err.message);
  } finally {
    e.target.value = "";
  }
}
async function refresh() {
  if (!session) return;
  if (busy) {
    queued = true;
    return;
  }
  busy = true;
  const currentId = session.id;
  try {
    const d = await api("?id=" + encodeURIComponent(currentId));
    if (session?.id !== currentId) return;
    const m = d.messages.filter((x) => x.role !== "note"),
      a = d.automation || {},
      json = JSON.stringify([m, a, d.receipts]);
    if (
      knownMessages &&
      m.some(
        (x) =>
          !knownMessages.has(x.id) &&
          x.role !== "visitor" &&
          x.source !== "system",
      )
    )
      messageSound.play();
    for (const message of m)
      if (message.client_id) {
        const record = directMessages.get(message.client_id);
        if (record?.preview) URL.revokeObjectURL(record.preview);
        directMessages.delete(message.client_id);
      }
    const newReply = knownMessages && m.some(x => !knownMessages.has(x.id) && x.role !== "visitor");
    knownMessages = new Set(m.map((x) => x.id));
    if (json !== last) {
      last = json;
      const el = document.querySelector("#messages");
      if (el) {
        el.innerHTML =
          withMessageDays(
            m,
            (x) =>
              `<div class="message ${x.role === "visitor" ? "agent" : "with-sender-avatar"}">${x.role !== "visitor" ? `<span class="sender-avatar">${x.senderAvatar ? `<img src="${E(x.senderAvatar)}" alt="客服头像">` : x.source === "ai" ? "✧" : ["system", "welcome"].includes(x.source) ? "·" : E((x.senderName || "客服").slice(0, 1))}</span><div class="sender-name">${x.source === "ai" ? "AI 助手" : ["system", "welcome"].includes(x.source) ? "系统" : E(x.senderName || "客服")}</div>` : ""}<div class="message-line"><div class="bubble ${x.attachment ? "attachment-bubble" : ""}"><div class="bubble-content" ${x.source === "welcome" ? "data-welcome" : ""}>${x.attachment ? media.render(x.attachment) : renderMessage(x.source === "welcome" ? (document.documentElement.lang.startsWith("en") ? appearanceConfig.welcomeMessageEn : appearanceConfig.welcomeMessageZh) || x.body : x.body, { plain: x.role === "visitor" })}</div><span class="message-time">${new Date(x.created).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}${x.role === "visitor" ? " " + receiptMarkup(x.seq, d.receipts) : ""}</span></div></div></div>`,
          ) +
          (a.typing
            ? `<div class="message with-sender-avatar"><span class="sender-avatar">${a.aiAvatar ? `<img src="${E(a.aiAvatar)}" alt="AI客服头像">` : "✧"}</span><div class="sender-name">AI 助手</div><div class="message-line"><div class="bubble ai-stream">${E(a.draft || "正在思考…")}<span class="typing-dot"></span></div></div></div>`
            : "");
        if (!m.length && !a.typing)
          el.innerHTML =
            '<p class="small">你好，请描述你的问题，客服会在这里回复。</p>';
        media.bind(el);
        bindMessageActions(el, (text) => {
          const input = root.querySelector("[name=body]");
          if (input) {
            input.value = text;
            input.focus();
          }
        });
        if (newReply || a.typing || followLatest) {
          followLatest = true;
          scrollLatest();
          followLatest = false;
        }
      }
    }
    drawDirectMessages();
    const seq = d.receipts?.lastSeq || 0,
      box = document.querySelector("#messages"),
      visible =
        document.visibilityState === "visible" &&
        box &&
        box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    if (seq > receiptCursor || (visible && seq > readCursor)) {
      await api("/receipts", "POST", {
        id: currentId,
        deliveredSeq: seq,
        readSeq: visible ? seq : readCursor,
      });
      receiptCursor = seq;
      if (visible) readCursor = seq;
    }
    if (root.querySelector(".error"))
      root.querySelector(".error").textContent = "";
    const closed = d.conversation.status === "closed";
    root.querySelector("textarea").disabled = false;
    root.querySelector("button.primary").disabled = sending;
    document.querySelector("#upload-file").disabled = uploading;
    const handoff = document.querySelector("#widget-handoff");
    handoff.disabled = closed || a.handoffRequested;
    handoff.textContent = a.handoffRequested ? "已请求人工" : "联系人工";
    document.querySelector("#widget-service-status").textContent = closed
      ? "会话已结束"
      : a.mode === "ai"
        ? "AI 助手接待中"
        : d.conversation.assigned
          ? "人工客服接待中"
          : "等待客服接待";
    if (closed) error("本次会话已结束，发送消息即可继续咨询。");
  } catch (err) {
    error(err.message);
  } finally {
    busy = false;
    if (queued) {
      queued = false;
      refresh();
    }
  }
}
async function connectEvents(current, signal) {
  try {
    const response = await fetch(
      widgetURL("/events?id=" + encodeURIComponent(current.id)),
      { headers: { Authorization: "Bearer " + current.token }, signal },
    );
    if (!response.ok) throw Error("实时连接不可用");
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (event.includes("data: update")) refresh();
      }
    }
  } catch (e) {
    if (signal.aborted) return;
  }
  if (!signal.aborted && session?.id === current.id)
    reconnectTimer = setTimeout(() => connectEvents(current, signal), 2000);
}
document.addEventListener("visibilitychange", () => {
  if (session) refresh();
});
window.addEventListener("online", () => {
  if (session) refresh();
});
root.addEventListener(
  "scroll",
  () => {
    if (session) refresh();
  },
  true,
);
if (!new URL(location.href).searchParams.has("sdkBootstrap")) {
  if (session) chat();
  else start();
}

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
