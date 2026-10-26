import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateManagement, insertStaffMessage } from "../lib/management.mjs";
import {
  migrateMedia,
  insertVisitorMessage,
  storeAttachment,
} from "../lib/media.mjs";
import { migrateReceipts } from "../lib/receipts.mjs";
import { migrateTelegram, createTelegram } from "../lib/telegram.mjs";
import { migrateChannels, createChannels } from "../lib/channels.mjs";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT);CREATE TABLE visitors(id TEXT PRIMARY KEY,name TEXT);CREATE TABLE conversations(id TEXT PRIMARY KEY,visitor_id TEXT,subject TEXT,status TEXT DEFAULT 'open',assignee TEXT DEFAULT '',created TEXT,updated TEXT,handoff_reason TEXT DEFAULT '');CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,body TEXT,created TEXT,source TEXT DEFAULT 'manual',read_at TEXT);`,
  );
  migrateManagement(db);
  migrateMedia(db);
  migrateReceipts(db);
  migrateTelegram(db);
  migrateChannels(db);
  db.exec(
    "INSERT INTO users(id,name,email) VALUES('admin','客服','a@example.com');INSERT INTO visitors VALUES('v','客户');INSERT INTO conversations(id,visitor_id,created,updated) VALUES('c','v','2026','2026');",
  );
  const dir = mkdtempSync(join(tmpdir(), "fc-tg-"));
  const calls = [];
  let secret,
    uncertain = false;
  const tg = createTelegram({
    db,
    keyPath: join(dir, "key"),
    autostart: false,
    fetcher: async (url, options) => {
      const method = url.split("/").at(-1);
      const payload =
        options?.body instanceof FormData
          ? Object.fromEntries(options.body)
          : JSON.parse(options?.body || "{}");
      calls.push({ method, payload });
      if (method === "setWebhook") secret = payload.secret_token;
      if (uncertain && method === "createForumTopic") throw Error("offline");
      let result =
        method === "getMe"
          ? { id: 123, username: "test" }
          : method === "getChat"
            ? { type: "supergroup", is_forum: true, title: "客服群" }
            : method === "getChatMember"
              ? { status: "administrator", can_manage_topics: true }
              : method === "createForumTopic"
                ? { message_thread_id: 77 }
                : method === "getFile"
                  ? { file_path: "files/a.txt", file_size: 3 }
                  : method === "a.txt"
                    ? null
                    : { message_id: 9 };
      return method === "a.txt"
        ? new Response("abc")
        : new Response(JSON.stringify({ ok: true, result }));
    },
    broadcast: (id) => tg.observe(id),
  });
  const channels = createChannels(db);
  const send = (_r, status, data) => ({ status, data });
  const user = { id: "admin", role: "admin" };
  async function request(path, method = "GET", data) {
    let result;
    await tg.handle({
      req: { method },
      res: {},
      url: new URL("http://localhost" + path),
      body: async () => data,
      send: (_r, status, value) => (result = { status, data: value }),
      currentUser: () => user,
      u: user,
    });
    return result?.data;
  }
  async function configure() {
    return request("/api/access/telegram", "PUT", {
      enabled: true,
      chatId: "-100123456",
      botToken: "123456:" + "x".repeat(30),
      tokenEnv: "",
      publicBaseUrl: "https://support.example.com",
      contextMessages: 1,
      operators: [{ telegramId: "456", userId: "admin" }],
      expectedRevision: 0,
    });
  }
  async function webhook(update, header = secret) {
    let result;
    await tg.webhook({
      req: { headers: { "x-telegram-bot-api-secret-token": header } },
      res: {},
      body: async () => update,
      send: (_r, status, data) => (result = { status, data }),
    });
    return result;
  }
  const msg = (updateId, overrides = {}) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      message_thread_id: 77,
      chat: { id: -100123456 },
      from: { id: 456 },
      text: "客服答复",
      ...overrides,
    },
  });
  return {
    db,
    tg,
    calls,
    request,
    configure,
    webhook,
    msg,
    channels,
    uncertain: () => (uncertain = true),
    close() {
      tg.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("Telegram is a staff-only handoff topic bridge: context privacy, text, attachment, dedup and no echo", async () => {
  const x = setup();
  try {
    const c = await x.configure();
    assert.equal(c.tokenConfigured, true);
    assert.ok(!JSON.stringify(c).includes("xxxx"));
    assert.ok(
      !x.db
        .prepare("SELECT token_cipher FROM telegram_config")
        .get()
        .token_cipher.includes("xxxx"),
    );
    await x.request("/api/access/telegram/webhook", "POST");
    insertVisitorMessage(
      x.db,
      { id: "c", visitor_id: "v" },
      { body: "较早消息" },
    );
    insertStaffMessage(x.db, { id: "admin", role: "admin" }, "c", {
      body: "内部备注",
      internal: true,
    });
    insertVisitorMessage(
      x.db,
      { id: "c", visitor_id: "v" },
      { body: "需要人工" },
    );
    x.tg.observe("c");
    await x.tg.tick();
    assert.equal(
      x.calls.filter((c) => c.method === "createForumTopic").length,
      0,
    );
    x.db
      .prepare(
        "UPDATE conversations SET handoff_reason='请求人工' WHERE id='c'",
      )
      .run();
    x.tg.observe("c");
    x.tg.observe("c");
    await x.tg.tick();
    await x.tg.tick();
    assert.equal(
      x.calls.filter((c) => c.method === "createForumTopic").length,
      1,
    );
    assert.deepEqual(
      x.calls
        .filter((c) => c.method === "sendMessage")
        .map((c) => c.payload.text),
      ["客户：需要人工"],
    );
    await x.webhook(x.msg(1));
    await x.webhook(x.msg(1));
    await x.tg.tick();
    assert.equal(
      x.db
        .prepare("SELECT count(*) n FROM messages WHERE source='telegram'")
        .get().n,
      1,
    );
    assert.equal(x.calls.filter((c) => c.method === "sendMessage").length, 1);
    await x.webhook(
      x.msg(2, {
        text: undefined,
        document: { file_id: "file", file_name: "answer.txt", file_size: 3 },
      }),
    );
    await x.tg.tick();
    assert.equal(x.db.prepare("SELECT count(*) n FROM attachments").get().n, 1);
    storeAttachment(x.db, {
      conversationId: "c",
      visitorId: "v",
      filename: "question.txt",
      data: Buffer.from("hello"),
    });
    x.tg.observe("c");
    await x.tg.tick();
    assert.equal(x.calls.filter((c) => c.method === "sendDocument").length, 1);
    assert.equal(x.calls.filter((c) => c.method === "sendMessage").length, 1);
  } finally {
    x.close();
  }
});
test("Telegram rejects private chats, wrong groups, unknown or bot senders, missing topics and invalid webhook secret", async () => {
  const x = setup();
  try {
    await x.configure();
    await x.request("/api/access/telegram/webhook", "POST");
    await assert.rejects(x.webhook(x.msg(1), "wrong"), (e) => e.status === 403);
    for (const [i, patch] of [
      { chat: { id: 456 } },
      { chat: { id: -999 } },
      { from: { id: 789 } },
      { from: { id: 456, is_bot: true } },
      { sender_chat: { id: -100123456 } },
      { message_thread_id: 999 },
    ].entries())
      assert.equal((await x.webhook(x.msg(i, patch))).data.ignored, true);
    assert.equal(
      x.db.prepare("SELECT count(*) n FROM telegram_updates").get().n,
      0,
    );
    assert.equal(
      x.db.prepare("SELECT count(*) n FROM conversations").get().n,
      1,
    );
  } finally {
    x.close();
  }
});
test("Telegram uncertain topic creation does not automatically duplicate; manual binding unblocks queued messages", async () => {
  const x = setup();
  try {
    await x.configure();
    x.uncertain();
    x.db.exec("UPDATE conversations SET handoff_reason='人工'");
    insertVisitorMessage(x.db, { id: "c", visitor_id: "v" }, { body: "咨询" });
    x.tg.observe("c");
    await x.tg.tick();
    await x.tg.tick();
    assert.equal(
      x.calls.filter((c) => c.method === "createForumTopic").length,
      1,
    );
    assert.equal(
      x.db
        .prepare("SELECT status FROM telegram_deliveries WHERE kind='open'")
        .get().status,
      "uncertain",
    );
    await x.request("/api/access/telegram/topics/c", "PUT", { threadId: 77 });
    await x.tg.tick();
    assert.equal(x.calls.filter((c) => c.method === "sendMessage").length, 1);
  } finally {
    x.close();
  }
});
test("Telegram closed conversations and revoked staff cannot post replies", async () => {
  const x = setup();
  try {
    await x.configure();
    await x.request("/api/access/telegram/webhook", "POST");
    x.db.exec("UPDATE conversations SET handoff_reason='人工'");
    x.tg.observe("c");
    await x.tg.tick();
    await x.webhook(x.msg(1));
    x.db.exec("UPDATE users SET active=0");
    await x.tg.tick();
    assert.equal(
      x.db.prepare("SELECT status FROM telegram_updates").get().status,
      "ignored",
    );
    x.db.exec(
      "UPDATE users SET active=1;UPDATE conversations SET status='closed'",
    );
    await x.webhook(x.msg(2));
    await x.tg.tick();
    assert.equal(
      x.db
        .prepare("SELECT count(*) n FROM messages WHERE source='telegram'")
        .get().n,
      0,
    );
  } finally {
    x.close();
  }
});
test("Platform keys, origin policy, revision conflict and disabling a channel are enforced", async () => {
  const x = setup();
  try {
    const channel = x.channels.list().find((c) => c.type === "sdk");
    let result;
    const req = { method: "PUT", headers: { host: "localhost" } };
    await x.channels.handle({
      req,
      res: {},
      url: new URL("http://localhost/api/access/channels/" + channel.id),
      body: async () => ({
        ...channel,
        origins: ["https://app.example.com"],
        expectedRevision: 0,
      }),
      currentUser: () => ({ role: "admin" }),
      send: (_r, _s, d) => (result = d),
    });
    assert.equal(result.revision, 1);
    const headers = {};
    assert.equal(
      x.channels.cors(
        { headers: { host: "localhost", origin: "https://app.example.com" } },
        { setHeader: (k, v) => (headers[k] = v) },
        new URL("http://localhost/api/widget?appKey=" + channel.public_key),
      ),
      true,
    );
    assert.equal(
      headers["Access-Control-Allow-Origin"],
      "https://app.example.com",
    );
    assert.throws(
      () =>
        x.channels.authorize(
          { headers: { host: "localhost", origin: "https://bad.example.com" } },
          new URL("http://localhost/api/widget?appKey=" + channel.public_key),
        ),
      (e) => e.status === 403,
    );
    x.db
      .prepare("UPDATE access_channels SET enabled=0 WHERE id=?")
      .run(channel.id);
    assert.throws(
      () => x.channels.resolve(channel.public_key),
      (e) => e.status === 403,
    );
  } finally {
    x.close();
  }
});
