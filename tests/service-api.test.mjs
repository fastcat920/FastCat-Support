import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "../lib/documents.mjs";
import { inServiceHours } from "../lib/working-hours.mjs";
const dir = mkdtempSync(join(tmpdir(), "fastcat-service-")),
  base = "http://127.0.0.1:14340";
let child, cookie, admin, model;
async function call(path, method = "GET", body, headers = {}) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body && !Buffer.isBuffer(body)
        ? { "Content-Type": "application/json" }
        : {}),
      ...headers,
    },
    ...(body
      ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }
      : {}),
  });
  const bytes = Buffer.from(await r.arrayBuffer());
  let data;
  try {
    data = JSON.parse(bytes);
  } catch {
    data = bytes;
  }
  return { status: r.status, data, headers: r.headers };
}
async function start(appKey = "") {
  return (
    await call("/widget/start" + (appKey ? "?appKey=" + appKey : ""), "POST", {
      email: "service@example.test",
    })
  ).data;
}
async function send(v, text, key = "visitor_message_0001") {
  return call(
    "/widget/messages",
    "POST",
    { id: v.id, body: text, clientId: key },
    { Authorization: "Bearer " + v.token },
  );
}
async function detail(v) {
  return (await call("/conversations/" + v.id)).data;
}
before(async () => {
  model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const slow = raw.includes("慢速");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      "data: " +
        JSON.stringify({ choices: [{ delta: { content: "模拟答复" } }] }) +
        "\n\n",
    );
    await delay(slow ? 600 : 10);
    if (!res.destroyed) res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => model.listen(14341, "127.0.0.1", resolve));
  child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: "14340",
      DB_PATH: join(dir, "test.db"),
      AI_BASE_URL: "http://127.0.0.1:14341/v1",
      AI_API_KEY: "local-test",
      AI_MODEL: "mock",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error("server failed");
    }),
  ]);
  const r = await call("/setup", "POST", {
    name: "管理员",
    email: "service@local.test",
    password: "test-password-2026",
  });
  assert.equal(r.status, 200);
  cookie = r.headers.get("set-cookie").split(";")[0];
  admin = r.data;
});
after(async () => {
  child.kill();
  await once(child, "exit");
  await new Promise((resolve) => model.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});
test("batch Q&A import is indexed and invalid batches create no entries", async () => {
  const path = "/knowledge/qa/import";
  const before = (await call("/resources?kind=knowledge")).data.length;
  const invalid = await call(path, "POST", {
    collectionId: "default",
    format: "json",
    data: JSON.stringify([
      { question: "有效问题", answer: "有效答案" },
      { question: "", answer: "无效" },
    ]),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await call("/resources?kind=knowledge")).data.length, before);
  const result = await call(path, "POST", {
    collectionId: "default",
    format: "csv",
    data: "question,answer,category\n订单测试问题,订单测试答案,订单",
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.count, 1);
  const rows = (await call("/resources?kind=knowledge")).data;
  assert.equal(
    rows.find((r) => r.name === "订单测试问题")?.config.category,
    "订单",
  );
  assert.ok(
    (await call("/search?q=" + encodeURIComponent("订单测试问题"))).data.some(
      (r) => r.name === "订单测试问题",
    ),
  );
});
test("business hours use local weekdays and carry overnight shifts into next day", () => {
  const h = {
    enabled: true,
    timeZone: "Asia/Shanghai",
    weekdays: [1],
    start: "22:00",
    end: "06:00",
  };
  assert.equal(inServiceHours(h, new Date("2026-10-26T15:00:00Z")), true);
  assert.equal(inServiceHours(h, new Date("2026-10-26T21:59:00Z")), true);
  assert.equal(inServiceHours(h, new Date("2026-10-26T22:00:00Z")), false);
  assert.equal(inServiceHours(h, new Date("2026-10-27T15:00:00Z")), false);
});
test("PDF, DOCX and UTF-8 text parse; corrupt and binary documents fail", async () => {
  const pdf = await parseDocument(
    "policy.pdf",
    readFileSync(new URL("./fixtures/support-policy.pdf", import.meta.url)),
  );
  assert.equal(pdf.pages, 1);
  assert.match(pdf.text, /seven days/);
  const doc = await parseDocument(
    "policy.docx",
    readFileSync(new URL("./fixtures/support-policy.docx", import.meta.url)),
  );
  assert.match(doc.text, /七天/);
  assert.match(
    (await parseDocument("a.md", Buffer.from("中文知识"))).text,
    /中文/,
  );
  for (const [name, data] of [
    ["a.pdf", "invalid"],
    ["a.docx", "invalid"],
    ["a.txt", "\0"],
    ["a.xls", "abc"],
  ])
    await assert.rejects(
      parseDocument(name, Buffer.from(data)),
      (e) => e.status === 400,
    );
  await assert.rejects(
    parseDocument(
      "a.pdf",
      readFileSync(new URL("./fixtures/support-policy.pdf", import.meta.url)),
      { timeout: 1 },
    ),
    (e) => e.status === 408,
  );
});
test("attachment retries are idempotent, content guarded and internal files remain private", async () => {
  const v = await start(),
    other = await start();
  const headers = {
    Authorization: "Bearer " + v.token,
    "X-Filename": encodeURIComponent("测试.html"),
    "X-Client-Id": "attachment_retry_001",
  };
  let r = await call(
    "/widget/attachments?id=" + v.id,
    "POST",
    Buffer.from("<script>test</script>"),
    headers,
  );
  assert.equal(r.status, 201);
  const id = r.data.attachment.id;
  r = await call(
    "/widget/attachments?id=" + v.id,
    "POST",
    Buffer.from("<script>test</script>"),
    headers,
  );
  assert.equal(r.data.duplicate, true);
  assert.equal(
    (
      await call(
        "/widget/attachments?id=" + v.id,
        "POST",
        Buffer.from("changed"),
        headers,
      )
    ).status,
    409,
  );
  r = await call("/widget/attachments/" + id + "?id=" + v.id, "GET", null, {
    Authorization: "Bearer " + v.token,
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.equal(
    (
      await call("/widget/attachments/" + id + "?id=" + other.id, "GET", null, {
        Authorization: "Bearer " + other.token,
      })
    ).status,
    404,
  );
  r = await call(
    "/conversations/" + v.id + "/attachments",
    "POST",
    Buffer.from("private"),
    {
      "X-Filename": "internal.txt",
      "X-Internal-Note": "1",
      "X-Client-Id": "internal_attachment_01",
    },
  );
  assert.equal(r.status, 201);
  assert.equal(
    (
      await call(
        "/widget/attachments/" + r.data.attachment.id + "?id=" + v.id,
        "GET",
        null,
        { Authorization: "Bearer " + v.token },
      )
    ).status,
    404,
  );
  const sent = await send(other, "重试消息");
  assert.equal(sent.status, 201);
  assert.equal((await send(other, "重试消息")).data.duplicate, true);
  assert.equal((await send(other, "修改消息")).status, 409);
});
test("knowledge document import indexes content and preserves original bytes", async () => {
  const bytes = readFileSync(
    new URL("./fixtures/support-policy.docx", import.meta.url),
  );
  const r = await call("/knowledge/files", "POST", bytes, {
    "X-Filename": "policy.docx",
  });
  assert.equal(r.status, 201);
  assert.ok(r.data.chunkCount > 0);
  const original = await call("/knowledge/files/" + r.data.id);
  assert.equal(original.status, 200);
  assert.deepEqual(original.data, bytes);
  assert.equal(
    (
      await call("/knowledge/files", "POST", Buffer.from("broken"), {
        "X-Filename": "bad.pdf",
      })
    ).status,
    400,
  );
});
test("workspace reception endpoints are removed; working hours retain revision validation and team creation is removed", async () => {
  assert.equal((await call("/service/settings")).status, 404);
  assert.equal((await call("/service/settings", "PUT", {})).status, 404);
  assert.equal((await call("/service/runs")).status, 404);
  const old = (await call("/team-hours")).data;
  assert.equal(old.enabled, false);
  const next = {
    ...old,
    enabled: true,
    weekdays: [1],
    start: "22:00",
    end: "06:00",
  };
  assert.equal(
    (
      await call("/team-hours", "PUT", {
        expectedRevision: old.revision,
        value: next,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/team-hours", "PUT", {
        expectedRevision: old.revision,
        value: next,
      })
    ).status,
    409,
  );
  const fresh = (await call("/team-hours")).data;
  assert.equal(
    (
      await call("/team-hours", "PUT", {
        expectedRevision: fresh.revision,
        value: { ...fresh, timeZone: "bad-zone" },
      })
    ).status,
    400,
  );
  await call("/team-hours", "PUT", {
    expectedRevision: fresh.revision,
    value: { ...old, enabled: false },
  });
  const team = await call("/teams", "POST", {
    name: "售后",
    memberIds: [admin.id],
  });
  assert.equal(team.status, 404);
  assert.equal(
    (
      await call("/service/members/" + admin.id, "PATCH", {
        availability: "available",
        capacity: 3,
      })
    ).status,
    200,
  );
  const visitor = await start();
  await send(visitor, "退货");
  const thread = await detail(visitor);
  assert.equal(thread.conversation.assignee, "");
  assert.equal(thread.messages.filter((m) => m.source === "ai").length, 0);
});

test("AI publishes a complete answer; manual takeover cancels in-flight output", async () => {
  const platform = (
    await call("/access/channels", "POST", {
      type: "web",
      name: "AI测试",
      title: "AI",
      enabled: true,
      origins: [],
      ai_mode: "auto",
    })
  ).data;
  let v = await start(platform.public_key);
  await send(v, "普通问题");
  for (let i = 0; i < 30; i++) {
    if ((await detail(v)).messages.some((m) => m.source === "ai")) break;
    await delay(20);
  }
  assert.ok(
    (await detail(v)).messages.some(
      (m) => m.source === "ai" && m.body === "模拟答复",
    ),
  );
  v = await start(platform.public_key);
  await send(v, "慢速问题");
  for (let i = 0; i < 30; i++) {
    if ((await detail(v)).automation.typing) break;
    await delay(20);
  }
  let d = await detail(v);
  assert.equal(d.automation.typing, true);
  assert.equal(
    (
      await call("/conversations/" + v.id + "/handoff", "POST", {
        expectedRevision: d.conversation.revision,
      })
    ).status,
    200,
  );
  await delay(750);
  d = await detail(v);
  assert.equal(d.conversation.assignee, admin.id);
  assert.equal(d.automation.mode, "human");
  assert.ok(!d.messages.some((m) => m.source === "ai"));
});

test("provider management, collaboration drafts, workflow model selection and usage are wired through real API routes", async () => {
  let r = await call("/ai/providers", "POST", {
    name: "本地模拟供应商",
    protocol: "openai",
    endpoint: "http://127.0.0.1:14341/v1",
    model: "mock",
    key: "local-secret-for-test",
    isDefault: true,
    pricing: { currency: "USD", input: 1, output: 2 },
  });
  assert.equal(r.status, 201);
  assert.ok(!JSON.stringify(r.data).includes("local-secret-for-test"));
  const providerId = r.data.id;
  const agent = async (name, config = {}) =>
    (
      await call("/resources", "POST", {
        kind: "agent",
        name,
        description: "专注本领域，提供意见",
        config: { providerId, ...config },
      })
    ).data.id;
  const a = await agent("政策专家"),
    b = await agent("物流专家"),
    lead = await agent("协调者", {
      collaboration: { enabled: true, memberIds: [a, b], rounds: 1 },
    });
  const draft = await fetch(base + "/api/ai/draft", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: lead, question: "如何退货？" }),
  });
  const stream = await draft.text();
  assert.match(stream, /event: collaboration/);
  assert.match(stream, /event: delta/);
  assert.match(stream, /event: done/);
  const runs = await call("/ai/collaborations");
  assert.equal(runs.status, 200);
  assert.equal(runs.data[0].status, "succeeded");
  assert.equal(runs.data[0].steps.length, 2);
  const usage = await call("/ai/usage");
  assert.ok(
    usage.data.items.filter((x) => x.provider_id === providerId).length >= 3,
  );
  assert.ok(
    usage.data.items
      .filter((x) => x.provider_id === providerId)
      .every((x) => !Object.hasOwn(x, "cost") && !Object.hasOwn(x, "pricing")),
  );
  r = await call("/ai/providers/" + providerId + "/test", "POST");
  assert.equal(r.status, 200);
  const definition = {
    nodes: [
      { id: "s", type: "start" },
      { id: "m", type: "llm", config: { agentId: a, prompt: "{{input}}" } },
      { id: "o", type: "output", config: { value: "{{nodes.m}}" } },
    ],
    edges: [
      { source: "s", target: "m" },
      { source: "m", target: "o" },
    ],
  };
  const flow = await call("/resources", "POST", {
    kind: "workflow",
    name: "模型路由验收",
    config: { definition },
  });
  r = await call("/workflows/" + flow.data.id + "/run", "POST", {
    input: "hi",
  });
  assert.equal(r.data.status, "succeeded");
  assert.equal(r.data.output, "模拟答复");
  const platform = (
    await call("/access/channels", "POST", {
      type: "web",
      name: "协作入口",
      title: "客服",
      enabled: true,
      origins: [],
      ai_mode: "auto",
      agent_id: lead,
    })
  ).data;
  const v = await start(platform.public_key);
  await send(v, "政策咨询", "collaboration_auto_01");
  for (let i = 0; i < 50; i++) {
    if ((await detail(v)).messages.some((m) => m.source === "ai")) break;
    await delay(20);
  }
  const final = await detail(v);
  assert.equal(final.messages.filter((m) => m.source === "ai").length, 1);
  assert.equal(final.messages.find((m) => m.source === "ai").body, "模拟答复");
});

test("provider keys, usage and internal collaboration records are restricted to administrators", async () => {
  const invite = await call("/invitations", "POST", {
    email: "restricted@local.test",
    role: "agent",
  });
  assert.equal(invite.status, 201);
  const token = invite.data.path.split("invite=")[1];
  assert.equal(
    (
      await call("/invites/" + token + "/accept", "POST", {
        name: "权限验收客服",
        password: "test-password-2026",
      })
    ).status,
    201,
  );
  const login = await call("/login", "POST", {
    email: "restricted@local.test",
    password: "test-password-2026",
  });
  const staffCookie = login.headers.get("set-cookie").split(";")[0];
  for (const path of [
    "/ai/providers",
    "/ai/usage",
    "/ai/collaborations",
    "/team-hours",
  ])
    assert.equal(
      (await call(path, "GET", null, { Cookie: staffCookie })).status,
      403,
    );
  assert.equal(
    (
      await call(
        "/ai/providers",
        "POST",
        { name: "no-access" },
        { Cookie: staffCookie },
      )
    ).status,
    403,
  );
});

test("receipt endpoints reject foreign cursors and account-mismatched retries; incremental history excludes notes", async () => {
  const v = await start(),
    other = await start();
  await send(v, "第一条", "receipt_message_001");
  await send(v, "第二条", "receipt_message_002");
  let d = await detail(v);
  const seq = d.messages.at(-1).seq;
  const note = await call("/conversations/" + v.id + "/messages", "POST", {
    body: "私有备注",
    internal: true,
    clientId: "receipt_private_note",
  });
  assert.equal(note.status, 200);
  d = await detail(v);
  const privateSeq = d.messages.at(-1).seq;
  let r = await call(
    "/widget/receipts",
    "POST",
    { id: v.id, deliveredSeq: privateSeq, readSeq: 0 },
    { Authorization: "Bearer " + v.token },
  );
  assert.equal(r.status, 400);
  r = await call(
    "/widget/receipts",
    "POST",
    { id: other.id, deliveredSeq: seq, readSeq: 0 },
    { Authorization: "Bearer " + other.token },
  );
  assert.equal(r.status, 400);
  r = await call("/widget?id=" + v.id + "&after=0&limit=1", "GET", null, {
    Authorization: "Bearer " + v.token,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.messages.length, 1);
  assert.equal(r.data.hasMore, true);
  const next = r.data.nextCursor;
  r = await call("/widget?id=" + v.id + "&after=" + next, "GET", null, {
    Authorization: "Bearer " + v.token,
  });
  assert.ok(r.data.messages.every((m) => m.role !== "note" && m.seq > next));
  r = await call(
    "/conversations/" + v.id + "/messages",
    "POST",
    { body: "wrong account", clientId: "receipt_wrong_user" },
    { "X-Expected-User": "another-account" },
  );
  assert.equal(r.status, 409);
});
