import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateProviders, createProviders } from "../lib/providers.mjs";
import {
  migrateAgentTeams,
  createAgentRunner,
  validateAgentConfig,
} from "../lib/agent-teams.mjs";
import { streamCompletion } from "../lib/ai.mjs";
const collect = async (generator) => {
  let text = "";
  for await (const t of generator) text += t;
  return text;
};
const openStream = (
  text = "答复",
  usage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 10 },
  },
) =>
  new Response(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { content: text }, finish_reason: "stop" }],
      }) +
      "\n\ndata: " +
      JSON.stringify({ choices: [], usage }) +
      "\n\ndata: [DONE]\n\n",
  );
function setup(fetcher) {
  const db = new DatabaseSync(":memory:");
  migrateProviders(db);
  db.exec(
    "CREATE TABLE resources(id TEXT PRIMARY KEY,kind TEXT,name TEXT,description TEXT,config TEXT)",
  );
  migrateAgentTeams(db);
  const dir = mkdtempSync(join(tmpdir(), "fc-providers-"));
  const p = createProviders(db, { keyPath: join(dir, "master.key"), fetcher });
  return {
    db,
    p,
    dir,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const config = {
  name: "供应商",
  protocol: "openai",
  endpoint: "https://model.example/v1",
  model: "custom-model",
  key: "test-private-secret",
  enabled: true,
  isDefault: true,
  pricing: {
    currency: "USD",
    input: 1,
    output: 2,
    cacheRead: 0.5,
    cacheWrite: 2,
  },
};
test("provider keys encrypt at rest, stay masked, rotate with revision and usage prices are snapshotted", async () => {
  let auth;
  const x = setup(async (url, o) => {
    auth = o.headers.Authorization;
    return openStream();
  });
  try {
    const row = x.p.save(config);
    assert.equal(row.keyConfigured, true);
    assert.ok(!JSON.stringify(row).includes(config.key));
    assert.ok(
      !x.db
        .prepare("SELECT secret FROM ai_providers")
        .get()
        .secret.includes(config.key),
    );
    assert.equal(readFileSync(join(x.dir, "master.key")).length, 32);
    assert.equal(
      await collect(
        x.p.complete({ messages: [{ role: "user", content: "hi" }] }),
      ),
      "答复",
    );
    assert.equal(auth, "Bearer " + config.key);
    let usage = x.db.prepare("SELECT * FROM ai_usage").get();
    assert.equal(usage.input_tokens, 100);
    assert.equal(usage.cost, null);
    assert.throws(
      () => x.p.save({ ...config, expectedRevision: 99 }, row.id),
      (e) => e.status === 409,
    );
    x.p.save(
      {
        ...config,
        key: "rotated-secret",
        expectedRevision: 0,
        pricing: { currency: "CNY", input: 5, output: 6 },
      },
      row.id,
    );
    await collect(x.p.complete({ messages: [] }));
    assert.equal(auth, "Bearer rotated-secret");
    usage = x.db.prepare("SELECT * FROM ai_usage ORDER BY rowid LIMIT 1").get();
    assert.equal(usage.currency, "");
    assert.equal(usage.cost, null);
  } finally {
    x.close();
  }
});
test("native Anthropic sends top-level system, parses split UTF-8 events and cache-aware cumulative usage", async () => {
  let payload;
  const x = setup(async (url, o) => {
    assert.equal(url.href, "https://model.example/v1/messages");
    assert.equal(o.headers["x-api-key"], config.key);
    assert.equal(o.headers["anthropic-version"], "2023-06-01");
    payload = JSON.parse(o.body);
    const text = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
            output_tokens: 1,
          },
        },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "中文答复" },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 20 },
      },
      { type: "message_stop" },
    ]
      .map((e) => "data: " + JSON.stringify(e) + "\n\n")
      .join("");
    const bytes = new TextEncoder().encode(text);
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += 7)
            c.enqueue(bytes.slice(i, i + 7));
          c.close();
        },
      }),
    );
  });
  try {
    x.p.save({ ...config, protocol: "anthropic" });
    assert.equal(
      await collect(
        x.p.complete({
          messages: [
            { role: "system", content: "role" },
            { role: "user", content: "hi" },
          ],
        }),
      ),
      "中文答复",
    );
    assert.equal(payload.system, "role");
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.max_tokens, 2048);
    const u = x.db.prepare("SELECT * FROM ai_usage").get();
    assert.equal(u.output_tokens, 20);
    assert.equal(u.cost, null);
  } finally {
    x.close();
  }
});
test("missing usage remains unknown and truncated or abandoned streams are not recorded as successful", async () => {
  const x = setup(
    async () =>
      new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
  );
  try {
    x.p.save(config);
    await assert.rejects(collect(x.p.complete({ messages: [] })), /未完成/);
    let r = x.db.prepare("SELECT * FROM ai_usage").get();
    assert.equal(r.status, "failed");
    assert.equal(r.cost, null);
    assert.equal(r.input_tokens, null);
    const g = x.p.complete({ messages: [] });
    await g.next();
    await g.return();
    r = x.db
      .prepare("SELECT * FROM ai_usage ORDER BY rowid DESC LIMIT 1")
      .get();
    assert.equal(r.status, "cancelled");
  } finally {
    x.close();
  }
  await assert.rejects(
    collect(
      streamCompletion({
        baseUrl: "https://model.example/v1",
        key: "x",
        model: "m",
        messages: [],
        fetcher: async () =>
          new Response(
            'data: {"choices":[{"delta":{"content":"part"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
          ),
      }),
    ),
    /未完整/,
  );
});
test("multi-agent discussion exchanges opinions and synthesizes; nested collaboration and cancellation are bounded", async () => {
  const calls = [];
  let failMember = false;
  const x = setup(async (url, o) => {
    const body = JSON.parse(o.body);
    if (failMember) throw Error("member unavailable");
    calls.push(body);
    return openStream("意见" + calls.length);
  });
  try {
    x.p.save(config);
    const add = (id, c = {}) =>
      x.db
        .prepare("INSERT INTO resources VALUES(?,?,?,?,?)")
        .run(id, "agent", id, "角色" + id, JSON.stringify(c));
    add("a");
    add("b");
    add("lead", {
      collaboration: { enabled: true, memberIds: ["a", "b"], rounds: 2 },
    });
    const runner = createAgentRunner({
      db: x.db,
      providers: x.p,
      knowledge: () => [],
    });
    const output = await collect(
      runner.stream({
        agentId: "lead",
        messages: [{ role: "user", content: "退款问题" }],
      }),
    );
    assert.equal(calls.length, 5);
    assert.equal(output, "意见5");
    assert.ok(JSON.stringify(calls[1]).includes("意见1"));
    assert.ok(JSON.stringify(calls[4]).includes("意见4"));
    const run = x.db.prepare("SELECT * FROM agent_runs").get();
    assert.equal(run.status, "succeeded");
    assert.equal(JSON.parse(run.steps).length, 4);
    assert.equal(x.db.prepare("SELECT COUNT(*) n FROM ai_usage").get().n, 5);
    assert.throws(
      () =>
        validateAgentConfig(x.db, {
          collaboration: { enabled: true, memberIds: ["lead", "a"], rounds: 1 },
        }),
      /嵌套/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      collect(
        runner.stream({
          agentId: "lead",
          messages: [],
          signal: controller.signal,
        }),
      ),
      /取消/,
    );
    assert.equal(calls.length, 5);
    const halfway = new AbortController();
    await assert.rejects(
      collect(
        runner.stream({
          agentId: "lead",
          messages: [{ role: "user", content: "query" }],
          signal: halfway.signal,
          onProgress: () => halfway.abort(),
        }),
      ),
      /取消/,
    );
    assert.equal(calls.length, 6);
    assert.equal(
      x.db
        .prepare("SELECT status FROM agent_runs ORDER BY rowid DESC LIMIT 1")
        .get().status,
      "cancelled",
    );
    failMember = true;
    await assert.rejects(
      collect(
        runner.stream({
          agentId: "lead",
          messages: [{ role: "user", content: "query" }],
        }),
      ),
      /unavailable/,
    );
    assert.equal(
      x.db
        .prepare("SELECT status FROM agent_runs ORDER BY rowid DESC LIMIT 1")
        .get().status,
      "failed",
    );
  } finally {
    x.close();
  }
});
