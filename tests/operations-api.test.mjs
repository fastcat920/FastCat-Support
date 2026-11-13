import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const dir = mkdtempSync(join(tmpdir(), "support-ops-")),
  path = join(dir, "test.db"),
  base = "http://127.0.0.1:14405",
  secret = "identity-test-secret-with-32-bytes";
let child, cookie, key, conversation;
async function api(p, method = "GET", body, headers = {}) {
  const r = await fetch(base + "/api" + p, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json(), headers: r.headers };
}
function proof(user, device) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
      "base64url",
    ),
    now = Math.floor(Date.now() / 1000),
    payload = Buffer.from(
      JSON.stringify({
        sub: user,
        deviceId: device,
        appKey: key,
        iat: now,
        exp: now + 300,
      }),
    ).toString("base64url"),
    body = header + "." + payload;
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
before(async () => {
  child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: "14405",
      DB_PATH: path,
      VISITOR_IDENTITY_SECRET: secret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (b) => (errors += b));
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error(errors);
    }),
  ]);
  const setup = await api("/setup", "POST", {
    name: "测试管理员",
    email: "ops@example.test",
    password: "test-password-2026",
  });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get("set-cookie").split(";")[0];
  key = (await api("/access/channels")).data.find(
    (c) => c.type === "web",
  ).public_key;
});
after(async () => {
  child.kill();
  await once(child, "exit");
  rmSync(dir, { recursive: true, force: true });
});
test("readiness exposes version without credentials; admin status is protected", async () => {
  const health = await api("/health/ready");
  assert.equal(health.data.ready, true);
  assert.ok(health.data.revision);
  const status = await api("/operations/status");
  assert.equal(status.status, 200);
  assert.equal(status.data.database.ready, true);
  assert.ok(!JSON.stringify(status.data).includes(secret));
  const denied = await api("/operations/status", "GET", undefined, {
    Cookie: "",
  });
  assert.equal(denied.status, 401);
  const db = new DatabaseSync(path);
  db.exec(
    "INSERT INTO users(id,name,email,password,role,active) VALUES('staff','客服','staff@example.test','none','agent',1);INSERT INTO sessions VALUES('staff-session','staff',9999999999999)",
  );
  db.close();
  assert.equal(
    (
      await api("/operations/status", "GET", undefined, {
        Cookie: "fc_session=staff-session",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(
        "/presence/heartbeat",
        "POST",
        {},
        { Cookie: "fc_session=staff-session" },
      )
    ).status,
    200,
  );
});
test("verified identity resumes same user/device and isolates all other combinations", async () => {
  const start = async (user, device) =>
    api("/widget/start?appKey=" + key, "POST", {
      email: "same@example.test",
      deviceId: device,
      identityToken: proof(user, device),
    });
  conversation = (await start("user-a", "installation_0001")).data;
  const again = await start("user-a", "installation_0001");
  assert.equal(again.status, 200);
  assert.equal(again.data.id, conversation.id);
  assert.equal(again.data.token, conversation.token);
  assert.notEqual(
    (await start("user-b", "installation_0001")).data.id,
    conversation.id,
  );
  assert.notEqual(
    (await start("user-a", "installation_0002")).data.id,
    conversation.id,
  );
  assert.equal(
    (
      await api("/widget/start?appKey=" + key, "POST", {
        email: "same@example.test",
        deviceId: "installation_other",
        identityToken: proof("user-a", "installation_0001"),
      })
    ).status,
    401,
  );
});
test("offline explanation, human assignment, handover, outcomes and reviewed knowledge lifecycle", async () => {
  await api("/presence", "PATCH", { availability: "offline" }); // other staff has no available capacity
  const db = new DatabaseSync(path);
  db.prepare("UPDATE users SET availability='offline' WHERE id='staff'").run();
  db.close();
  const sent = await api(
    "/widget/messages",
    "POST",
    {
      id: conversation.id,
      body: "无法连接，需要排查",
      clientId: "visitor_message_0001",
    },
    { Authorization: "Bearer " + conversation.token },
  );
  assert.equal(sent.status, 201);
  let assignment = await api(
    "/conversations/" + conversation.id + "/assignment",
  );
  assert.equal(assignment.data.reason, "offline");
  assert.equal(assignment.data.waiting, true);
  await api("/presence", "PATCH", { availability: "available" });
  await delay(1200);
  assignment = await api("/conversations/" + conversation.id + "/assignment");
  assert.equal(assignment.data.reason, "assigned");
  const handover = await api("/conversations/" + conversation.id + "/handover");
  assert.equal(handover.status, 200);
  assert.ok(
    handover.data.questions.some((q) => q.body.includes("无法连接")),
    JSON.stringify(handover.data),
  );
  assert.deepEqual(handover.data.consents, { query: null, operation: null });
  assert.equal(
    (
      await api("/conversations/" + conversation.id + "/outcome", "POST", {
        resolved: false,
      })
    ).status,
    200,
  );
  const candidate = await api(
    "/conversations/" + conversation.id + "/knowledge-candidate",
    "POST",
    { question: "无法连接如何处理？", answer: "先检查当前连接状态。" },
  );
  assert.equal(candidate.status, 201);
  const candidatePath = "/operations/knowledge-candidates/" + candidate.data.id;
  const approved = await api(candidatePath, "POST", { action: "approve" });
  assert.equal(approved.status, 200);
  assert.ok(approved.data.resourceId);
  assert.equal(
    (await api(candidatePath, "POST", { action: "approve" })).data.resourceId,
    approved.data.resourceId,
  );
  const metricsDB = new DatabaseSync(path),
    time = new Date().toISOString();
  metricsDB
    .prepare(
      "INSERT INTO auto_runs(id,conversation_id,status,created,finished) VALUES('metric-ai',?,'completed',?,?)",
    )
    .run(conversation.id, time, time);
  metricsDB
    .prepare(
      "INSERT INTO messages(id,conversation_id,role,body,created,source) VALUES('metric-ai-reply',?,'agent','AI 回复',?,'ai')",
    )
    .run(conversation.id, time);
  metricsDB
    .prepare(
      "INSERT INTO audit_logs(id,action,target_id,details,created) VALUES('metric-transfer','service.handoff',?,?,?)",
    )
    .run(conversation.id, JSON.stringify({ reason: "访客请求人工" }), time);
  metricsDB.close();
  const metric = await api("/operations/metrics?days=30");
  assert.equal(metric.status, 200);
  assert.equal(metric.data.outcomes.recorded, 1);
  assert.equal(metric.data.outcomes.resolutionRate, 0);
  assert.ok(Array.isArray(metric.data.ai.costByCurrency));
  assert.equal(metric.data.aiHandoff.total, 1);
  assert.equal(metric.data.aiHandoff.transferred, 1);
  assert.equal(metric.data.aiHandoff.rate, 1);
  assert.equal(metric.data.firstReply.samples, 1);
  const record = (
    await api("/operations/knowledge-candidates")
  ).data.items.find((c) => c.id === candidate.data.id);
  assert.equal(record.state, "approved");
});
test("backup can be created and revalidated through the admin interface", async () => {
  const created = await api("/operations/backups", "POST", {});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.ok(created.data.verified);
  const verified = await api(
    "/operations/backups/" + created.data.id + "/verify",
    "POST",
    {},
  );
  assert.equal(verified.status, 200);
  const state = (await api("/operations/status")).data;
  assert.equal(state.backups.items[0].id, created.data.id);
});
test("server-side revocation makes old visitor credentials unusable", async () => {
  const alertDb = new DatabaseSync(path);
  alertDb
    .prepare(
      "INSERT INTO operational_events VALUES('backup-failure-test','backup','failed',?)",
    )
    .run(new Date().toISOString());
  alertDb.close();
  assert.equal((await api("/operations/alerts")).data.backup.status, "failed");
  assert.equal(
    (
      await api(
        "/widget/session",
        "POST",
        { id: conversation.id, action: "revoke" },
        { Authorization: "Bearer " + conversation.token },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await api("/widget/messages?id=" + conversation.id, "GET", undefined, {
        Authorization: "Bearer " + conversation.token,
      })
    ).status,
    403,
  );
  const resumed = await api("/widget/start?appKey=" + key, "POST", {
    email: "same@example.test",
    deviceId: "installation_0001",
    identityToken: proof("user-a", "installation_0001"),
  });
  assert.equal(resumed.data.id, conversation.id);
  assert.notEqual(resumed.data.token, conversation.token);
});

test("internal failures remain sanitized and responsive even when operational logging fails", async () => {
  const db = new DatabaseSync(path);
  db.exec(
    "DROP TABLE push_jobs; CREATE TRIGGER reject_operation_log BEFORE INSERT ON operational_events BEGIN SELECT RAISE(ABORT,'log storage failure'); END;",
  );
  db.close();
  const response = await api("/operations/status");
  assert.equal(response.status, 500);
  assert.equal(response.data.code, "INTERNAL_ERROR");
  assert.ok(response.data.requestId);
  assert.ok(!JSON.stringify(response.data).includes("no such table"));
  assert.equal((await api("/health/live")).status, 200);
});
