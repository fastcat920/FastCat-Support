import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateManagement } from "../lib/management.mjs";
test("legacy quick reply categories migrate independently without losing content or returning deleted empty defaults", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE users(id TEXT);CREATE TABLE messages(id TEXT,conversation_id TEXT,created TEXT);CREATE TABLE conversations(id TEXT,assignee TEXT,status TEXT);CREATE TABLE quick_replies(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,category TEXT NOT NULL,created TEXT,updated TEXT);INSERT INTO quick_replies VALUES('old','历史标题','历史正文','售后',NULL,NULL);`,
  );
  migrateManagement(db);
  assert.deepEqual(
    db
      .prepare("SELECT name FROM quick_reply_categories ORDER BY name")
      .all()
      .map((r) => r.name),
    ["售后", "通用"],
  );
  assert.equal(
    db.prepare("SELECT body FROM quick_replies").get().body,
    "历史正文",
  );
  db.exec("DELETE FROM quick_reply_categories WHERE name='通用'");
  migrateManagement(db);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM quick_reply_categories WHERE name='通用'",
      )
      .get().n,
    0,
  );
  db.close();
});
