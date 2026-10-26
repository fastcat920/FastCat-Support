import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateManagement } from "../lib/management.mjs";
test("management migration preserves existing admin, conversation and legacy message across repeated startup", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,password TEXT); CREATE TABLE conversations(id TEXT PRIMARY KEY,visitor_id TEXT,subject TEXT,status TEXT,assignee TEXT,created TEXT,updated TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,body TEXT,created TEXT);",
    );
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      "admin",
      "原管理员",
      "owner@local.test",
      "existing-password-hash",
    );
    db.prepare("INSERT INTO conversations VALUES(?,?,?,?,?,?,?)").run(
      "conversation",
      "visitor",
      "原会话",
      "open",
      "admin",
      "2026-10-26",
      "2026-10-26",
    );
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
      "message",
      "conversation",
      "agent",
      "原消息保留",
      "2026-10-26",
    );
    migrateManagement(db);
    migrateManagement(db);
    const u = db.prepare("SELECT * FROM users WHERE id=?").get("admin");
    assert.equal(u.role, "admin");
    assert.equal(u.active, 1);
    assert.equal(u.password, "existing-password-hash");
    const c = db
      .prepare("SELECT * FROM conversations WHERE id=?")
      .get("conversation");
    assert.equal(c.assignee, "admin");
    assert.equal(c.priority, "normal");
    assert.equal(c.revision, 0);
    const m = db.prepare("SELECT * FROM messages WHERE id=?").get("message");
    assert.equal(m.body, "原消息保留");
    assert.equal(m.sender_id, null);
  } finally {
    db.close();
  }
});

test("revoked invitation cannot be accepted after a pending request body finishes", async () => {
  const { handleInvite } = await import("../lib/management.mjs"),
    { createHash } = await import("node:crypto");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,password TEXT); CREATE TABLE conversations(id TEXT PRIMARY KEY,visitor_id TEXT,subject TEXT,status TEXT,assignee TEXT,created TEXT,updated TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,body TEXT,created TEXT)",
    );
    migrateManagement(db);
    const token = "a".repeat(64);
    db.prepare(
      "INSERT INTO invitations(id,email,role,token_hash,expires) VALUES(?,?,?,?,?)",
    ).run(
      "inv",
      "new@local.test",
      "agent",
      createHash("sha256").update(token).digest("hex"),
      Date.now() + 60000,
    );
    let finishBody, reachedBody;
    const blocked = new Promise((resolve) => (finishBody = resolve)),
      reached = new Promise((resolve) => (reachedBody = resolve));
    const promise = handleInvite({
      req: { method: "POST" },
      res: {},
      url: new URL("http://localhost/api/invites/" + token + "/accept"),
      db,
      body: async () => {
        reachedBody();
        await blocked;
        return { name: "新成员", password: "long-password-2026" };
      },
      send: () => {
        throw Error("must not create account");
      },
      hash: () => "hash",
      uid: () => "new-user",
      now: () => new Date().toISOString(),
    });
    await reached;
    db.prepare("UPDATE invitations SET revoked=1 WHERE id=?").run("inv");
    finishBody();
    await assert.rejects(promise, (e) => e.status === 410);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM users").get().count, 0);
  } finally {
    db.close();
  }
});
