import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "fastcat-management-")),
  base = "http://127.0.0.1:14330";
let child, admin, agentA, agentB, userA, userB, adminId;
async function call(path, method = "GET", body, cookie = admin) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
async function invite(email, role = "agent") {
  const r = await call("/invitations", "POST", { email, role });
  assert.equal(r.status, 201);
  const token = r.data.path.split("invite=")[1];
  return { token, id: r.data.id };
}
async function accept(token, name) {
  const r = await call(
    "/invites/" + token + "/accept",
    "POST",
    { name, password: "test-password-2026" },
    "",
  );
  assert.equal(r.status, 201);
}
async function visitor(name) {
  const r = await call(
    "/widget/start",
    "POST",
    { email: Buffer.from(name).toString("hex") + "@example.test" },
    "",
  );
  return r.data;
}
before(async () => {
  child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: "14330", DB_PATH: join(dir, "test.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error("server failed");
    }),
  ]);
  const r = await call(
    "/setup",
    "POST",
    {
      name: "管理员",
      email: "admin@local.test",
      password: "test-password-2026",
    },
    "",
  );
  assert.equal(r.status, 200);
  admin = r.cookie;
  adminId = r.data.id;
});
after(async () => {
  child.kill();
  await once(child, "exit");
  rmSync(dir, { recursive: true, force: true });
});
test("invitations are single-use and revocable, members login with scoped roles", async () => {
  const cross = await fetch(base + "/api/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://untrusted.example",
    },
    body: JSON.stringify({
      email: "admin@local.test",
      password: "test-password-2026",
    }),
  });
  assert.equal(cross.status, 403);

  let inv = await invite("agent-a@local.test");
  assert.equal(
    (await call("/invites/" + inv.token, "GET", undefined, "")).data.role,
    "agent",
  );
  await accept(inv.token, "客服小林");
  assert.equal(
    (
      await call(
        "/invites/" + inv.token + "/accept",
        "POST",
        { name: "again", password: "test-password-2026" },
        "",
      )
    ).status,
    410,
  );
  let login = await call(
    "/login",
    "POST",
    { email: "AGENT-A@LOCAL.TEST", password: "test-password-2026" },
    "",
  );
  agentA = login.cookie;
  userA = login.data.id;
  assert.equal(login.data.role, "agent");
  inv = await invite("agent-b@local.test");
  await accept(inv.token, "客服小周");
  login = await call(
    "/login",
    "POST",
    { email: "agent-b@local.test", password: "test-password-2026" },
    "",
  );
  agentB = login.cookie;
  userB = login.data.id;
  const revoked = await invite("revoked@local.test");
  await call("/invitations/" + revoked.id, "DELETE");
  assert.equal(
    (await call("/invites/" + revoked.token, "GET", undefined, "")).status,
    410,
  );
  assert.equal(
    (await call("/invitations", "POST", { email: "bad@example.com" }, agentA))
      .status,
    403,
  );
  assert.equal((await call("/members")).data.length, 3);
  assert.ok(
    (await call("/members", "GET", undefined, agentA)).data.every(
      (u) => u.email === undefined,
    ),
  );
  assert.equal(
    (await call("/members/" + adminId, "PATCH", { role: "agent" })).status,
    409,
  );
});
test("assignment scopes reads, replies, search, visitors, AI and bulk actions", async () => {
  const a = await visitor("访客甲"),
    b = await visitor("访客乙");
  await call("/conversations/" + a.id, "PATCH", {
    assignee: userA,
    subject: "甲的售后问题",
  });
  await call("/conversations/" + b.id, "PATCH", {
    assignee: userB,
    subject: "乙的售后问题",
  });
  assert.equal(
    (await call("/conversations/" + a.id, "GET", undefined, agentB)).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/conversations/" + a.id + "/messages",
        "POST",
        { body: "越权回复" },
        agentB,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/ai/draft", "POST", { conversationId: a.id }, agentB)).status,
    403,
  );
  const list = (await call("/conversations", "GET", undefined, agentA)).data;
  assert.ok(list.some((c) => c.id === a.id));
  assert.ok(!list.some((c) => c.id === b.id));
  assert.ok(
    !(await call("/visitors", "GET", undefined, agentA)).data.some(
      (v) => v.id === b.id,
    ),
  );
  assert.ok(
    !(
      await call(
        "/global-search?q=" + encodeURIComponent("售后"),
        "GET",
        undefined,
        agentA,
      )
    ).data.conversations.some((c) => c.id === b.id),
  );
  assert.equal(
    (await call("/resources?kind=tool", "GET", undefined, agentA)).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/resources",
        "POST",
        { kind: "knowledge", name: "越权", description: "不允许" },
        agentA,
      )
    ).status,
    403,
  );
  const visitorId = (await call("/visitors")).data.find(
    (v) => v.name === Buffer.from("访客甲").toString("hex") + "@example.test",
  ).id;
  assert.equal(
    (
      await call(
        "/visitors/" + visitorId + "/conversations",
        "GET",
        undefined,
        agentA,
      )
    ).data.length,
    1,
  );
  assert.equal(
    (
      await call(
        "/visitors/" + visitorId + "/conversations",
        "GET",
        undefined,
        agentB,
      )
    ).status,
    404,
  );
  const revision = (await call("/conversations/" + a.id)).data.conversation
    .revision;
  assert.equal(
    (
      await call(
        "/conversations/bulk",
        "POST",
        { ids: [a.id, b.id], changes: { priority: "urgent" } },
        agentA,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/conversations/" + a.id)).data.conversation.priority,
    "normal",
  );
  assert.equal(
    (
      await call(
        "/conversations/" + a.id,
        "PATCH",
        { priority: "high", expectedRevision: revision },
        agentA,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/conversations/" + a.id,
        "PATCH",
        { priority: "low", expectedRevision: revision },
        agentA,
      )
    ).status,
    409,
  );
  assert.equal(
    (await call("/conversations/" + a.id, "PATCH", { assignee: userB }, agentA))
      .status,
    200,
  );
  assert.equal(
    (await call("/conversations/" + a.id, "GET", undefined, agentA)).status,
    403,
  );
});
test("priority, filters, pagination, atomic bulk, CSV and audit are usable", async () => {
  assert.equal((await call("/tags", "GET")).status, 404);
  const a = await visitor("=SUM(1+1)"),
    b = await visitor("普通访客");
  assert.equal(
    (
      await call("/conversations/bulk", "POST", {
        ids: [a.id, b.id],
        changes: { priority: "urgent", status: "pending" },
      })
    ).data.count,
    2,
  );
  const listed = (
    await call("/conversations?paged=1&status=pending&priority=urgent&limit=1")
  ).data;
  assert.equal(listed.total, 2);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.counts.pending, 2);
  const second = (
    await call(
      "/conversations?paged=1&status=pending&priority=urgent&limit=1&offset=1",
    )
  ).data;
  assert.notEqual(second.items[0].id, listed.items[0].id);
  assert.equal(
    (
      await call("/conversations/bulk", "POST", {
        ids: [a.id, "missing"],
        changes: { priority: "low" },
      })
    ).status,
    404,
  );
  assert.equal(
    (await call("/conversations/" + a.id)).data.conversation.priority,
    "urgent",
  );
  await call("/conversations/" + a.id, "PATCH", { subject: "=SUM(1+1)" });
  const exported = (
    await call("/conversations/export?status=pending&priority=urgent")
  ).data;
  assert.equal(exported.total, 2);
  assert.ok(exported.content.includes("'=SUM(1+1)"));
  assert.ok(
    (await call("/audit")).data.some((e) => e.action === "conversation.update"),
  );
  assert.equal((await call("/audit", "GET", undefined, agentA)).status, 403);
});
test("quick replies are managed by admins and read by agents; idempotent replies claim and record author", async () => {
  const reply = await call("/quick-replies", "POST", {
    title: "欢迎",
    body: "您好 {{visitor.name}}，我是 {{agent.name}}。",
    category: "接待",
  });
  assert.equal(reply.status, 201);
  assert.equal(
    (await call("/quick-replies", "GET", undefined, agentA)).data[0].title,
    "欢迎",
  );
  assert.equal(
    (
      await call(
        "/quick-replies/" + reply.data.id,
        "PATCH",
        { title: "bad", body: "bad" },
        agentA,
      )
    ).status,
    403,
  );
  const c = await visitor("访客丙"),
    payload = { body: "您好，请描述问题", clientId: "message-request-123" };
  let r = await call(
    "/conversations/" + c.id + "/messages",
    "POST",
    payload,
    agentA,
  );
  assert.equal(r.status, 200);
  const messageId = r.data.id;
  r = await call(
    "/conversations/" + c.id + "/messages",
    "POST",
    payload,
    agentA,
  );
  assert.equal(r.data.id, messageId);
  assert.equal(r.data.duplicate, true);
  assert.equal(
    (
      await call(
        "/conversations/" + c.id + "/messages",
        "POST",
        { ...payload, body: "不同消息" },
        agentA,
      )
    ).status,
    409,
  );
  const detail = (
    await call("/conversations/" + c.id, "GET", undefined, agentA)
  ).data;
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].senderName, "客服小林");
  assert.equal(detail.conversation.assignee, userA);
  assert.equal(
    (
      await call(
        "/conversations/" + c.id + "/messages",
        "POST",
        { body: "其他坐席" },
        agentB,
      )
    ).status,
    403,
  );
  await call("/quick-replies/" + reply.data.id, "DELETE");
  assert.equal((await call("/quick-replies")).data.length, 0);
});
test("disabling a member revokes sessions and returns their open conversations to the queue", async () => {
  const r = await call("/members/" + userA, "PATCH", { active: 0 });
  assert.equal(r.status, 200);
  assert.ok(r.data.released > 0);
  assert.equal((await call("/me", "GET", undefined, agentA)).status, 401);
  assert.equal(
    (
      await call(
        "/login",
        "POST",
        { email: "agent-a@local.test", password: "test-password-2026" },
        "",
      )
    ).status,
    401,
  );
  assert.equal(
    (await call("/members/" + adminId, "PATCH", { active: 0 })).status,
    400,
  );
  assert.equal(
    (await call("/conversations", "GET")).data.filter(
      (c) => c.assignee === userA && c.status !== "closed",
    ).length,
    0,
  );
});

test("member management saves status and workload capacity atomically with admin permissions", async () => {
  const p = "/members/" + adminId;
  assert.equal(
    (await call(p, "PATCH", { availability: "away", capacity: 3 })).status,
    200,
  );
  let member = (await call("/members")).data.find((m) => m.id === adminId);
  assert.equal(member.availability, "away");
  assert.equal(member.capacity, 3);
  assert.equal(typeof member.workload, "number");
  assert.equal(
    (await call(p, "PATCH", { name: "not-saved", capacity: 0 })).status,
    400,
  );
  member = (await call("/members")).data.find((m) => m.id === adminId);
  assert.notEqual(member.name, "not-saved");
  assert.equal(member.capacity, 3);
  assert.equal(
    (
      await call(
        p,
        "PATCH",
        { availability: "available", capacity: 10 },
        agentB,
      )
    ).status,
    403,
  );
  await call(p, "PATCH", { availability: "available", capacity: 10 });
});
