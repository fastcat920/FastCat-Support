import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "fastcat-features-")),
  base = "http://127.0.0.1:14320";
let processHandle,
  remote,
  cookie,
  mcpCalls = 0;
async function request(path, method = "GET", body) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie || "" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get("set-cookie"),
  };
}
before(async () => {
  remote = http.createServer(async (req, res) => {
    if (req.url === "/help") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>退货规则</h1><script>ignore me</script><p>收到商品七天内，可以申请退款。保留订单号。</p>",
      );
      return;
    }
    if (req.url.startsWith("/orders/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"shipped","tracking":"FC123"}');
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    let text = "";
    for await (const c of req) text += c;
    const b = JSON.parse(text);
    let result;
    if (b.method === "initialize") {
      res.setHeader("Mcp-Session-Id", "integration-session");
      result = {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "验收工具服务", version: "1" },
        capabilities: { tools: {} },
      };
    } else {
      assert.equal(req.headers["mcp-session-id"], "integration-session");
      if (b.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (b.method === "tools/list")
        result = {
          tools: [
            {
              name: "lookup_order",
              description: "根据订单号查询物流",
              inputSchema: {
                type: "object",
                properties: { orderId: { type: "string" } },
                required: ["orderId"],
              },
            },
          ],
        };
      if (b.method === "tools/call") {
        mcpCalls++;
        result = {
          content: [
            {
              type: "text",
              text: "订单 " + b.params.arguments.orderId + " 已发货",
            },
          ],
        };
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }));
  });
  remote.listen(14321, "127.0.0.1");
  await once(remote, "listening");
  processHandle = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: "14320",
      DB_PATH: join(dir, "app.db"),
      INTEGRATION_ALLOWED_ORIGINS: "http://127.0.0.1:14321",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(processHandle.stdout, "data"),
    once(processHandle, "exit").then(() => {
      throw Error("server failed");
    }),
  ]);
  const r = await request("/setup", "POST", {
    name: "验收管理员",
    email: "features@local.test",
    password: "features-test-password",
  });
  assert.equal(r.status, 200);
  cookie = r.cookie.split(";")[0];
});
after(async () => {
  remote.close();
  processHandle.kill();
  await once(processHandle, "exit");
  rmSync(dir, { recursive: true, force: true });
});
test("collection-scoped index, long text import, static website crawl and mutation", async () => {
  const c = await request("/knowledge/collections", "POST", {
    name: "售后知识",
    description: "退换货规则",
  });
  assert.equal(c.status, 201);
  const collectionId = c.body.id;
  const doc = await request("/knowledge/import", "POST", {
    name: "退款规则",
    collectionId,
    content: "请提供订单号后申请退款。".repeat(100),
  });
  assert.equal(doc.status, 201);
  assert.ok(doc.body.chunkCount > 1);
  let matches = await request(
    "/search?collectionId=" + collectionId + "&q=" + encodeURIComponent("退款"),
  );
  assert.ok(matches.body.length > 1);
  assert.equal(
    (
      await request(
        "/search?collectionId=default&q=" + encodeURIComponent("退款"),
      )
    ).body.length,
    0,
  );
  assert.equal(
    (await request("/knowledge/collections/" + collectionId, "DELETE")).status,
    409,
  );
  const crawl = await request("/knowledge/crawl", "POST", {
    name: "网站退货政策",
    collectionId,
    url: "http://127.0.0.1:14321/help",
  });
  assert.equal(crawl.status, 201);
  assert.equal(
    (await request("/knowledge/" + crawl.body.id + "/sync", "POST", {})).status,
    200,
  );
  let items = (await request("/resources?kind=knowledge")).body;
  const crawled = items.find((r) => r.id === crawl.body.id);
  assert.ok(crawled.description.includes("七天"));
  assert.ok(!crawled.description.includes("ignore me"));
  assert.equal(
    (
      await request("/knowledge/crawl", "POST", {
        name: "bad",
        url: "http://127.0.0.1:1/private",
      })
    ).status,
    400,
  );
  await request("/resources/" + doc.body.id, "DELETE");
  matches = await request(
    "/search?collectionId=" +
      collectionId +
      "&q=" +
      encodeURIComponent("提供订单号"),
  );
  assert.ok(matches.body.every((r) => r.id !== doc.body.id));
  await request("/resources/" + crawl.body.id, "PATCH", {
    name: "网站退货政策",
    description: crawled.description,
    config: { collectionId: "default" },
  });
  assert.equal(
    (await request("/knowledge/collections/" + collectionId, "DELETE")).status,
    200,
  );
  assert.equal(
    (await request("/knowledge/collections/default", "DELETE")).status,
    409,
  );
});
test("bound agent prevents collection deletion until detached", async () => {
  const collection = await request("/knowledge/collections", "POST", {
    name: "智能体专属知识",
  });
  const agent = await request("/resources", "POST", {
    kind: "agent",
    name: "测试助手",
    description: "客服指令",
    config: { collectionId: collection.body.id },
  });
  assert.equal(agent.status, 201);
  assert.equal(
    (await request("/knowledge/collections/" + collection.body.id, "DELETE"))
      .status,
    409,
  );
  await request("/resources/" + agent.body.id, "DELETE");
  assert.equal(
    (await request("/knowledge/collections/" + collection.body.id, "DELETE"))
      .status,
    200,
  );
});

test("MCP discovery and typed call, OpenAPI execution, DAG tool run and persisted history", async () => {
  const tool = await request("/resources", "POST", {
    kind: "tool",
    name: "订单工具",
    description: "本地测试",
    config: { type: "mcp", endpoint: "http://127.0.0.1:14321/mcp" },
  });
  assert.equal(tool.status, 201);
  const toolId = tool.body.id;
  const discovery = await request("/tools/" + toolId + "/discover", "POST", {});
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.tools[0].name, "lookup_order");
  assert.equal(
    (
      await request("/tools/" + toolId + "/call", "POST", {
        name: "lookup_order",
        arguments: {},
      })
    ).status,
    400,
  );
  assert.equal(mcpCalls, 0);
  const call = await request("/tools/" + toolId + "/call", "POST", {
    name: "lookup_order",
    arguments: { orderId: "FC100" },
  });
  assert.ok(call.body.content[0].text.includes("FC100"));
  const definition = {
    nodes: [
      { id: "start", type: "start" },
      {
        id: "lookup",
        type: "tool",
        config: {
          resourceId: toolId,
          name: "lookup_order",
          arguments: { orderId: "{{input}}" },
        },
      },
      { id: "answer", type: "output", config: { value: "{{nodes.lookup}}" } },
    ],
    edges: [
      { source: "start", target: "lookup" },
      { source: "lookup", target: "answer" },
    ],
  };
  const flow = await request("/resources", "POST", {
    kind: "workflow",
    name: "订单查询流程",
    description: "查询订单并输出",
    config: { definition },
  });
  assert.equal(flow.status, 201);
  const run = await request("/workflows/" + flow.body.id + "/run", "POST", {
    input: "FC200",
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.status, "succeeded");
  assert.ok(run.body.output.content[0].text.includes("FC200"));
  const history = await request("/workflows/" + flow.body.id + "/runs");
  assert.equal(history.body.length, 1);
  const detail = await request("/runs/" + run.body.id);
  assert.equal(detail.body.result.steps.length, 3);
  assert.equal(detail.body.status, "succeeded");
  assert.equal(
    (
      await request("/resources", "POST", {
        kind: "workflow",
        name: "bad",
        config: { definition: { nodes: [], edges: [] } },
      })
    ).status,
    400,
  );
  const schema = {
    openapi: "3.0.3",
    paths: {
      "/orders/{id}": {
        get: {
          operationId: "track",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
        },
      },
    },
  };
  const open = await request("/resources", "POST", {
    kind: "tool",
    name: "物流接口",
    description: "OpenAPI",
    config: {
      type: "openapi",
      endpoint: "http://127.0.0.1:14321",
      spec: schema,
    },
  });
  assert.equal(open.status, 201);
  assert.equal(
    (await request("/tools/" + open.body.id + "/discover", "POST", {})).body
      .protocol,
    "openapi",
  );
  assert.equal(
    (
      await request("/tools/" + open.body.id + "/call", "POST", {
        name: "track",
        arguments: { id: "FC300" },
      })
    ).body.tracking,
    "FC123",
  );
});

test("visitor SSE receives updates and both sides persist read receipts", async () => {
  const start = await request("/widget/start", "POST", {
      name: "实时验收访客",
    }),
    v = start.body;
  const widget = async (path, method = "GET", data) => {
    const r = await fetch(base + "/api/widget" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + v.token,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return r.json();
  };
  await widget("/messages", "POST", { id: v.id, body: "请查询物流" });
  assert.equal(
    (await request("/conversations")).body.find((c) => c.id === v.id)
      .unreadCount,
    1,
  );
  let detail = await request("/conversations/" + v.id);
  assert.equal(detail.body.messages[0].read_at, null);
  await request("/conversations/" + v.id + "/receipts", "POST", {
    deliveredSeq: detail.body.receipts.lastSeq,
    readSeq: detail.body.receipts.lastSeq,
  });
  detail = await request("/conversations/" + v.id);
  assert.ok(detail.body.messages[0].read_at);
  assert.equal(
    (await request("/conversations")).body.find((c) => c.id === v.id)
      .unreadCount,
    0,
  );
  const controller = new AbortController();
  const stream = await fetch(base + "/api/widget/events?id=" + v.id, {
    headers: { Authorization: "Bearer " + v.token },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /data: update/,
  );
  await request("/conversations/" + v.id + "/messages", "POST", {
    body: "已为您查询，正在配送",
  });
  const update = await reader.read();
  assert.match(new TextDecoder().decode(update.value), /data: update/);
  controller.abort();
  await reader.cancel().catch(() => {});
  const read = await widget("?id=" + v.id);
  assert.equal(read.messages.find((m) => m.role === "agent").read_at, null);
  await widget("/receipts", "POST", {
    id: v.id,
    deliveredSeq: read.receipts.lastSeq,
    readSeq: read.receipts.lastSeq,
  });
  detail = await request("/conversations/" + v.id);
  assert.ok(detail.body.messages.every((m) => m.read_at));
});

test("workflow revisions reject stale writes and immutable versions execute independently of drafts", async () => {
  const definition = {
    nodes: [
      { id: "start", type: "start", position: { x: 20, y: 20 } },
      { id: "text", type: "text", config: { text: "version one" } },
      { id: "out", type: "output", config: { value: "{{nodes.text}}" } },
    ],
    edges: [
      { source: "start", target: "text" },
      { source: "text", target: "out" },
    ],
  };
  const created = await request("/resources", "POST", {
    kind: "workflow",
    name: "版本验收",
    config: { definition },
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  let editor = (await request("/workflows/" + id + "/editor")).body;
  assert.equal(editor.revision, 0);
  let pub = await request("/workflows/" + id + "/publish", "POST", {
    expectedRevision: 0,
    note: "first",
  });
  assert.equal(pub.status, 201);
  assert.equal(pub.body.version, 1);
  editor.config.definition.nodes[1].config.text = "draft two";
  let saved = await request("/workflows/" + id + "/editor", "PUT", {
    ...editor,
    expectedRevision: 0,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.equal(
    (
      await request("/workflows/" + id + "/editor", "PUT", {
        ...editor,
        expectedRevision: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/resources/" + id, "PATCH", {
        ...editor,
        expectedRevision: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/workflows/" + id + "/publish", "POST", {
        expectedRevision: 0,
      })
    ).status,
    409,
  );
  let run = await request("/workflows/" + id + "/run", "POST", {
    input: "hi",
    published: true,
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.output, "version one");
  assert.equal(run.body.version, 1);
  run = await request("/workflows/" + id + "/run", "POST", { input: "hi" });
  assert.equal(run.body.output, "draft two");
  assert.equal(run.body.revision, 1);
  pub = await request("/workflows/" + id + "/publish", "POST", {
    expectedRevision: 1,
    note: "second",
  });
  assert.equal(pub.body.version, 2);
  let restored = await request("/workflows/" + id + "/restore", "POST", {
    expectedRevision: 1,
    version: 1,
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.revision, 2);
  assert.equal(restored.body.publishedVersion, 2);
  assert.equal(
    restored.body.config.definition.nodes[1].config.text,
    "version one",
  );
  assert.equal(
    (
      await request("/workflows/" + id + "/restore", "POST", {
        expectedRevision: 2,
      })
    ).status,
    400,
  );
  run = await request("/workflows/" + id + "/run", "POST", { published: true });
  assert.equal(run.body.output, "draft two");
  assert.equal(run.body.version, 2);
  const runDetail = await request("/runs/" + run.body.id);
  assert.equal(runDetail.body.version, 2);
  assert.equal(runDetail.body.revision, null);
  assert.equal(
    (await request("/workflows/" + id + "/versions")).body.length,
    2,
  );
  const fresh = await request("/resources", "POST", {
    kind: "workflow",
    name: "未发布",
    config: { definition },
  });
  assert.equal(
    (
      await request("/workflows/" + fresh.body.id + "/run", "POST", {
        published: true,
      })
    ).status,
    400,
  );
});

test("tool API accepts YAML and persists normalized OpenAPI schemas", async () => {
  const r = await request("/resources", "POST", {
    kind: "tool",
    name: "YAML 接口",
    config: {
      type: "openapi",
      endpoint: "http://127.0.0.1:14321",
      spec: "openapi: 3.0.3\npaths: {}",
    },
  });
  assert.equal(r.status, 201);
  const tools = await request("/resources?kind=tool");
  assert.equal(
    tools.body.find((t) => t.id === r.body.id).config.spec.openapi,
    "3.0.3",
  );
  assert.equal(
    (
      await request("/resources", "POST", {
        kind: "tool",
        name: "损坏文档",
        config: { type: "openapi", spec: "openapi: [broken" },
      })
    ).status,
    400,
  );
});
