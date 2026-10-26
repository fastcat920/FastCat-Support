import { randomId } from "./ids.js";
const DB = "fastcat-outbox-v1";
let connection;
function database() {
  return (connection ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("messages", { keyPath: "key" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(Error("无法打开本地待发队列"));
  }));
}
async function store(mode, operation) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", mode),
      r = operation(tx.objectStore("messages"));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(Error("本地待发队列保存失败，可能存储空间不足"));
    tx.onabort = tx.onerror;
  });
}
export async function purgeOutbox(owner) {
  const rows = await store("readonly", (s) => s.getAll());
  for (const r of rows.filter((r) => r.owner === owner))
    await store("readwrite", (s) => s.delete(r.key));
}
export function createOutbox({
  owner,
  send,
  onChange = () => {},
  canSend = () => true,
}) {
  let requested = false,
    active = false,
    closed = false,
    timer,
    delay = 1000;
  const list = async () =>
    (await store("readonly", (s) => s.getAll()))
      .filter((r) => r.owner === owner)
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  async function notify() {
    if (!closed) onChange(await list());
  }
  async function enqueue(message) {
    if (closed) throw Error("待发队列已关闭");
    const rows = await list();
    if (closed) throw Error("身份已变化，未保存待发消息");
    if (
      rows.length >= 100 ||
      rows.reduce((n, r) => n + (r.file?.size || 0), 0) +
        (message.file?.size || 0) >
        32 * 1024 * 1024
    )
      throw Error("待发队列已满，请先处理已有消息");
    const id = message.id || randomId(),
      record = {
        ...message,
        id,
        owner,
        key: owner + "|" + id,
        created: Math.max(Date.now(), ...rows.map((r) => r.created + 1)),
        state: "queued",
        error: "",
      };
    await store("readwrite", (s) => s.put(record));
    if (closed) {
      await store("readwrite", (s) => s.delete(record.key));
      throw Error("身份已变化，未保存待发消息");
    }
    await notify();
    flush();
    return id;
  }
  async function flush() {
    if (active) {
      requested = true;
      return;
    }
    if (closed || !canSend() || navigator.onLine === false) return;
    clearTimeout(timer);
    active = true;
    try {
      for (const record of await list()) {
        if (closed || !canSend()) break;
        if (record.state === "failed") continue;
        try {
          await send(record);
          await store("readwrite", (s) => s.delete(record.key));
          delay = 1000;
          await notify();
        } catch (e) {
          if (closed) break;
          if (
            e.status >= 400 &&
            e.status < 500 &&
            ![408, 429].includes(e.status)
          ) {
            record.state = "failed";
            record.error = e.message;
            await store("readwrite", (s) => s.put(record));
            await notify();
            if (e.status === 401 || e.status === 403 || e.status === 409) break;
          } else {
            timer = setTimeout(flush, delay);
            delay = Math.min(30000, delay * 2);
            break;
          }
        }
      }
    } finally {
      active = false;
      if (requested) {
        requested = false;
        queueMicrotask(flush);
      }
    }
  }
  async function retry(id) {
    const r = (await list()).find((r) => r.id === id);
    if (!r) return;
    r.state = "queued";
    r.error = "";
    await store("readwrite", (s) => s.put(r));
    await notify();
    flush();
  }
  async function discard(id) {
    const r = (await list()).find((r) => r.id === id);
    if (r) await store("readwrite", (s) => s.delete(r.key));
    await notify();
  }
  const online = () => flush();
  window.addEventListener("online", online);
  notify()
    .then(flush)
    .catch((e) => onChange([], { error: e.message }));
  return {
    enqueue,
    list,
    flush,
    retry,
    discard,
    close() {
      closed = true;
      clearTimeout(timer);
      window.removeEventListener("online", online);
    },
  };
}
export function outboxHTML(rows, E) {
  return rows.length
    ? `<div class="outbox-status" role="status">${rows.map((r) => `<div class="outbox-item"><span>${E((r.body || r.filename || "附件").slice(0, 50))} · ${r.state === "failed" ? E(r.error || "发送失败") : "等待发送"}</span><button type="button" data-outbox-retry="${r.id}">重试</button><button type="button" data-outbox-discard="${r.id}">移除</button></div>`).join("")}</div>`
    : "";
}
export function bindOutbox(root, outbox) {
  root
    ?.querySelectorAll("[data-outbox-retry]")
    .forEach((b) => (b.onclick = () => outbox.retry(b.dataset.outboxRetry)));
  root
    ?.querySelectorAll("[data-outbox-discard]")
    .forEach(
      (b) => (b.onclick = () => outbox.discard(b.dataset.outboxDiscard)),
    );
}
