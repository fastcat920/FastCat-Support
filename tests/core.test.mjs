import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import http from "node:http";
const dir = mkdtempSync(join(tmpdir(), "fastcat-test-"));
let child,
  cookie = "",
  visitor,
  id,
  modelServer,
  modelPayload;
const port = 14310,
  base = `http://127.0.0.1:${port}`;
async function launch() {
  child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(dir, "test.db"),
      AI_BASE_URL: "http://127.0.0.1:14311/v1",
      AI_API_KEY: "local-test-key",
      AI_MODEL: "local-test-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error("server failed");
    }),
  ]);
}
async function call(path, method = "GET", body, auth = true, token) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json();
  return { r, d };
}
before(async () => {
  modelServer = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    modelPayload = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"choices":[{"delta":{"content":"您好，可在七天内申请退款。"}}]}\n\ndata: [DONE]\n\n',
    );
  });
  modelServer.listen(14311, "127.0.0.1");
  await once(modelServer, "listening");
  await launch();
});
after(async () => {
  modelServer.close();
  child.kill();
  await once(child, "exit");
  rmSync(dir, { recursive: true, force: true });
});
test("authentication, conversation lifecycle, visitor isolation and persistence", async () => {
  assert.equal((await call("/conversations")).r.status, 401);
  assert.equal(
    (
      await call("/setup", "POST", {
        name: "测试客服",
        email: "test@example.com",
        password: "short",
      })
    ).r.status,
    400,
  );
  const setup = await call("/setup", "POST", {
    name: "测试客服",
    email: "test@example.com",
    password: "correct-password-123",
  });
  assert.equal(setup.r.status, 200);
  cookie = setup.r.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await call("/setup", "POST", {
        name: "x",
        email: "x",
        password: "1234567890",
      })
    ).r.status,
    409,
  );
  assert.equal(
    (
      await call("/login", "POST", {
        email: "test@example.com",
        password: "incorrect",
      })
    ).r.status,
    401,
  );
  const started = await call(
    "/widget/start",
    "POST",
    { name: "测试访客", email: "visitor@example.com" },
    false,
  );
  assert.equal(started.r.status, 201);
  visitor = started.d;
  id = visitor.id;
  assert.equal(
    (await call("/widget?id=" + id, "GET", null, false, "invalid")).r.status,
    403,
  );
  assert.equal(
    (
      await call(
        "/widget/messages",
        "POST",
        { id, body: "你好，我想了解退货政策" },
        false,
        visitor.token,
      )
    ).r.status,
    201,
  );
  let list = await call("/conversations");
  assert.equal(list.d.length, 1);
  assert.equal(list.d[0].preview, "你好，我想了解退货政策");
  assert.equal(
    (
      await call("/conversations/" + id + "/messages", "POST", {
        body: "这是私密备注",
        internal: true,
      })
    ).r.status,
    200,
  );
  assert.equal(
    (
      await call("/conversations/" + id + "/messages", "POST", {
        body: "您好，请提供订单号",
      })
    ).r.status,
    200,
  );
  assert.equal(
    (
      await call("/conversations/" + id, "PATCH", {
        notes: "高优先级客户",
        assignee: setup.d.id,
        status: "pending",
      })
    ).r.status,
    200,
  );
  let widget = await call(
    "/widget?id=" + id,
    "GET",
    null,
    false,
    visitor.token,
  );
  assert.equal(widget.d.messages.length, 2);
  assert.ok(!JSON.stringify(widget.d).includes("私密"));
  assert.ok(!JSON.stringify(widget.d).includes("高优先级"));
  assert.equal(widget.d.conversation.status, "pending");
  const second = await call(
    "/widget/start",
    "POST",
    { name: "另一个访客" },
    false,
  );
  assert.equal(
    (await call("/widget?id=" + id, "GET", null, false, second.d.token)).r
      .status,
    403,
  );
  assert.equal(
    (await call("/conversations/" + id, "PATCH", { status: "invalid" })).r
      .status,
    400,
  );
  await call("/conversations/" + id, "PATCH", { status: "closed" });
  assert.equal(
    (
      await call(
        "/widget/messages",
        "POST",
        { id, body: "关闭后消息" },
        false,
        visitor.token,
      )
    ).r.status,
    409,
  );
  assert.equal(
    (
      await call("/conversations/" + id + "/messages", "POST", {
        body: "关闭后回复",
      })
    ).r.status,
    409,
  );
  await call("/conversations/" + id, "PATCH", { status: "open" });
  assert.equal(
    (
      await call(
        "/widget/messages",
        "POST",
        { id, body: "重新咨询" },
        false,
        visitor.token,
      )
    ).r.status,
    201,
  );
  const knowledge = await call("/resources", "POST", {
    kind: "knowledge",
    name: "退款政策",
    description: "七天内可申请退款",
    config: {},
  });
  assert.equal(knowledge.r.status, 201);
  assert.equal(
    (await call("/search?q=" + encodeURIComponent("七天"))).d.length,
    1,
  );
  assert.equal(
    (await call("/resources", "POST", { kind: "invalid", name: "bad" })).r
      .status,
    400,
  );
  assert.equal(
    (
      await call("/resources/" + knowledge.d.id, "PATCH", {
        name: "退款政策更新",
        description: "七天内可申请退款",
        config: { source: "manual" },
      })
    ).r.status,
    200,
  );
  assert.equal(
    (await call("/resources?kind=knowledge")).d[0].name,
    "退款政策更新",
  );
  const draft = await fetch(base + "/api/ai/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ conversationId: id, question: "七天内如何退款" }),
  });
  assert.equal(draft.status, 200);
  const stream = await draft.text();
  assert.ok(stream.includes("event: sources"));
  assert.ok(stream.includes("event: delta"), stream);
  assert.ok(stream.includes("event: done"));
  assert.ok(modelPayload.messages[0].content.includes("七天内可申请退款"));
  assert.ok(!JSON.stringify(modelPayload).includes("私密备注"));
  assert.equal(modelPayload.model, "local-test-model");
  assert.equal((await call("/conversations/" + id)).d.messages.length, 4);

  child.kill();
  await once(child, "exit");
  await launch();
  assert.equal((await call("/setup")).d.required, false);
  assert.equal((await call("/conversations/" + id)).d.messages.length, 4);
  assert.equal((await call("/resources?kind=knowledge")).d.length, 1);
  await call("/resources/" + knowledge.d.id, "DELETE");
  assert.equal((await call("/resources?kind=knowledge")).d.length, 0);
  assert.equal((await call("/logout", "POST")).r.status, 200);
  assert.equal((await call("/me")).r.status, 401);
});
test("static surfaces and traversal boundary", async () => {
  for (const p of ["/", "/widget", "/style.css", "/app.js", "/widget.js"])
    assert.equal((await fetch(base + p)).status, 200);
  assert.notEqual((await fetch(base + "/../server.mjs")).status, 200);
});
