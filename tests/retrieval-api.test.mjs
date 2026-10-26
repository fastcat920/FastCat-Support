import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const dir = mkdtempSync(join(tmpdir(), "fc-retrieval-api-")),
  base = "http://127.0.0.1:14400";
let child, model, cookie, providerId, modelId, documentId, staffCookie;
async function call(path, method = "GET", data, auth = cookie) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: { Cookie: auth || "", "Content-Type": "application/json" },
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
  model = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const b = JSON.parse(raw || "{}");
    assert.equal(req.headers.authorization, "Bearer local-retrieval-secret");
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"data":[{"id":"chat"},{"id":"embed-test"}]}');
      return;
    }
    if (req.url === "/v1/embeddings") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: b.input.map((text, index) => ({
            index,
            embedding: /取消|money|refund/.test(text) ? [1, 0, 0] : [0, 1, 0],
          })),
          usage: { prompt_tokens: 10 },
        }),
      );
      return;
    }
    assert.ok(b.messages[0].content.includes("取消购买"));
    if (
      b.tools?.some((t) => t.function.name.startsWith("workflow_")) &&
      !b.messages.some((m) => m.role === "tool")
    ) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "workflow-call",
                      type: "function",
                      function: {
                        name: b.tools.find((t) =>
                          t.function.name.startsWith("workflow_"),
                        ).function.name,
                        arguments: JSON.stringify({ input: "order-42" }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [
            { delta: { content: "七天内可以取消购买" }, finish_reason: "stop" },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise((r) => model.listen(14401, "127.0.0.1", r));
  child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: "14400", DB_PATH: join(dir, "test.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error("server failed");
    }),
  ]);
  const setup = await call("/setup", "POST", {
    name: "检索管理员",
    email: "retrieval@local.test",
    password: "retrieval-test-password",
  });
  cookie = setup.headers.get("set-cookie").split(";")[0];
  const p = await call("/ai/providers", "POST", {
    name: "本地模型",
    protocol: "openai",
    endpoint: "http://127.0.0.1:14401/v1",
    model: "chat",
    key: "local-retrieval-secret",
    enabled: true,
    isDefault: true,
    pricing: { currency: "USD" },
  });
  assert.equal(p.status, 201);
  providerId = p.data.id;
  const m = await call("/ai/models", "POST", {
    provider_id: providerId,
    model: "embed-test",
    name: "语义模型",
    model_type: "embedding",
    dimensions: 3,
    enabled: true,
  });
  assert.equal(m.status, 201);
  modelId = m.data.id;
  documentId = (
    await call("/resources", "POST", {
      kind: "knowledge",
      name: "退货资料",
      description: "收到商品后七天内可以取消购买",
      config: { collectionId: "default" },
    })
  ).data.id;
  await call("/resources", "POST", {
    kind: "knowledge",
    name: "发货资料",
    description: "包裹翌日发出",
    config: { collectionId: "default" },
  });
  const cfg = await call("/knowledge/retrieval/collections/default", "PUT", {
    model_id: modelId,
    mode: "hybrid",
    auto_index: false,
    expand_query: false,
    expectedRevision: 0,
  });
  assert.equal(cfg.status, 200);
  assert.equal(
    (await call("/knowledge/retrieval/collections/default/index", "POST"))
      .status,
    202,
  );
  for (let i = 0; i < 100; i++) {
    const status = await call("/knowledge/retrieval/collections/default");
    if (status.data.config.pending === 0) break;
    await delay(25);
  }
  assert.equal(
    (await call("/knowledge/retrieval/collections/default")).data.config
      .pending,
    0,
  );
  const invite = await call("/invitations", "POST", {
    email: "retrieval-staff@local.test",
    role: "agent",
  });
  const token = invite.data.path.split("invite=")[1];
  await call(
    "/invites/" + token + "/accept",
    "POST",
    { name: "检索客服", password: "retrieval-test-password" },
    "",
  );
  const login = await call(
    "/login",
    "POST",
    {
      email: "retrieval-staff@local.test",
      password: "retrieval-test-password",
    },
    "",
  );
  staffCookie = login.headers.get("set-cookie").split(";")[0];
});
after(async () => {
  child?.kill();
  if (child) await once(child, "exit");
  await new Promise((r) => model.close(r));
  rmSync(dir, { recursive: true, force: true });
});
test("catalog and retrieval APIs execute real local embedding requests and expose mode/latency/ranking diagnostics", async () => {
  const models = await call("/ai/models");
  assert.equal(models.data.length, 2);
  assert.ok(!JSON.stringify(models.data).includes("local-retrieval-secret"));
  assert.equal(
    (await call("/ai/providers/" + providerId + "/models/discover", "POST"))
      .data.models.length,
    2,
  );
  const keyword = await call("/knowledge/retrieval/search", "POST", {
    query: "money back",
    collectionIds: ["default"],
    mode: "bm25",
  });
  assert.equal(keyword.data.results.length, 0);
  const semantic = await call("/knowledge/retrieval/search", "POST", {
    query: "money back",
    collectionIds: ["default"],
    mode: "semantic",
  });
  assert.equal(semantic.status, 200);
  assert.equal(semantic.data.results[0].id, documentId);
  assert.equal(semantic.data.metadata.mode, "semantic");
  assert.ok(semantic.data.metadata.elapsedMs >= 0);
  const hybrid = await call("/knowledge/retrieval/search", "POST", {
    query: "money back",
    collectionIds: ["default"],
    mode: "hybrid",
    variants: ["取消购买"],
  });
  assert.ok(hybrid.data.results[0].ranks.some((r) => r.kind === "semantic"));
  assert.ok(hybrid.data.results[0].ranks.some((r) => r.kind === "keyword"));
  const usage = (await call("/ai/usage")).data;
  assert.ok(usage.items.some((r) => r.context === "embedding-index"));
});
test("AI drafts and workflow knowledge nodes use configured hybrid retrieval rather than a separate keyword-only path", async () => {
  const draft = await call("/ai/draft", "POST", { question: "money back" });
  assert.equal(draft.status, 200);
  assert.match(draft.data, /七天内可以取消购买/);
  assert.match(draft.data, /退货资料/);
  const definition = {
    nodes: [
      { id: "start", type: "start" },
      {
        id: "find",
        type: "knowledge",
        config: { query: "{{input}}", collectionId: "default" },
      },
      { id: "out", type: "output", config: { value: "{{nodes.find}}" } },
    ],
    edges: [
      { source: "start", target: "find" },
      { source: "find", target: "out" },
    ],
  };
  const workflow = await call("/resources", "POST", {
    kind: "workflow",
    name: "语义流程",
    description: "",
    config: { definition },
  });
  assert.equal(workflow.status, 201);
  const run = await call("/workflows/" + workflow.data.id + "/run", "POST", {
    input: "money back",
  });
  assert.equal(run.status, 200);
  assert.equal(run.data.status, "succeeded");
  assert.equal(run.data.output[0].id, documentId);
});
test("staff may test shared retrieval but cannot alter provider/model/index settings; revision and incomplete-index errors stay explicit", async () => {
  assert.equal(
    (
      await call(
        "/knowledge/retrieval/collections/default",
        "GET",
        undefined,
        staffCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/knowledge/retrieval/search",
        "POST",
        { query: "money back", collectionIds: ["default"], mode: "semantic" },
        staffCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/ai/models", "GET", undefined, staffCookie)).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/knowledge/retrieval/collections/default/index",
        "POST",
        {},
        staffCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/knowledge/retrieval/collections/default", "PUT", {
        model_id: modelId,
        mode: "bm25",
        auto_index: false,
        expand_query: false,
        expectedRevision: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/resources/" + documentId, "PATCH", {
        name: "退货资料",
        description: "更新后的取消购买规则",
        config: { collectionId: "default" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/knowledge/retrieval/search", "POST", {
        query: "money back",
        collectionIds: ["default"],
        mode: "semantic",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/knowledge/retrieval/search", "POST", {
        query: "取消购买",
        collectionIds: ["default"],
        mode: "bm25",
      })
    ).status,
    200,
  );
});

test("batch creation is atomic and defaults drive chat resolution and inherited embedding without overriding collection choices", async () => {
  const before = (await call("/ai/models")).data.length;
  const bad = await call("/ai/models/batch", "POST", {
    provider_id: providerId,
    models: [
      { model: "atomic-new", model_type: "chat" },
      { model: "", model_type: "chat" },
    ],
  });
  assert.equal(bad.status, 400);
  assert.equal((await call("/ai/models")).data.length, before);
  const batch = await call("/ai/models/batch", "POST", {
    provider_id: providerId,
    models: [
      { model: "chat-two", model_type: "chat" },
      { model: "embed-two", model_type: "embedding" },
    ],
  });
  assert.equal(batch.status, 201);
  assert.equal(batch.data.length, 2);
  assert.equal(
    (
      await call("/ai/models/batch", "POST", {
        provider_id: providerId,
        models: [{ model: "chat-two", model_type: "chat" }],
      })
    ).status,
    409,
  );
  const d = (await call("/ai/defaults")).data;
  const saved = await call("/ai/defaults", "PUT", {
    chat_id: batch.data[0].id,
    embedding_id: batch.data[1].id,
    expectedRevision: d.revision,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.chat_id, batch.data[0].id);
  assert.equal(
    (await call("/ai/providers")).data.find((p) => p.id === providerId).model,
    "chat-two",
  );
  assert.equal(
    (await call("/knowledge/retrieval/collections/default")).data.config
      .model_id,
    modelId,
  );
  assert.equal(
    (
      await call("/ai/defaults", "PUT", {
        chat_id: batch.data[0].id,
        expectedRevision: d.revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/ai/defaults", "PUT", {
        chat_id: modelId,
        expectedRevision: saved.data.revision,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/ai/defaults",
        "PUT",
        { expectedRevision: saved.data.revision },
        staffCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/ai/models/batch",
        "POST",
        {
          provider_id: providerId,
          models: [{ model: "forbidden", model_type: "chat" }],
        },
        staffCookie,
      )
    ).status,
    403,
  );
  const cfg = (await call("/knowledge/retrieval/collections/default")).data
    .config;
  assert.equal(
    (
      await call("/knowledge/retrieval/collections/default", "PUT", {
        model_id: null,
        mode: "semantic",
        auto_index: false,
        expand_query: false,
        expectedRevision: cfg.revision,
      })
    ).status,
    200,
  );
  const inherited = (await call("/knowledge/retrieval/collections/default"))
    .data.config;
  assert.equal(inherited.configured_model_id, null);
  assert.equal(inherited.model_id, batch.data[1].id);
  assert.equal(
    (await call("/knowledge/retrieval/collections/default/index", "POST", {}))
      .status,
    202,
  );
  for (let i = 0; i < 100; i++) {
    if (
      (await call("/knowledge/retrieval/collections/default")).data.config
        .pending === 0
    )
      break;
    await delay(25);
  }
  assert.equal(
    (
      await call("/knowledge/retrieval/search", "POST", {
        query: "money back",
        collectionIds: ["default"],
        mode: "semantic",
      })
    ).status,
    200,
  );
});

test("agent workflow binding executes a published version over HTTP, no-knowledge stays empty, and billing is absent from APIs", async () => {
  const definition = {
    nodes: [
      { id: "start", type: "start" },
      { id: "out", type: "output", config: { value: "{{input}}" } },
    ],
    edges: [{ source: "start", target: "out" }],
  };
  const w = await call("/resources", "POST", {
    kind: "workflow",
    name: "绑定流程",
    description: "返回订单输入",
    config: { definition },
  });
  assert.equal(w.status, 201);
  assert.equal(
    (
      await call("/workflows/" + w.data.id + "/publish", "POST", {
        expectedRevision: 0,
        note: "test",
      })
    ).status,
    201,
  );
  const a = await call("/resources", "POST", {
    kind: "agent",
    name: "售后专员",
    description: "处理取消购买咨询",
    config: {
      providerId,
      model: "chat",
      profession: "售后",
      knowledgeScope: "none",
      collectionIds: [],
      workflowIds: [w.data.id],
      historyRuns: 0,
      addDatetime: true,
      markdown: false,
      toolCallLimit: 2,
    },
  });
  assert.equal(a.status, 201);
  const result = await call("/ai/draft", "POST", {
    agentId: a.data.id,
    question: "查询订单",
  });
  assert.equal(result.status, 200);
  assert.match(result.data, /七天内可以取消购买/);
  assert.match(result.data, /event: sources\ndata: \[\]/);
  const runs = await call("/workflows/" + w.data.id + "/runs");
  assert.equal(runs.data[0].status, "succeeded");
  assert.equal(runs.data[0].version, 1);
  assert.equal((await call("/resources/" + w.data.id, "DELETE")).status, 409);
  for (const path of ["/ai/providers", "/ai/models"]) {
    const rows = (await call(path)).data;
    assert.ok(rows.every((x) => !Object.hasOwn(x, "pricing")));
  }
  const usage = (await call("/ai/usage")).data;
  assert.ok(
    usage.items.every(
      (x) =>
        !Object.hasOwn(x, "cost") &&
        !Object.hasOwn(x, "pricing") &&
        !Object.hasOwn(x, "currency"),
    ),
  );
  assert.ok(usage.summary.every((x) => !Object.hasOwn(x, "knownCost")));
});
