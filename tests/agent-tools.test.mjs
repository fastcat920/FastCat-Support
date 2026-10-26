import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamCompletion } from "../lib/ai.mjs";
import { migrateProviders, createProviders } from "../lib/providers.mjs";
import {
  migrateAgentTeams,
  createAgentRunner,
  validateAgentConfig,
} from "../lib/agent-teams.mjs";
import { searchKnowledge } from "../lib/features.mjs";
const collect = async (stream) => {
  let text = "";
  for await (const part of stream) text += part;
  return text;
};
const sse = (events) =>
  new Response(
    events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("") +
      "data: [DONE]\n\n",
  );
const toolStream = (name, args = '{"order":42}', id = "call_1") =>
  sse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: args.slice(0, 5) },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
  ]);
function setup(fetcher) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE resources(id TEXT PRIMARY KEY,kind TEXT,name TEXT,description TEXT,config TEXT);CREATE TABLE users(id TEXT PRIMARY KEY,active INTEGER);CREATE TABLE collections(id TEXT PRIMARY KEY);CREATE TABLE knowledge_chunks(id TEXT,resource_id TEXT,content TEXT,position INTEGER,collection_id TEXT);",
  );
  migrateProviders(db);
  migrateAgentTeams(db);
  db.prepare(
    "INSERT INTO resources VALUES('orders','tool','订单工具','','{}')",
  ).run();
  db.prepare(
    "INSERT INTO resources VALUES('agent','agent','订单客服','指令',?)",
  ).run(
    JSON.stringify({
      toolBindings: [{ resourceId: "orders", name: "lookup" }],
      maxToolRounds: 3,
    }),
  );
  const dir = mkdtempSync(join(tmpdir(), "fc-agent-tools-"));
  const p = createProviders(db, { keyPath: join(dir, "key"), fetcher });
  p.save({
    name: "mock",
    protocol: "openai",
    endpoint: "https://model.example/v1",
    model: "test",
    key: "unit-test-key",
    enabled: true,
    isDefault: true,
    pricing: { currency: "USD" },
  });
  const executed = [];
  const services = {
    discover: async () => ({
      tools: [
        {
          name: "lookup",
          description: "查询订单",
          inputSchema: {
            type: "object",
            properties: { order: { type: "integer" } },
            required: ["order"],
            additionalProperties: false,
          },
        },
      ],
    }),
    call: async (id, name, args) => {
      executed.push({ id, name, args });
      return { status: "shipped" };
    },
  };
  const runner = createAgentRunner({
    db,
    providers: p,
    knowledge: () => [],
    toolServices: services,
  });
  return {
    db,
    p,
    services,
    runner,
    executed,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("OpenAI fragmented tool calls execute bound schema-validated operations and continue with matching results and usage records", async () => {
  let rounds = 0,
    payload;
  const x = setup(async (_url, o) => {
    payload = JSON.parse(o.body);
    if (++rounds === 1) return toolStream(payload.tools[0].function.name);
    assert.equal(payload.messages.at(-1).role, "tool");
    assert.equal(payload.messages.at(-1).tool_call_id, "call_1");
    assert.match(payload.messages.at(-1).content, /shipped/);
    return sse([
      {
        choices: [{ delta: { content: "订单已发货" }, finish_reason: "stop" }],
      },
    ]);
  });
  try {
    const progress = [];
    assert.equal(
      await collect(
        x.runner.stream({
          agentId: "agent",
          messages: [{ role: "user", content: "订单42呢" }],
          onProgress: (e) => progress.push(e),
        }),
      ),
      "订单已发货",
    );
    assert.deepEqual(x.executed, [
      { id: "orders", name: "lookup", args: { order: 42 } },
    ]);
    assert.deepEqual(
      progress.map((e) => e.status),
      ["running", "succeeded"],
    );
    assert.equal(x.db.prepare("SELECT count(*) n FROM ai_usage").get().n, 2);
    const log = x.db.prepare("SELECT * FROM agent_tool_calls").get();
    assert.equal(log.status, "succeeded");
    assert.equal(log.tool_name, "lookup");
    assert.ok(!("arguments" in log));
  } finally {
    x.close();
  }
});
test("Anthropic tool_use JSON deltas normalize correctly and tool_result is returned as user content", async () => {
  let payload, calls;
  const events = [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "c1", name: "lookup", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"order":42}' },
    },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ];
  assert.equal(
    await collect(
      streamCompletion({
        baseUrl: "https://model.example",
        key: "test",
        model: "test",
        protocol: "anthropic",
        messages: [],
        tools: [
          {
            name: "lookup",
            description: "查订单",
            inputSchema: { type: "object" },
          },
        ],
        onToolCalls: (value) => (calls = value),
        fetcher: async (_u, o) => {
          payload = JSON.parse(o.body);
          return new Response(
            events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""),
          );
        },
      }),
    ),
    "",
  );
  assert.equal(payload.tools[0].name, "lookup");
  assert.deepEqual(calls, [
    { id: "c1", name: "lookup", arguments: { order: 42 } },
  ]);
  await collect(
    streamCompletion({
      baseUrl: "https://model.example",
      key: "test",
      model: "test",
      protocol: "anthropic",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              function: { name: "lookup", arguments: '{"order":42}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "done" },
      ],
      fetcher: async (_u, o) => {
        payload = JSON.parse(o.body);
        return new Response(
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',
        );
      },
    }),
  );
  assert.equal(payload.messages[0].content[0].type, "tool_use");
  assert.equal(payload.messages[1].content[0].type, "tool_result");
  assert.equal(payload.messages[1].content[0].tool_use_id, "c1");
});
test("unknown operations, invalid arguments and interrupted tool frames never execute remote actions", async () => {
  for (const variant of ["unknown", "invalid", "truncated"]) {
    const x = setup(async (_u, o) => {
      const p = JSON.parse(o.body);
      if (variant === "truncated")
        return new Response(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "c",
                        function: {
                          name: p.tools[0].function.name,
                          arguments: "{",
                        },
                      },
                    ],
                  },
                },
              ],
            }) +
            "\n\n",
        );
      return toolStream(
        variant === "unknown" ? "unbound" : p.tools[0].function.name,
        variant === "invalid" ? "{}" : '{"order":42}',
      );
    });
    try {
      await assert.rejects(
        collect(x.runner.stream({ agentId: "agent", messages: [] })),
      );
      assert.equal(x.executed.length, 0);
    } finally {
      x.close();
    }
  }
});
test("tool configuration changes and revoked actors are rejected before execution", async () => {
  const x = setup(async (_u, o) => {
    const p = JSON.parse(o.body);
    x.db
      .prepare(
        "UPDATE resources SET config='{" +
          '"changed":true' +
          "}' WHERE id='orders'",
      )
      .run();
    return toolStream(p.tools[0].function.name);
  });
  try {
    await assert.rejects(
      collect(x.runner.stream({ agentId: "agent", messages: [] })),
      /配置已变化/,
    );
    assert.equal(x.executed.length, 0);
    x.db.prepare("INSERT INTO users VALUES('staff',0)").run();
    await assert.rejects(
      collect(
        x.runner.stream({ agentId: "agent", actorId: "staff", messages: [] }),
      ),
      /停用/,
    );
  } finally {
    x.close();
  }
});
test("duplicate call IDs reuse the prior result; loops are bounded and cancelled/failed tools are not retried", async () => {
  let round = 0;
  const x = setup(async (_u, o) => {
    const p = JSON.parse(o.body);
    if (++round < 3) return toolStream(p.tools[0].function.name);
    return sse([
      { choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] },
    ]);
  });
  try {
    assert.equal(
      await collect(x.runner.stream({ agentId: "agent", messages: [] })),
      "完成",
    );
    assert.equal(x.executed.length, 1);
  } finally {
    x.close();
  }
  const y = setup(async (_u, o) =>
    toolStream(
      JSON.parse(o.body).tools[0].function.name,
      '{"order":42}',
      "call_" + ++round,
    ),
  );
  try {
    await assert.rejects(
      collect(y.runner.stream({ agentId: "agent", messages: [] })),
      /轮数/,
    );
    assert.equal(y.executed.length, 2);
  } finally {
    y.close();
  }
  const z = setup(async (_u, o) =>
    toolStream(JSON.parse(o.body).tools[0].function.name),
  );
  const controller = new AbortController();
  z.services.call = async () => {
    controller.abort();
    return { ok: true };
  };
  try {
    await assert.rejects(
      collect(
        z.runner.stream({
          agentId: "agent",
          messages: [],
          signal: controller.signal,
        }),
      ),
      /取消/,
    );
    assert.equal(
      z.db.prepare("SELECT status FROM agent_tool_calls").get().status,
      "cancelled",
    );
  } finally {
    z.close();
  }
});
test("multiple selected knowledge collections exclude unbound content and invalid bindings are rejected", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE resources(id TEXT PRIMARY KEY,kind TEXT,name TEXT,description TEXT,config TEXT);CREATE TABLE knowledge_chunks(id TEXT,resource_id TEXT,content TEXT,position INTEGER,collection_id TEXT);CREATE TABLE collections(id TEXT PRIMARY KEY);INSERT INTO collections VALUES('a'),('b'),('c');",
  );
  for (const id of ["a", "b", "c"]) {
    db.prepare("INSERT INTO resources VALUES(?,'knowledge',?,'','{}')").run(
      id,
      "物流" + id,
    );
    db.prepare("INSERT INTO knowledge_chunks VALUES(?,?,?,0,?)").run(
      id,
      id,
      "物流政策" + id,
      id,
    );
  }
  assert.deepEqual(
    new Set(searchKnowledge(db, "物流", ["a", "b"]).map((r) => r.collectionId)),
    new Set(["a", "b"]),
  );
  assert.throws(() => validateAgentConfig(db, { collectionIds: ["missing"] }));
  assert.throws(() =>
    validateAgentConfig(db, {
      toolBindings: [{ resourceId: "missing", name: "lookup" }],
    }),
  );
  db.close();
});

test("Anthropic accepts device image context as native base64 image blocks", async () => {
  let payload;
  const fetcher = async (url, options) => {
    payload = JSON.parse(options.body);
    return new Response(
      "data: " +
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "已查看" },
        }) +
        "\n\ndata: " +
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        }) +
        "\n\ndata: " +
        JSON.stringify({ type: "message_stop" }) +
        "\n\n",
    );
  };
  const result = await collect(
    streamCompletion({
      protocol: "anthropic",
      baseUrl: "https://model.example/v1",
      key: "test",
      model: "vision",
      fetcher,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "查看截图" },
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,YQ==" },
            },
          ],
        },
      ],
    }),
  );
  assert.equal(result, "已查看");
  assert.deepEqual(payload.messages[0].content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "YQ==" },
  });
});
