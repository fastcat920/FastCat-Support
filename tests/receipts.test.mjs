import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  migrateReceipts,
  acknowledge,
  receiptState,
} from "../lib/receipts.mjs";
test("message cursors remain monotonic, acknowledgements are explicit and notes/other conversations cannot be acknowledged by visitors", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE conversations(id TEXT PRIMARY KEY);CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,read_at TEXT);INSERT INTO conversations VALUES('a'),('b');INSERT INTO messages VALUES('old','a','visitor',null)",
  );
  migrateReceipts(db);
  const insert = db.prepare(
    "INSERT INTO messages(id,conversation_id,role) VALUES(?,?,?)",
  );
  insert.run("reply", "a", "agent");
  insert.run("note", "a", "note");
  insert.run("other", "b", "agent");
  const seq = (id) =>
    db.prepare("SELECT seq FROM messages WHERE id=?").get(id).seq;
  assert.equal(
    db.prepare("SELECT read_at FROM messages WHERE id=?").get("old").read_at,
    null,
  );
  acknowledge(
    db,
    "a",
    "staff:u",
    { deliveredSeq: seq("reply"), readSeq: seq("old") },
    false,
  );
  assert.equal(receiptState(db, "a", true).readSeq, seq("old"));
  assert.ok(
    db.prepare("SELECT read_at FROM messages WHERE id=?").get("old").read_at,
  );
  assert.equal(
    db.prepare("SELECT read_at FROM messages WHERE id=?").get("reply").read_at,
    null,
  );
  assert.throws(
    () =>
      acknowledge(
        db,
        "a",
        "visitor",
        { deliveredSeq: seq("note"), readSeq: 0 },
        true,
      ),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      acknowledge(
        db,
        "a",
        "visitor",
        { deliveredSeq: seq("other"), readSeq: 0 },
        true,
      ),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      acknowledge(
        db,
        "a",
        "visitor",
        { deliveredSeq: 0, readSeq: seq("reply") },
        true,
      ),
    (e) => e.status === 400,
  );
  acknowledge(
    db,
    "a",
    "visitor",
    { deliveredSeq: seq("reply"), readSeq: seq("reply") },
    true,
  );
  acknowledge(
    db,
    "a",
    "visitor",
    { deliveredSeq: seq("old"), readSeq: 0 },
    true,
  );
  assert.equal(receiptState(db, "a", false).readSeq, seq("reply"));
  const high = seq("other");
  db.prepare("DELETE FROM messages WHERE id=?").run("other");
  insert.run("later", "b", "agent");
  assert.ok(seq("later") > high);
  migrateReceipts(db);
  assert.equal(receiptState(db, "a", false).readSeq, seq("reply"));
  db.close();
});
