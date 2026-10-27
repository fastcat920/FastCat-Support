import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const dir = mkdtempSync(join(tmpdir(), "fc-agent-tools-api-")),
  base = "http://127.0.0.1:14386";
let child,
  model,
  tools,
  cookie,
  toolId,
  agentId,
  calls = 0;
async function api(path, method = "GET", data, headers = {}) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Cookie: cookie || "",
      "Content-Type": "application/json",
      ...headers,
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const raw = await r.text();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  return { status: r.status, data: value, headers: r.headers };
}
before(async () => {
  tools = createServer((req, res) => {
    assert.equal(req.url, "/orders/42");
    calls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"shipped"}');
  });
  await new Promise((resolve) => tools.listen(14385, "127.0.0.1", resolve));
  model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const p = JSON.parse(raw);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (p.messages.at(-1)?.role === "tool") {
      assert.match(p.messages.at(-1).content, /shipped/);
      res.end(
        'data: {"choices":[{"delta":{"content":"订单42已发货"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    } else {
      const name = p.tools[0].function.name;
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "lookup_call",
                      function: { name, arguments: '{"order":42}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    }
  });
  await new Promise((resolve) => model.listen(14384, "127.0.0.1", resolve));
  child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: "14386",
      DB_PATH: join(dir, "test.db"),
      AI_BASE_URL: "http://127.0.0.1:14384/v1",
      AI_API_KEY: "local-test",
      AI_MODEL: "mock",
      INTEGRATION_ALLOWED_ORIGINS: "http://127.0.0.1:14385",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error("server failed");
    }),
  ]);
  const r = await api("/setup", "POST", {
    name: "工具管理员",
    email: "tools@local.test",
    password: "tools-test-password",
  });
  cookie = r.headers.get("set-cookie").split(";")[0];
  const tool = await api("/resources", "POST", {
    kind: "tool",
    name: "订单API",
    description: "订单查询",
    config: {
      type: "openapi",
      endpoint: "http://127.0.0.1:14385",
      spec: {
        openapi: "3.0.3",
        info: { title: "orders", version: "1" },
        paths: {
          "/orders/{order}": {
            get: {
              operationId: "lookup",
              parameters: [
                {
                  name: "order",
                  in: "path",
                  required: true,
                  schema: { type: "integer" },
                },
              ],
              responses: { 200: { description: "ok" } },
            },
          },
        },
      },
    },
  });
  assert.equal(tool.status, 201);
  toolId = tool.data.id;
  const agent = await api("/resources", "POST", {
    kind: "agent",
    name: "订单助手",
    description: "使用订单工具查询后回答",
    config: {
      toolBindings: [{ resourceId: toolId, name: "lookup" }],
      maxToolRounds: 3,
    },
  });
  assert.equal(agent.status, 201);
  agentId = agent.data.id;
});
after(async () => {
  child?.kill();
  if (child) await once(child, "exit");
  await Promise.all([
    new Promise((r) => tools.close(r)),
    new Promise((r) => model.close(r)),
  ]);
  rmSync(dir, { recursive: true, force: true });
});
test("agent draft discovers bound OpenAPI operation, executes real local HTTP request and resumes generation with progress", async () => {
  const r = await api("/ai/draft", "POST", { agentId, question: "订单42状态" });
  assert.equal(r.status, 200);
  assert.match(r.data, /订单42已发货/);
  assert.match(r.data, /"type":"tool"/);
  assert.match(r.data, /event: done/);
  assert.equal(calls, 1);
  const logs = await api("/ai/tool-calls");
  assert.equal(logs.status, 200);
  assert.equal(logs.data[0].status, "succeeded");
  assert.equal(logs.data[0].tool_name, "lookup");
  assert.equal((await api("/resources/" + toolId, "DELETE")).status, 409);
});
test("platform automatic reception uses the same bound tool execution path and records the final answer", async () => {
  const profile = await api("/access/channels", "POST", {
    type: "web",
    name: "订单站点",
    title: "订单客服",
    enabled: true,
    origins: [],
    ai_mode: "auto",
    agent_id: agentId,
  });
  assert.equal(profile.status, 201);
  const key = profile.data.public_key;
  const visitor = (
    await api("/widget/start?appKey=" + key, "POST", {
      email: "order@example.test",
    })
  ).data;
  const headers = { Authorization: "Bearer " + visitor.token };
  assert.equal(
    (
      await api(
        "/widget/messages?appKey=" + key,
        "POST",
        {
          id: visitor.id,
          body: "订单42状态",
          clientId: "tool_visitor_message_0001",
        },
        headers,
      )
    ).status,
    201,
  );
  let page;
  for (let i = 0; i < 80; i++) {
    page = await api(
      "/widget?id=" + visitor.id + "&appKey=" + key,
      "GET",
      undefined,
      headers,
    );
    if (page.data.messages.some((m) => m.source === "ai")) break;
    await delay(20);
  }
  assert.ok(
    page.data.messages.some(
      (m) => m.source === "ai" && m.body === "订单42已发货",
    ),
  );
  assert.equal(calls, 2);
});
