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
