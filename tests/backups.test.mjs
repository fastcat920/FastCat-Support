import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createBackups, verifyBackup } from "../lib/backups.mjs";
test("WAL backup verifies live data and keys, restores into a new directory and rejects corruption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "support-backup-")),
    path = join(dir, "live.db"),
    db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL;CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE conversations(id TEXT PRIMARY KEY);CREATE TABLE messages(id TEXT PRIMARY KEY,body TEXT);INSERT INTO messages VALUES('m','before');",
  );
  writeFileSync(path + ".key", Buffer.alloc(32, 7));
  try {
    const b = createBackups({ db, dbPath: path, env: {} });
    const result = await b.run();
    const source = join(dir, "backups", result.id);
    assert.ok(verifyBackup(source).verified);
    db.exec("UPDATE messages SET body='after'");
    const restored = join(dir, "restored");
    let run = spawnSync(
      process.execPath,
      ["scripts/restore-backup.mjs", source, restored],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const copy = new DatabaseSync(join(restored, "support.db"));
    assert.equal(
      copy.prepare("SELECT body FROM messages").get().body,
      "before",
    );
    copy.close();
    assert.deepEqual(
      readFileSync(join(restored, "support.db.key")),
      Buffer.alloc(32, 7),
    );
    run = spawnSync(process.execPath, [
      "scripts/restore-backup.mjs",
      source,
      restored,
    ]);
    assert.equal(run.status, 1);
    writeFileSync(join(source, "database.key"), "corrupt");
    assert.throws(() => verifyBackup(source));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
