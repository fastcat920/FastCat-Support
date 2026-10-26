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
fetch(widgetURL("/config"))
  .then((r) => r.json())
  .then((c) => {
    if (c.title)
      document.querySelector(".widget-shell header h2").textContent = c.title;
    const w = c.widget || {},
      color = w.themeColor;
    if (/^#[0-9a-f]{6}$/i.test(color || "")) {
      const rgb = [1, 3, 5]
        .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
        .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
      const light = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      document.documentElement.style.setProperty("--brand", color);
      document.documentElement.style.setProperty(
        "--brand-fg",
        light > 0.179 ? "#000000" : "#ffffff",
      );
    }
    if (w.logoUrl) {
      const image = document.createElement("img");
      image.src = w.logoUrl;
      image.alt = "";
      image.width = 36;
      image.height = 36;
      image.referrerPolicy = "no-referrer";
      image.className = "widget-logo";
      image.onerror = () => image.remove();
      document.querySelector(".widget-shell header").prepend(image);
    }
  })
  .catch(() => {});
const messageSound = createMessageSound();
let knownMessages = null;
let session;
try {
  session = JSON.parse(sessionStorage.getItem(storageKey));
} catch {}
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
  if (el)
    el.textContent = /Failed to fetch|Load failed|NetworkError/.test(message)
      ? "网络暂不可用，待发消息已保留。"
      : message;
}
function start() {
  clearInterval(timer);
  streamController?.abort();
  clearTimeout(reconnectTimer);
  outbox?.close();
  media.clear();
  requestIds.clear();
  document.querySelector("#widget-handoff").hidden = true;
  document.querySelector("#widget-service-status").textContent = "在线客服";
  root.innerHTML =
    '<form class="start"><h2>开始一段对话</h2><p class="muted">留下称呼，我们会尽快回复你。</p><div class="field"><label for="name">怎么称呼你</label><input id="name" name="name" required maxlength="100" placeholder="你的姓名"></div><div class="field"><label for="email">邮箱（选填）</label><input id="email" name="email" type="email" placeholder="方便我们联系你"></div><p class="error" role="alert"></p><button class="primary">开始咨询 →</button></form>';
  root.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    try {
      session = await api(
        "/start",
        "POST",
        Object.fromEntries(new FormData(e.target)),
      );
      sessionStorage.setItem(storageKey, JSON.stringify(session));
      chat();
    } catch (err) {
      error(err.message);
      button.disabled = false;
    }
  };
}
function chat() {
  const currentSession = session;
  knownMessages = null;
  receiptCursor = 0;
  readCursor = 0;
  outbox?.close();
  root.innerHTML =
    '<div class="messages" id="messages"></div><p class="error" role="alert"></p><div id="widget-outbox"></div><form class="composer"><textarea name="body" maxlength="10000" aria-label="消息内容" placeholder="输入你想咨询的问题…"></textarea><input id="widget-file" type="file" hidden><div class="composer-footer"><div class="row"><button id="widget-sound" type="button" class="quiet small" aria-pressed="true" title="收到新消息时播放声音">声音：开</button><button id="upload-file" type="button" class="quiet small" aria-label="上传并发送附件">⌁ 附件</button></div><span class="small send-hint">Enter 发送 · Shift+Enter 换行</span><button class="primary" type="submit">发送 ↗</button></div></form>';
  outbox = createOutbox({
    owner: "visitor:" + currentSession.id,
    canSend: () => session?.id === currentSession.id,
    send: async (r) => {
      if (r.file) {
        const response = await fetch(
          widgetURL("/attachments?id=" + currentSession.id),
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + currentSession.token,
              "X-Filename": encodeURIComponent(r.filename),
              "X-Client-Id": r.id,
            },
            body: r.file,
          },
        );
        if (!response.ok) {
          const d = await response.json();
          throw Object.assign(Error(d.error), { status: response.status });
        }
      } else
        await api("/messages", "POST", {
          id: currentSession.id,
          body: r.body,
          clientId: r.id,
        });
      refresh();
    },
    onChange: (rows) => {
      if (session?.id !== currentSession.id) return;
      pending = rows;
      const el = document.querySelector("#widget-outbox");
      if (el) {
        el.innerHTML = outboxHTML(rows, E);
        bindOutbox(el, outbox);
      }
    },
  });
  document.querySelector("#widget-handoff").hidden = false;
  bindComposer(root.querySelector("form"));
  document.querySelector("#widget-sound").onclick = (e) => {
    const enabled = messageSound.toggle();
    e.currentTarget.textContent = enabled ? "声音：开" : "声音：关";
    e.currentTarget.setAttribute("aria-pressed", String(enabled));
  };
  document.querySelector("#upload-file").onclick = () =>
    document.querySelector("#widget-file").click();
  document.querySelector("#widget-file").onchange = upload;
  root.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    if (sending) return;
    const form = e.currentTarget,
      text = form.body.value.trim();
    if (!text) return;
    sending = true;
    try {
      await outbox.enqueue({ conversationId: session.id, body: text });
      form.body.value = "";
    } catch (err) {
      error(err.message);
    } finally {
      sending = false;
    }
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
    await outbox.enqueue({
      conversationId: current.id,
      file,
      filename: file.name,
    });
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
    knownMessages = new Set(m.map((x) => x.id));
    if (json !== last) {
      last = json;
      const el = document.querySelector("#messages");
      if (el) {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        el.innerHTML =
          m
            .map(
              (x) =>
                `<div class="message ${x.role === "visitor" ? "agent" : ""}"><div class="bubble ${x.attachment ? "attachment-bubble" : ""}">${x.attachment ? media.render(x.attachment) : renderMessage(x.body, { plain: x.role === "visitor" })}</div><div class="small">${x.role === "visitor" ? "你" : x.source === "ai" ? "AI 助手" : x.source === "system" ? "系统" : E(x.senderName || "客服")}${x.role === "visitor" ? (x.seq <= d.receipts?.readSeq ? " · 已读" : x.seq <= d.receipts?.deliveredSeq ? " · 已送达" : " · 已发送") : ""} · ${new Date(x.created).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</div></div>`,
            )
            .join("") +
          (a.typing
            ? `<div class="message"><div class="bubble ai-stream">${E(a.draft || "正在思考…")}<span class="typing-dot"></span></div><div class="small">AI 助手 · 正在回复</div></div>`
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
        if (atBottom) el.scrollTop = el.scrollHeight;
      }
    }
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
    root.querySelector("textarea").disabled = closed;
    root.querySelector("button.primary").disabled = closed || sending;
    document.querySelector("#upload-file").disabled = closed || uploading;
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
    if (closed) error("本次会话已结束，感谢您的咨询。");
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
if (session) chat();
else start();

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
