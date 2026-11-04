import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { agentMessages, agentKnowledgeScope } from "../lib/agent-config.mjs";
import {
  validateAgentConfig,
  migrateAgentTeams,
  createAgentRunner,
} from "../lib/agent-teams.mjs";
import { migrateFeatures, searchKnowledge } from "../lib/features.mjs";
import { createAgentWorkflows } from "../lib/agent-workflows.mjs";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE resources(id TEXT PRIMARY KEY,kind TEXT,name TEXT,description TEXT,config TEXT,created TEXT);CREATE TABLE users(id TEXT PRIMARY KEY,active INTEGER);",
  );
  migrateFeatures(db);
  migrateAgentTeams(db);
  return db;
}
test("agent history trims complete previous turns and output/date/role settings enter system context", () => {
  const messages = [
    { role: "system", content: "base" },
    { role: "user", content: "old" },
    { role: "assistant", content: "old-answer" },
    { role: "user", content: "current" },
  ];
  const r = agentMessages(messages, {
    profession: "售后专员",
    markdown: false,
    addDatetime: true,
    historyRuns: 0,
  });
  assert.equal(r.length, 2);
  assert.equal(r[1].content, "current");
  assert.match(r[0].content, /售后专员/);
  assert.match(r[0].content, /纯文本/);
  assert.match(r[0].content, /当前日期时间/);
  assert.equal(agentMessages(messages, { historyRuns: 1 }).length, 4);
  assert.equal(messages[0].content, "base");
});
test("new explicit no-knowledge scope cannot fall through to all knowledge while legacy selection remains", () => {
  const db = setup();
  try {
    assert.equal(agentKnowledgeScope({ knowledgeScope: "none" }), null);
    assert.deepEqual(
      searchKnowledge(
        db,
        "anything",
        agentKnowledgeScope({ knowledgeScope: "none" }),
      ),
      [],
    );
    assert.equal(agentKnowledgeScope({}), undefined);
    assert.deepEqual(agentKnowledgeScope({ collectionIds: ["default"] }), [
      "default",
    ]);
    assert.throws(
      () =>
        validateAgentConfig(db, {
          knowledgeScope: "selected",
          collectionIds: [],
        }),
      /至少选择/,
    );
    for (const c of [
      { historyRuns: 21 },
      { toolCallLimit: 0 },
      { profession: "" },
      { markdown: "true" },
      { workflowIds: ["missing"] },
    ])
      assert.throws(() => validateAgentConfig(db, c));
  } finally {
    db.close();
  }
});
function publish(db, definition) {
  const config = { definition };
  db.prepare(
    "INSERT INTO resources VALUES('workflow','workflow','已发布流程','工作流说明',?,'now')",
  ).run(JSON.stringify(config));
  db.prepare("INSERT INTO workflow_state VALUES('workflow',0,1)").run();
  db.prepare(
    "INSERT INTO workflow_versions VALUES('workflow',1,?,'','admin','now')",
  ).run(JSON.stringify({ id: "workflow", name: "已发布流程", config }));
}
test("agent actively calls only its bound published workflow, returns results to model and persists run/version", async () => {
  const db = setup();
  try {
    publish(db, {
      nodes: [
        { id: "s", type: "start" },
        { id: "out", type: "output", config: { value: "{{input}}" } },
      ],
      edges: [{ source: "s", target: "out" }],
    });
    db.prepare(
      "INSERT INTO resources VALUES('a','agent','客服','服务指令',?,'now')",
    ).run(
      JSON.stringify({
        workflowIds: ["workflow"],
        profession: "售后",
        historyRuns: 0,
      }),
    );
    let calls = 0,
      runner;
    const providers = {
      async *complete(o) {
        if (calls++ === 0) {
          assert.match(o.messages[0].content, /服务指令/);
          assert.equal(o.tools.length, 1);
          o.onToolCalls([
            {
              id: "call",
              name: o.tools[0].name,
              arguments: { input: "order-42" },
            },
          ]);
        } else {
          const result = JSON.parse(o.messages.at(-1).content);
          assert.equal(result.output, "order-42");
          assert.equal(result.version, 1);
          yield "查询完成";
        }
      },
    };
    const workflows = createAgentWorkflows({
      db,
      knowledge: () => [],
      tools: {},
      complete: (o) => runner.stream(o),
    });
    runner = createAgentRunner({
      db,
      providers,
      knowledge: () => [],
      workflowServices: workflows,
    });
    let answer = "";
    for await (const part of runner.stream({
      agentId: "a",
      messages: [{ role: "user", content: "查询订单" }],
    }))
      answer += part;
    assert.equal(answer, "查询完成");
    assert.equal(
      db.prepare("SELECT status FROM workflow_runs").get().status,
      "succeeded",
    );
    assert.equal(
      db.prepare("SELECT version FROM workflow_run_versions").get().version,
      1,
    );
    assert.equal(
      db.prepare("SELECT status FROM agent_tool_calls").get().status,
      "succeeded",
    );
    await assert.rejects(
      workflows.run("workflow", "x", { stack: ["workflow"] }),
      /循环/,
    );
  } finally {
    db.close();
  }
});
test("workflow calls reject unpublished versions and cancellation before any side effect", async () => {
  const db = setup();
  try {
    db.prepare(
      "INSERT INTO resources VALUES('draft','workflow','草稿','','{}','now')",
    ).run();
    const workflows = createAgentWorkflows({
      db,
      knowledge: () => [],
      tools: {},
      complete: () => {},
    });
    await assert.rejects(workflows.run("draft", "x"), /先发布/);
    const c = new AbortController();
    c.abort();
    await assert.rejects(workflows.run("draft", "x", { signal: c.signal }));
    assert.equal(db.prepare("SELECT count(*) n FROM workflow_runs").get().n, 0);
  } finally {
    db.close();
  }
});

test("fallback discards a broken partial response, preserves tool calls, and never retries cancellation", async () => {
  const { completeWithFallback } = await import("../lib/agent-config.mjs");
  let attempts = [],
    calls;
  const providers = {
    async *complete(o) {
      attempts.push(o.model);
      if (o.model === "primary") {
        yield "broken";
        throw Error("network");
      }
      o.onToolCalls([{ id: "ok" }]);
      yield "backup";
    },
  };
  const config = { fallbackProviderId: "b", fallbackModel: "backup" };
  let result = "";
  for await (const token of completeWithFallback(
    providers,
    { model: "primary", onToolCalls: (v) => (calls = v) },
    config,
  ))
    result += token;
  assert.equal(result, "backup");
  assert.deepEqual(attempts, ["primary", "backup"]);
  assert.equal(calls[0].id, "ok");
  attempts = [];
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => {
    for await (const token of completeWithFallback(
      providers,
      { model: "primary", signal: controller.signal },
      config,
    )) {
    }
  });
  assert.deepEqual(attempts, ["primary"]);
});

test("image recognition only forwards stored images in the authorized conversation when enabled", async () => {
  const { agentImageMessages } = await import("../lib/agent-config.mjs");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE attachments(id TEXT,conversation_id TEXT,mime TEXT,data BLOB)",
  );
  db.prepare("INSERT INTO attachments VALUES(?,?,?,?)").run(
    "image",
    "c",
    "image/png",
    Buffer.from("image"),
  );
  const messages = [{ role: "user", content: "photo", attachment_id: "image" }];
  assert.equal(
    agentImageMessages(db, messages, {}, "conversation:c")[0].content,
    "photo",
  );
  assert.equal(
    agentImageMessages(
      db,
      messages,
      { imageRecognition: true },
      "conversation:other",
    )[0].content,
    "photo",
  );
  const content = agentImageMessages(
    db,
    messages,
    { imageRecognition: true },
    "automatic:c",
  )[0].content;
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(messages[0].attachment_id, "image");
  db.close();
});

test("conversation AI can request consent-based diagnostics and reads existing reports as data", async () => {
  const db = setup();
  let requested = 0,
    rounds = 0;
  try {
    const runner = createAgentRunner({
      db,
      knowledge: () => [],
      assistance: {
        state: () => ({
          device: { online: true, capabilities: ["basic"] },
          requests: [
            {
              status: "succeeded",
              capability: "basic",
              finished: 1000,
              report: { summary: "known diagnostic" },
            },
          ],
        }),
        request: (id, capability) => {
          assert.equal(id, "c");
          assert.equal(capability, "basic");
          requested++;
          return { id: "r", status: "pending" };
        },
      },
      providers: {
        async *complete(o) {
          assert.ok(
            o.messages.some(
              (m) =>
                typeof m.content === "string" &&
                m.content.includes("known diagnostic"),
            ),
          );
          if (rounds++ === 0) {
            assert.ok(o.tools.some((t) => t.name === "request_diagnostics"));
            o.onToolCalls([
              {
                id: "diagnostic-call",
                name: "request_diagnostics",
                arguments: { capability: "basic", reason: "need version" },
              },
            ]);
          } else {
            assert.equal(
              JSON.parse(o.messages.at(-1).content).authorization,
              "per_request",
            );
            yield "请确认诊断卡片";
          }
        },
      },
    });
    let text = "";
    for await (const part of runner.stream({
      context: "conversation:c",
      messages: [{ role: "user", content: "help" }],
    }))
      text += part;
    assert.equal(requested, 1);
    assert.equal(text, "请确认诊断卡片");
  } finally {
    db.close();
  }
});

test("automatic and staff conversation replies use fresh profile context while standalone debug stays isolated", async () => {
  const db = setup();
  const seen = [];
  try {
    const runner = createAgentRunner({
      db,
      knowledge: () => [],
      visitorContext: (context) =>
        context === "debug" ? null : "PROFILE:macos:3.6.2",
      providers: {
        async *complete(o) {
          seen.push(o.messages);
          yield "answer";
        },
      },
    });
    for (const context of ["automatic:c", "conversation:c", "debug"])
      for await (const token of runner.stream({
        context,
        messages: [{ role: "user", content: "help" }],
      })) {
      }
    assert.equal(seen.length, 3);
    for (const messages of seen.slice(0, 2))
      assert.ok(
        messages.some(
          (m) =>
            m.role === "system" && m.content.includes("PROFILE:macos:3.6.2"),
        ),
      );
    assert.ok(seen[2].every((m) => !String(m.content).includes("PROFILE:")));
  } finally {
    db.close();
  }
});

test("AI repair tools only create a user-confirmation request and are absent for legacy clients", async () => {
  const db = setup();
  let requested = 0,
    round = 0;
  let enabled = true;
  try {
    const runner = createAgentRunner({
      db,
      knowledge: () => [],
      assistance: {
        state: () => ({
          device: {
            online: true,
            capabilities: [],
            repairCapabilities: enabled ? ["reconnect"] : [],
          },
          requests: [],
          repairs: [],
        }),
        requestRepair: (conversation, operation) => {
          assert.equal(conversation, "c");
          assert.equal(operation, "reconnect");
          requested++;
          return { id: "repair", status: "pending" };
        },
      },
      providers: {
        async *complete(o) {
          if (!enabled) {
            assert.ok(!o.tools.some((t) => t.name === "request_repair"));
            yield "manual advice";
            return;
          }
          if (round++ === 0) {
            assert.ok(o.tools.some((t) => t.name === "request_repair"));
            o.onToolCalls([
              {
                id: "repair-call",
                name: "request_repair",
                arguments: {
                  operation: "reconnect",
                  reason: "connection check",
                },
              },
            ]);
          } else {
            assert.equal(
              JSON.parse(o.messages.at(-1).content).authorization,
              "per_request",
            );
            yield "请确认修复请求";
          }
        },
      },
    });
    for await (const token of runner.stream({
      context: "automatic:c",
      messages: [{ role: "user", content: "help" }],
    })) {
    }
    assert.equal(requested, 1);
    enabled = false;
    for await (const token of runner.stream({
      context: "automatic:c",
      messages: [{ role: "user", content: "help" }],
    })) {
    }
    assert.equal(requested, 1);
  } finally {
    db.close();
  }
});

test("AI sees active authorization explicitly and is told not to ask for consent again", async () => {
  const db = setup();
  let round = 0;
  try {
    const runner = createAgentRunner({
      db,
      knowledge: () => [],
      assistance: {
        state: () => ({
          device: {
            online: true,
            consentRequired: true,
            capabilities: [],
            repairCapabilities: ["reconnect"],
          },
          consents: {
            query: null,
            operation: {
              capabilities: ["reconnect"],
              routes: [],
              expires: Date.now() + 1800000,
            },
          },
          requests: [],
          repairs: [],
        }),
        requestRepair: () => ({ id: "r", status: "pending" }),
      },
      providers: {
        async *complete(o) {
          if (round++ === 0)
            o.onToolCalls([
              {
                id: "call",
                name: "request_repair",
                arguments: { operation: "reconnect", reason: "check" },
              },
            ]);
          else {
            const result = JSON.parse(o.messages.at(-1).content);
            assert.equal(result.authorization, "active");
            assert.match(result.message, /无需再次点击同意/);
            yield "正在重新连接，请稍候。";
          }
        },
      },
    });
    for await (const token of runner.stream({
      context: "automatic:c",
      messages: [{ role: "user", content: "help" }],
    })) {
    }
  } finally {
    db.close();
  }
});
