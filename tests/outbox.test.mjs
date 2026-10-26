import { webcrypto } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { setTimeout as delay } from "node:timers/promises";
import { createOutbox, purgeOutbox } from "../public/outbox.js";
Object.defineProperty(globalThis, "indexedDB", {
  value: indexedDB,
  configurable: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: false },
  configurable: true,
});
globalThis.window = new EventTarget();
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(5);
  }
  throw Error("queue did not settle");
}
test("offline outbox persists text and blobs after recreation and isolates owner queues", async () => {
  const sent = [];
  let a = createOutbox({ owner: "staff:a", send: async (r) => sent.push(r) }),
    b = createOutbox({
      owner: "staff:b",
      send: async () => {
        throw Error("must not send");
      },
    });
  await a.enqueue({
    conversationId: "c1",
    body: "offline text",
    id: "stable-client-0001",
  });
  await a.enqueue({
    conversationId: "c1",
    file: new Blob(["file bytes"]),
    filename: "a.txt",
  });
  await b.enqueue({ conversationId: "private", body: "other account" });
  assert.equal(sent.length, 0);
  a.close();
  a = createOutbox({ owner: "staff:a", send: async (r) => sent.push(r) });
  assert.equal((await a.list()).length, 2);
  navigator.onLine = true;
  await a.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].id, "stable-client-0001");
  assert.equal(await sent[1].file.text(), "file bytes");
  assert.equal((await a.list()).length, 0);
  assert.equal((await b.list()).length, 1);
  a.close();
  b.close();
  await purgeOutbox("staff:b");
  navigator.onLine = false;
});
test("lost response retries with same client id; forbidden messages fail visibly without automatic retry", async () => {
  let attempts = 0;
  const ids = [];
  const a = createOutbox({
    owner: "visitor:c",
    send: async (r) => {
      attempts++;
      ids.push(r.id);
      if (attempts === 1) throw Error("network lost");
    },
  });
  await a.enqueue({ body: "hello" });
  navigator.onLine = true;
  await a.flush();
  assert.equal((await a.list()).length, 1);
  await a.flush();
  assert.equal((await a.list()).length, 0);
  assert.equal(ids[0], ids[1]);
  a.close();
  let calls = 0;
  const b = createOutbox({
    owner: "staff:revoked",
    send: async () => {
      calls++;
      throw Object.assign(Error("会话已转交"), { status: 403 });
    },
  });
  await b.enqueue({ body: "private" });
  await until(async () => (await b.list())[0]?.state === "failed");
  await b.flush();
  assert.equal(calls, 1);
  assert.equal((await b.list())[0].error, "会话已转交");
  await b.discard((await b.list())[0].id);
  assert.equal((await b.list()).length, 0);
  b.close();
  navigator.onLine = false;
});
test("enqueue during active flush is drained and identity change blocks delivery", async () => {
  let release;
  const gate = new Promise((r) => (release = r)),
    sent = [];
  let valid = true;
  const a = createOutbox({
    owner: "staff:concurrent",
    canSend: () => valid,
    send: async (r) => {
      sent.push(r.body);
      if (r.body === "first") await gate;
    },
  });
  navigator.onLine = true;
  await a.enqueue({ body: "first" });
  await until(() => sent.length === 1);
  await a.enqueue({ body: "second" });
  release();
  await until(async () => (await a.list()).length === 0);
  assert.deepEqual(sent, ["first", "second"]);
  valid = false;
  await a.enqueue({ body: "not sent" });
  await a.flush();
  assert.equal(sent.length, 2);
  a.close();
  await purgeOutbox("staff:concurrent");
  navigator.onLine = false;
});

test("closing an identity while enqueue is in progress cannot leave a new private message behind", async () => {
  const a = createOutbox({
    owner: "staff:logout-race",
    send: async () => {
      throw Error("must not send");
    },
  });
  navigator.onLine = false;
  const pending = a.enqueue({ body: "private pending" });
  a.close();
  await assert.rejects(pending, /身份|关闭/);
  assert.equal((await a.list()).length, 0);
  await purgeOutbox("staff:logout-race");
});

test("HTTP browser without randomUUID can queue and deliver messages", async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
  });
  const sent = [];
  const box = createOutbox({
    owner: "http-visitor",
    send: async (r) => sent.push(r),
  });
  try {
    navigator.onLine = false;
    const id = await box.enqueue({ body: "HTTP message" });
    assert.match(id, /^[0-9a-f-]{36}$/);
    navigator.onLine = true;
    await box.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, id);
  } finally {
    box.close();
    navigator.onLine = false;
    Object.defineProperty(globalThis, "crypto", prior);
  }
});
