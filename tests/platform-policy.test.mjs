import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { migrateFeatures } from "../lib/features.mjs";
import {
  migrateManagement,
  insertStaffMessage,
  updateConversation,
} from "../lib/management.mjs";
import { migrateMedia, insertVisitorMessage } from "../lib/media.mjs";
import { migrateReceipts } from "../lib/receipts.mjs";
import { migrateService, createService } from "../lib/service.mjs";
import { migrateChannels, createChannels } from "../lib/channels.mjs";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,password TEXT);
CREATE TABLE visitors(id TEXT PRIMARY KEY,name TEXT,email TEXT,notes TEXT,token TEXT);
CREATE TABLE conversations(id TEXT PRIMARY KEY,visitor_id TEXT REFERENCES visitors(id),subject TEXT,status TEXT DEFAULT 'open',assignee TEXT DEFAULT '',created TEXT,updated TEXT);
CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES conversations(id),role TEXT,body TEXT,created TEXT,read_at TEXT);
CREATE TABLE resources(id TEXT PRIMARY KEY,kind TEXT,name TEXT,description TEXT,config TEXT,created TEXT);`);
  migrateFeatures(db);
  migrateManagement(db);
  migrateService(db);
  migrateMedia(db);
  migrateReceipts(db);
  migrateChannels(db);
  db.prepare(
    "INSERT INTO users(id,name,email) VALUES('admin','客服','test@local.test')",
  ).run();
  for (const id of ["agent-a", "agent-b"])
    db.prepare(
      "INSERT INTO resources VALUES(?,'agent',?,'指令','{}','2026')",
    ).run(id, id);
  let service,
    time = new Date("2026-10-26T02:00:00Z");
  const calls = [];
  const broadcast = (id) => service?.observe(id);
  const channels = createChannels(db, {
    onChange: (id) => service.policyChanged(id),
  });
  service = createService({
    db,
    broadcast,
    autostart: false,
    clock: () => time,
    channelPolicy: channels.policy,
    configured: () => true,
    completion: async function* (o) {
      calls.push(o);
      yield "AI答复";
    },
  });
  const admin = { id: "admin", role: "admin" };
  async function request(path, method, data) {
    let result;
    await channels.handle({
      req: { method },
      res: {},
      url: new URL("http://localhost" + path),
      body: async () => data,
      send: (_r, _s, value) => (result = value),
      currentUser: () => admin,
    });
    return result;
  }
  async function channel(ai_mode = "auto", extra = {}) {
    return request("/api/access/channels", "POST", {
      name: "测试入口",
      type: "web",
      title: "你好",
      enabled: true,
      origins: [],
      ai_mode,
      agent_id: "agent-a",
      fallback_timeout: 10,
      ...extra,
    });
  }
  function conversation(channelId) {
    const id = randomUUID(),
      visitor = randomUUID();
    db.prepare("INSERT INTO visitors VALUES(?,?,'','','token')").run(
      visitor,
      "客户",
    );
    db.prepare(
      "INSERT INTO conversations(id,visitor_id,created,updated,channel_id) VALUES(?,?,?,?,?)",
    ).run(id, visitor, time.toISOString(), time.toISOString(), channelId);
    service.onStart(id);
    return { id, visitor_id: visitor };
  }
  function send(c, text = "问题") {
    const m = insertVisitorMessage(db, c, { body: text });
    service.onVisitor(c.id, m.id);
    broadcast(c.id);
    return m;
  }
  return {
    db,
    channels,
    service,
    calls,
    request,
    channel,
    conversation,
    send,
    admin,
    advance(ms) {
      time = new Date(time.getTime() + ms);
    },
    async flush() {
      await delay(5);
    },
    close() {
      service.close();
      db.close();
    },
  };
}
test("independent platform auto/off modes and selected agents override workspace defaults without crossing platforms", async () => {
  const x = setup();
  try {
    const auto = await x.channel(),
      off = await x.channel("off", { agent_id: "agent-b" });
    const a = x.conversation(auto.id),
      b = x.conversation(off.id);
    x.send(a);
    x.send(b);
    await x.flush();
    assert.equal(x.calls.length, 1);
    assert.equal(x.calls[0].agentId, "agent-a");
    assert.equal(
      x.db
        .prepare(
          "SELECT count(*) n FROM messages WHERE conversation_id=? AND source='ai'",
        )
        .get(b.id).n,
      0,
    );
    const inherited = x.channels
      .list()
      .find((c) => c.is_default && c.type === "web");
    x.send(x.conversation(inherited.id));
    await x.flush();
    assert.equal(x.calls.length, 1);
  } finally {
    x.close();
  }
});
test("assist waits until timeout, replies through selected agent and respects staff intervention", async () => {
  const x = setup();
  try {
    const profile = await x.channel("assist");
    const c = x.conversation(profile.id);
    x.send(c);
    assert.equal(
      x.db.prepare("SELECT assignee FROM conversations WHERE id=?").get(c.id)
        .assignee,
      "",
    );
    x.advance(9999);
    x.service.tick();
    await x.flush();
    assert.equal(x.calls.length, 0);
    x.advance(1);
    x.service.tick();
    await x.flush();
    assert.equal(x.calls.length, 1);
    assert.equal(x.calls[0].agentId, "agent-a");
    insertStaffMessage(x.db, x.admin, c.id, { body: "人工回复" });
    x.service.observe(c.id);
    x.send(c, "后续问题");
    x.advance(20000);
    x.service.tick();
    await x.flush();
    assert.equal(x.calls.length, 1);
  } finally {
    x.close();
  }
});
test("assist never overrides a human reply or explicit handoff, and timeout zero disables fallback", async () => {
  const x = setup();
  try {
    const profile = await x.channel("assist");
    const replied = x.conversation(profile.id),
      handoff = x.conversation(profile.id);
    x.send(replied);
    insertStaffMessage(x.db, x.admin, replied.id, { body: "人工已处理" });
    x.service.observe(replied.id);
    x.send(handoff);
    x.service.handoff(handoff.id, "访客请求人工");
    const noFallback = await x.channel("assist", { fallback_timeout: 0 });
    x.send(x.conversation(noFallback.id));
    x.advance(30000);
    x.service.tick();
    await x.flush();
    assert.equal(x.calls.length, 0);
  } finally {
    x.close();
  }
});
test("assist resets waiting deadline for a new question and cancels on policy change, close or assignment transfer", async () => {
  const x = setup();
  try {
    let profile = await x.channel("assist");
    const c = x.conversation(profile.id);
    x.send(c);
    x.advance(9000);
    x.send(c, "第二个问题");
    x.advance(1000);
    x.service.tick();
    await x.flush();
    assert.equal(x.calls.length, 0);
    profile = await x.request("/api/access/channels/" + profile.id, "PUT", {
      ...profile,
      ai_mode: "off",
      expectedRevision: profile.revision,
    });
    x.advance(30000);
    x.service.tick();
    await x.flush();
    assert.equal(x.calls.length, 0);
    const p = await x.channel("assist");
    const closed = x.conversation(p.id),
      transfer = x.conversation(p.id);
    x.send(closed);
    x.send(transfer);
    x.db
      .prepare("UPDATE conversations SET status='closed' WHERE id=?")
      .run(closed.id);
    x.db
      .prepare(
        "UPDATE conversations SET assignee='admin',revision=revision+1 WHERE id=?",
      )
      .run(transfer.id);
    x.advance(30000);
    x.service.tick();
    await x.flush();
    assert.equal(x.calls.length, 0);
  } finally {
    x.close();
  }
});
test("platform lifecycle preserves history, default identity and legacy config; key rotation and revision enforce stale-client rejection", async () => {
  const x = setup();
  try {
    const first = x.channels.list().find((c) => c.type === "web");
    let c = await x.channel("off");
    assert.equal(x.channels.resolve().id, first.id);
    const visitor = x.conversation(c.id);
    const oldKey = c.public_key;
    c = await x.request("/api/access/channels/" + c.id + "/rotate", "POST", {
      expectedRevision: c.revision,
    });
    assert.notEqual(c.public_key, oldKey);
    assert.throws(
      () => x.channels.resolve(oldKey),
      (e) => e.status === 403,
    );
    await assert.rejects(
      x.request("/api/access/channels/" + c.id, "PUT", {
        ...c,
        expectedRevision: 0,
      }),
      (e) => e.status === 409,
    );
    c = await x.request("/api/access/channels/" + c.id, "DELETE", {
      expectedRevision: c.revision,
    });
    assert.equal(c.archived, true);
    assert.equal(
      x.db.prepare("SELECT id FROM conversations WHERE id=?").get(visitor.id)
        .id,
      visitor.id,
    );
    assert.throws(
      () => x.channels.resolve(c.public_key),
      (e) => e.status === 403,
    );
    c = await x.request("/api/access/channels/" + c.id + "/restore", "POST", {
      expectedRevision: c.revision,
    });
    assert.equal(c.archived, false);
    assert.equal(c.enabled, false);
    await assert.rejects(
      x.request("/api/access/channels/" + first.id, "DELETE", {
        expectedRevision: first.revision,
      }),
      (e) => e.status === 409,
    );
    migrateChannels(x.db);
    assert.equal(x.channels.resolve().id, first.id);
  } finally {
    x.close();
  }
});
test("platform appearance validation rejects executable URLs, unknown AI agents and malformed settings", async () => {
  const x = setup();
  try {
    await assert.rejects(
      x.channel("auto", { agent_id: "missing" }),
      (e) => e.status === 400,
    );
    await assert.rejects(
      x.channel("assist", { fallback_timeout: -1 }),
      (e) => e.status === 400,
    );
    await assert.rejects(
      x.channel("off", {
        widget: {
          themeColor: "#fff000",
          position: "bottom-right",
          welcomeMessage: "",
          logoUrl: "javascript:alert(1)",
        },
      }),
      (e) => e.status === 400,
    );
    const c = await x.channel("off", {
      widget: {
        themeColor: "#112233",
        position: "top-left",
        welcomeMessage: "站点专属欢迎语",
        logoUrl: "https://example.com/logo.png",
      },
    });
    const visitor = x.conversation(c.id);
    assert.equal(
      x.db
        .prepare(
          "SELECT body FROM messages WHERE conversation_id=? AND source='system'",
        )
        .get(visitor.id).body,
      "站点专属欢迎语",
    );
  } finally {
    x.close();
  }
});

test("retired workspace rules cannot reactivate inherited platform reception", async () => {
  const x = setup();
  try {
    x.db.exec(
      "CREATE TABLE service_settings(id INTEGER PRIMARY KEY,value TEXT,revision INTEGER)",
    );
    x.db.prepare("INSERT INTO service_settings VALUES(1,?,0)").run(
      JSON.stringify({
        enabled: true,
        ai: { enabled: true, agentId: "agent-b" },
        assignment: { mode: "least_busy", teamId: "" },
        welcomeMessage: "legacy greeting",
        rules: [{ enabled: true, keywords: ["问题"], mode: "ai" }],
      }),
    );
    const inherited = x.channels
      .list()
      .find((c) => c.is_default && c.type === "web");
    const c = x.conversation(inherited.id);
    x.send(c);
    await x.flush();
    assert.equal(x.calls.length, 0);
    assert.equal(
      x.db.prepare("SELECT assignee FROM conversations WHERE id=?").get(c.id)
        .assignee,
      "",
    );
    assert.equal(
      x.db
        .prepare(
          "SELECT count(*) n FROM messages WHERE conversation_id=? AND role='agent'",
        )
        .get(c.id).n,
      0,
    );
  } finally {
    x.close();
  }
});

test("human handoff assigns available capacity and waits when every agent is full", () => {
  const x = setup();
  try {
    x.db.prepare("UPDATE users SET capacity=1").run();
    x.db
      .prepare(
        "INSERT INTO users(id,name,email,capacity) VALUES('b','客服乙','b@local.test',1)",
      )
      .run();
    const base = x.channels
      .list()
      .find((c) => c.is_default && c.type === "web");
    const a = x.conversation(base.id),
      b = x.conversation(base.id),
      waiting = x.conversation(base.id);
    assert.equal(x.service.handoff(a.id, "访客请求人工").assignee, "admin");
    const count = x.db
      .prepare("SELECT count(*) n FROM messages WHERE conversation_id=?")
      .get(a.id).n;
    x.service.handoff(a.id, "访客请求人工");
    assert.equal(
      x.db
        .prepare("SELECT count(*) n FROM messages WHERE conversation_id=?")
        .get(a.id).n,
      count,
    );
    assert.equal(x.service.handoff(b.id, "访客请求人工").assignee, "b");
    assert.equal(x.service.handoff(waiting.id, "访客请求人工").assignee, "");
    assert.equal(
      x.db
        .prepare("SELECT handoff_pending FROM conversations WHERE id=?")
        .get(waiting.id).handoff_pending,
      1,
    );
    x.db.prepare("UPDATE users SET availability='away' WHERE id='admin'").run();
    x.db
      .prepare("UPDATE conversations SET status='closed' WHERE id=?")
      .run(a.id);
    x.service.tick();
    assert.equal(
      x.db
        .prepare("SELECT assignee FROM conversations WHERE id=?")
        .get(waiting.id).assignee,
      "",
    );
    x.db.prepare("UPDATE users SET capacity=2 WHERE id='b'").run();
    x.service.tick();
    assert.equal(
      x.db
        .prepare("SELECT assignee FROM conversations WHERE id=?")
        .get(waiting.id).assignee,
      "b",
    );
  } finally {
    x.close();
  }
});
test("handoff respects team membership, account availability and explicit manual unassignment", () => {
  const x = setup();
  try {
    x.db
      .prepare(
        "INSERT INTO users(id,name,email,availability) VALUES('b','客服乙','b@local.test','offline')",
      )
      .run();
    x.db.prepare("INSERT INTO teams VALUES('sales','售前','','2026')").run();
    x.db.prepare("INSERT INTO team_members VALUES('sales','b')").run();
    const base = x.channels
      .list()
      .find((c) => c.is_default && c.type === "web");
    const c = x.conversation(base.id);
    x.db
      .prepare("UPDATE conversations SET team_id='sales' WHERE id=?")
      .run(c.id);
    assert.equal(x.service.handoff(c.id, "访客请求人工").assignee, "");
    x.db
      .prepare(
        "UPDATE users SET availability='available',active=0 WHERE id='b'",
      )
      .run();
    x.service.tick();
    assert.equal(
      x.db.prepare("SELECT assignee FROM conversations WHERE id=?").get(c.id)
        .assignee,
      "",
    );
    x.db.prepare("UPDATE users SET active=1 WHERE id='b'").run();
    x.service.tick();
    assert.equal(
      x.db.prepare("SELECT assignee FROM conversations WHERE id=?").get(c.id)
        .assignee,
      "b",
    );
    updateConversation(x.db, x.admin, c.id, { assignee: "" });
    x.service.tick();
    assert.equal(
      x.db.prepare("SELECT assignee FROM conversations WHERE id=?").get(c.id)
        .assignee,
      "",
    );
    assert.equal(
      x.db
        .prepare("SELECT handoff_pending FROM conversations WHERE id=?")
        .get(c.id).handoff_pending,
      0,
    );
  } finally {
    x.close();
  }
});
test("upgrade marks existing explicit handoff requests for assignment without claiming regular unassigned conversations", () => {
  const x = setup();
  try {
    const base = x.channels
      .list()
      .find((c) => c.is_default && c.type === "web");
    const waiting = x.conversation(base.id),
      regular = x.conversation(base.id);
    x.db
      .prepare(
        "UPDATE conversations SET handoff_reason='访客请求人工' WHERE id=?",
      )
      .run(waiting.id);
    x.db.exec("ALTER TABLE conversations DROP COLUMN handoff_pending");
    migrateService(x.db);
    x.service.tick();
    assert.equal(
      x.db
        .prepare("SELECT assignee FROM conversations WHERE id=?")
        .get(waiting.id).assignee,
      "admin",
    );
    assert.equal(
      x.db
        .prepare("SELECT assignee FROM conversations WHERE id=?")
        .get(regular.id).assignee,
      "",
    );
  } finally {
    x.close();
  }
});
