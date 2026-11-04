import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createPush } from "../lib/push.mjs";
function setup(transport) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE users(id TEXT,role TEXT,active INTEGER); CREATE TABLE sessions(token TEXT,user_id TEXT,expires INTEGER); CREATE TABLE conversations(id TEXT,assignee TEXT); CREATE TABLE messages(id TEXT,conversation_id TEXT,role TEXT,read_at TEXT); INSERT INTO users VALUES('a','admin',1),('b','agent',1); INSERT INTO sessions VALUES('sa','a',9999999999999),('sb','b',9999999999999); INSERT INTO conversations VALUES('c','a'),('unassigned',NULL);`,
  );
  const push = createPush(db, { transport, clock: () => 100000 });
  const api = async (userId, method, data) => {
    let output;
    await push.handle({
      req: { method },
      res: {},
      url: new URL("http://localhost/api/push/device"),
      u: { id: userId, role: userId === "a" ? "admin" : "agent" },
      body: async () => data,
      sessionToken: "s" + userId,
      send: (_, status, body) => {
        output = { status, body };
      },
    });
    return output;
  };
  return { db, push, api };
}
const token = "a".repeat(64),
  deviceId = "installation_123456";
test("push account routing, duplicate events, foreground suppression and expired login", async () => {
  const sent = [];
  const { db, push, api } = setup({
    configured: true,
    send: async (d, p) => {
      sent.push({ d, p });
      return { status: 200 };
    },
  });
  await api("a", "PUT", {
    deviceId,
    token,
    environment: "sandbox",
    language: "en",
  });
  await api("b", "PUT", {
    deviceId: "installation_second",
    token: "b".repeat(64),
    environment: "production",
  });
  db.exec("INSERT INTO messages VALUES('m','c','visitor',NULL)");
  push.observe("c");
  push.observe("c");
  await push.drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].d.user_id, "a");
  assert.equal(sent[0].p.conversationId, "c");
  assert.equal(sent[0].p.aps.badge, 1);
  assert.equal(sent[0].p.aps.alert.body, "You have a new customer message");
  await api("a", "PATCH", {
    deviceId,
    foreground: true,
    activeConversationId: "c",
  });
  db.exec("INSERT INTO messages VALUES('m2','c','visitor',NULL)");
  push.observe("c");
  await push.drain();
  assert.equal(sent.length, 1);
  await api("a", "PATCH", { deviceId, foreground: false });
  db.exec("INSERT INTO messages VALUES('m3','c','visitor',NULL)");
  push.observe("c");
  db.exec("DELETE FROM sessions WHERE user_id='a'");
  await push.drain();
  assert.equal(sent.length, 1);
  db.close();
});
test("failed push retries, invalid token disables device, account switch prevents old delivery", async () => {
  let calls = 0;
  const { db, push, api } = setup({
    configured: true,
    send: async () => ({
      status: ++calls === 1 ? 503 : 410,
      reason: "Unregistered",
    }),
  });
  await api("a", "PUT", { deviceId, token, environment: "sandbox" });
  db.exec("INSERT INTO messages VALUES('m','c','visitor',NULL)");
  push.observe("c");
  await push.drain();
  assert.equal(
    db.prepare("SELECT state FROM push_jobs").get().state,
    "pending",
  );
  db.exec("UPDATE push_jobs SET next_attempt=0");
  await push.drain();
  assert.equal(db.prepare("SELECT enabled FROM push_devices").get().enabled, 0);
  await api("a", "PUT", { deviceId, token, environment: "sandbox" });
  db.exec("INSERT INTO messages VALUES('m2','c','visitor',NULL)");
  push.observe("c");
  await api("b", "PUT", { deviceId, token, environment: "sandbox" });
  await push.drain();
  assert.equal(calls, 2);
  assert.equal(
    db.prepare("SELECT user_id FROM push_devices").get().user_id,
    "b",
  );
  db.close();
});
test("disabled APNs retains tasks and registration validates token", async () => {
  const { db, push, api } = setup({ configured: false });
  await assert.rejects(
    api("a", "PUT", { deviceId, token: "invalid", environment: "sandbox" }),
    { status: 400 },
  );
  await api("a", "PUT", { deviceId, token, environment: "sandbox" });
  db.exec("INSERT INTO messages VALUES('m','c','visitor',NULL)");
  push.observe("c");
  await push.drain();
  assert.equal(
    db.prepare("SELECT state FROM push_jobs").get().state,
    "pending",
  );
  db.close();
});
