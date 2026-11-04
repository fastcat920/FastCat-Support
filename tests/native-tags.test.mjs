import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleManagement } from "../lib/management.mjs";
test("conversation tags enforce access, revision and valid IDs", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE conversations(id TEXT PRIMARY KEY,assignee TEXT,revision INTEGER,updated TEXT); CREATE TABLE tags(id TEXT PRIMARY KEY,name TEXT,color TEXT); CREATE TABLE conversation_tags(conversation_id TEXT,tag_id TEXT,PRIMARY KEY(conversation_id,tag_id)); CREATE TABLE audit_logs(id TEXT,actor_id TEXT,action TEXT,target_id TEXT,details TEXT,created TEXT); INSERT INTO conversations VALUES('c','a',0,''); INSERT INTO tags VALUES('t','网络','violet');`,
  );
  const invoke = async (u, method, input) => {
    let result;
    await handleManagement({
      req: { method },
      url: new URL("http://localhost/api/conversations/c/tags"),
      u,
      db,
      body: async () => input,
      send: (_, status, data) => {
        result = { status, data };
      },
      broadcast: () => {},
    });
    return result;
  };
  const a = { id: "a", role: "agent" };
  await assert.rejects(
    invoke({ id: "b", role: "agent" }, "GET"),
    (e) => e.status === 403,
  );
  await assert.rejects(
    invoke(a, "PUT", { tagIds: ["missing"], expectedRevision: 0 }),
    (e) => e.status === 400,
  );
  assert.equal(
    (await invoke(a, "PUT", { tagIds: ["t", "t"], expectedRevision: 0 })).data
      .revision,
    1,
  );
  assert.equal((await invoke(a, "GET")).data.tags.length, 1);
  await assert.rejects(
    invoke(a, "PUT", { tagIds: [], expectedRevision: 0 }),
    (e) => e.status === 409,
  );
  await invoke(a, "PUT", { tagIds: [], expectedRevision: 1 });
  assert.equal((await invoke(a, "GET")).data.tags.length, 0);
  db.close();
});
