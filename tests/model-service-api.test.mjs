import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "fc-model-service-")),
  base = "http://127.0.0.1:14430/api",
  secret = "local-model-service-secret";
let child,
  model,
  cookie,
  staffCookie,
  failDiscovery = false,
  created;
const seen = [];
async function call(path, method = "GET", data, auth = cookie) {
  const r = await fetch(base + path, {
    method,
    headers: { Cookie: auth || "", "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: r.status, data: await r.json() };
}
const provider = () => ({
  name: "统一模型服务",
  protocol: "openai",
  endpoint: "http://127.0.0.1:14431/v1",
  key: secret,
  enabled: true,
});
before(async () => {
  model = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + secret);
    let raw = "";
    for await (const c of req) raw += c;
    const b = JSON.parse(raw || "{}");
    seen.push({ path: req.url, model: b.model });
    if (req.url === "/v1/models") {
      res.writeHead(failDiscovery ? 503 : 200, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({ data: [{ id: "chat-one" }, { id: "embed-one" }] }),
      );
    } else if (req.url === "/v1/embeddings") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: b.input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
          usage: { prompt_tokens: 1 },
        }),
      );
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
      );
    }
  });
  model.listen(14431, "127.0.0.1");
  await once(model, "listening");
  child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: "14430", DB_PATH: join(dir, "test.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await once(child.stdout, "data");
  const setup = await fetch(base + "/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "管理员",
      email: "models@local.test",
      password: "models-test-password",
    }),
  });
  cookie = setup.headers.get("set-cookie").split(";")[0];
  const inv = await call("/invitations", "POST", {
    email: "model-staff@local.test",
    role: "agent",
  });
  const token = inv.data.path.split("invite=")[1];
  await call(
    "/invites/" + token + "/accept",
    "POST",
    { name: "客服", password: "models-test-password" },
    "",
  );
  const login = await fetch(base + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "model-staff@local.test",
      password: "models-test-password",
    }),
  });
  staffCookie = login.headers.get("set-cookie").split(";")[0];
});
after(async () => {
  child?.kill();
  if (child) await once(child, "exit");
  await new Promise((r) => model.close(r));
  rmSync(dir, { recursive: true, force: true });
});
test("preview reads models without saving provider, models, defaults or credentials", async () => {
  const defaults = (await call("/ai/defaults")).data;
  const preview = await call(
    "/ai/providers/preview-models",
    "POST",
    provider(),
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.data.models.length, 2);
  assert.equal((await call("/ai/providers")).data.length, 0);
  assert.equal((await call("/ai/models")).data.length, 0);
  assert.deepEqual((await call("/ai/defaults")).data, defaults);
  assert.equal(
    (
      await call("/ai/providers/preview-models", "POST", {
        ...provider(),
        endpoint: "https://user:pass@example.com/v1",
      })
    ).status,
    400,
  );
  failDiscovery = true;
  assert.equal(
    (await call("/ai/providers/preview-models", "POST", provider())).status,
    502,
  );
  failDiscovery = false;
  assert.equal((await call("/ai/providers")).data.length, 0);
});
test("provider, mixed models and defaults save atomically with no secret in response", async () => {
  const d = (await call("/ai/defaults")).data;
  created = await call("/ai/services", "POST", {
    provider: provider(),
    models: [
      { model: "chat-one", model_type: "chat" },
      { model: "embed-one", model_type: "embedding", dimensions: 3 },
    ],
    defaults: { chat_model: "chat-one", embedding_model: "embed-one" },
    expectedDefaultsRevision: d.revision,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.models.length, 2);
  assert.ok(created.data.defaults.chat_id);
  assert.ok(created.data.defaults.embedding_id);
  assert.equal(created.data.provider.is_default, true);
  assert.ok(!JSON.stringify(created.data).includes(secret));
  assert.ok(!readFileSync(join(dir, "test.db")).includes(Buffer.from(secret)));
  assert.equal((await call("/ai/providers")).data.length, 1);
});
test("invalid model, invalid default and stale defaults never leave partially created services", async () => {
  const before = {
    providers: (await call("/ai/providers")).data,
    models: (await call("/ai/models")).data,
    defaults: (await call("/ai/defaults")).data,
  };
  for (const models of [
    [
      { model: "new", model_type: "chat" },
      { model: "", model_type: "chat" },
    ],
    [
      { model: "same", model_type: "chat" },
      { model: "same", model_type: "chat" },
    ],
    [{ model: 123, model_type: "chat" }],
  ]) {
    const r = await call("/ai/services", "POST", {
      provider: provider(),
      models,
    });
    assert.ok([400, 409].includes(r.status));
  }
  assert.equal(
    (
      await call("/ai/services", "POST", {
        provider: provider(),
        models: [{ model: "only-chat", model_type: "chat" }],
        defaults: { embedding_model: "only-chat" },
        expectedDefaultsRevision: before.defaults.revision,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/ai/services", "POST", {
        provider: provider(),
        models: [{ model: "only-chat", model_type: "chat" }],
        defaults: { chat_model: "only-chat" },
        expectedDefaultsRevision: -1,
      })
    ).status,
    409,
  );
  assert.deepEqual((await call("/ai/providers")).data, before.providers);
  assert.deepEqual((await call("/ai/models")).data, before.models);
  assert.deepEqual((await call("/ai/defaults")).data, before.defaults);
});
test("individual chat and embedding tests execute the selected model without changing defaults", async () => {
  const before = (await call("/ai/defaults")).data;
  for (const m of created.data.models)
    assert.equal(
      (await call("/ai/models/" + m.id + "/test", "POST", {})).status,
      200,
    );
  assert.ok(
    seen.some(
      (r) => r.path === "/v1/chat/completions" && r.model === "chat-one",
    ),
  );
  assert.ok(
    seen.some((r) => r.path === "/v1/embeddings" && r.model === "embed-one"),
  );
  assert.deepEqual((await call("/ai/defaults")).data, before);
});
test("staff cannot preview credentials, create services or test provider models", async () => {
  for (const [path, data] of [
    ["/ai/providers/preview-models", provider()],
    ["/ai/services", { provider: provider(), models: [] }],
    ["/ai/models/" + created.data.models[0].id + "/test", {}],
  ])
    assert.equal((await call(path, "POST", data, staffCookie)).status, 403);
});
test("model and provider deletion respects references and preserves usage history", async () => {
  const defaults = (await call("/ai/defaults")).data;
  const blocked = (await call("/ai/models")).data.find(
    (m) => m.id === defaults.chat_id,
  );
  assert.equal(
    (
      await call("/ai/models/" + blocked.id, "DELETE", {
        expectedRevision: blocked.revision,
      })
    ).status,
    409,
  );
  const result = await call("/ai/services", "POST", {
    provider: { ...provider(), name: "待删除服务" },
    models: [
      { model: "disposable-chat", model_type: "chat" },
      { model: "disposable-embed", model_type: "embedding" },
    ],
  });
  assert.equal(result.status, 201);
  const service = result.data.provider;
  const chat = result.data.models.find((m) => m.model_type === "chat");
  assert.equal(
    (
      await call(
        "/ai/models/" + chat.id,
        "DELETE",
        { expectedRevision: chat.revision },
        staffCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/ai/models/" + chat.id, "DELETE", {
        expectedRevision: chat.revision + 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/ai/models/" + chat.id, "DELETE", {
        expectedRevision: chat.revision,
      })
    ).status,
    200,
  );
  assert.ok(!(await call("/ai/models")).data.some((m) => m.id === chat.id));
  const updated = (await call("/ai/providers")).data.find(
    (p) => p.id === service.id,
  );
  assert.equal(updated.model, "");
  assert.equal(
    (
      await call("/ai/providers/" + updated.id, "DELETE", {
        expectedRevision: updated.revision,
      })
    ).status,
    200,
  );
  assert.ok(
    !(await call("/ai/models")).data.some((m) => m.provider_id === service.id),
  );
  assert.ok((await call("/ai/usage")).data.items.length > 0);
});
