import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateFeatures } from "../lib/features.mjs";
test("feature migration preserves existing knowledge and stable chunks, and marks interrupted runs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE resources(id TEXT PRIMARY KEY,kind TEXT,name TEXT,description TEXT,config TEXT,created TEXT)",
    );
    db.prepare("INSERT INTO resources VALUES(?,?,?,?,?,?)").run(
      "existing",
      "knowledge",
      "原有知识",
      "原有退货政策保留",
      "{}",
      new Date().toISOString(),
    );
    migrateFeatures(db);
    const first = db
      .prepare("SELECT * FROM knowledge_chunks WHERE resource_id=?")
      .all("existing");
    assert.equal(first.length, 1);
    db.prepare("INSERT INTO workflow_runs VALUES(?,?,?,?,?,?,?,?)").run(
      "interrupted",
      "flow",
      "中断任务",
      "running",
      '"test"',
      '{"steps":[]}',
      new Date().toISOString(),
      null,
    );
    migrateFeatures(db);
    assert.deepEqual(
      db
        .prepare("SELECT * FROM knowledge_chunks WHERE resource_id=?")
        .all("existing"),
      first,
    );
    assert.equal(
      db.prepare("SELECT description FROM resources WHERE id=?").get("existing")
        .description,
      "原有退货政策保留",
    );
    const run = db
      .prepare("SELECT * FROM workflow_runs WHERE id=?")
      .get("interrupted");
    assert.equal(run.status, "interrupted");
    assert.ok(run.finished);
    assert.equal(JSON.parse(run.result).status, "interrupted");
  } finally {
    db.close();
  }
});
