import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateWorkflow,
  executeWorkflow,
  interpolate,
} from "../lib/workflow.mjs";
const branch = {
  nodes: [
    { id: "start", type: "start" },
    {
      id: "choice",
      type: "condition",
      config: { left: "{{input}}", operator: "contains", right: "退款" },
    },
    { id: "refund", type: "text", config: { text: "请提供订单号" } },
    { id: "other", type: "text", config: { text: "人工客服将协助您" } },
    { id: "answer", type: "output", config: { value: "{{nodes.refund}}" } },
    { id: "fallback", type: "output", config: { value: "{{nodes.other}}" } },
  ],
  edges: [
    { source: "start", target: "choice" },
    { source: "choice", target: "refund", branch: "true" },
    { source: "choice", target: "other", branch: "false" },
    { source: "refund", target: "answer" },
    { source: "other", target: "fallback" },
  ],
};
test("DAG validates, branches, skips inactive paths and preserves typed variables", async () => {
  assert.equal(validateWorkflow(branch).order.length, 6);
  let result = await executeWorkflow(branch, "我要退款");
  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "请提供订单号");
  assert.equal(
    result.steps.find((s) => s.nodeId === "other").status,
    "skipped",
  );
  result = await executeWorkflow(branch, "订单物流");
  assert.equal(result.output, "人工客服将协助您");
  assert.deepEqual(
    interpolate(
      { data: "{{input}}", text: "问题：{{input.question}}" },
      { input: { question: "配送" } },
    ),
    { data: { question: "配送" }, text: "问题：配送" },
  );
});
test("DAG rejects cycles, invalid IDs, disconnected paths and invalid branches", () => {
  assert.throws(
    () =>
      validateWorkflow({
        ...branch,
        edges: [...branch.edges, { source: "refund", target: "choice" }],
      }),
    /循环/,
  );
  assert.throws(
    () =>
      validateWorkflow({
        nodes: [
          { id: "start", type: "start" },
          { id: "constructor", type: "output" },
        ],
        edges: [],
      }),
    /ID/,
  );
  assert.throws(
    () =>
      validateWorkflow({
        ...branch,
        edges: branch.edges.filter((e) => e.target !== "other"),
      }),
    /分支/,
  );
  assert.throws(
    () => interpolate("{{input.__proto__}}", { input: {} }),
    /无效/,
  );
});
test("workflow runs real services in order and records a failed node", async () => {
  const def = {
    nodes: [
      { id: "start", type: "start" },
      { id: "search", type: "knowledge", config: { query: "{{input}}" } },
      { id: "reply", type: "llm", config: { prompt: "参考 {{nodes.search}}" } },
      { id: "finish", type: "output", config: { value: "{{nodes.reply}}" } },
    ],
    edges: [
      { source: "start", target: "search" },
      { source: "search", target: "reply" },
      { source: "reply", target: "finish" },
    ],
  };
  const seen = [];
  const result = await executeWorkflow(
    def,
    "配送",
    {
      knowledge: async (q) => {
        assert.equal(q, "配送");
        return [{ text: "三天内送达" }];
      },
      llm: async (p) => {
        assert.ok(p.includes("三天"));
        return "预计三天送达";
      },
    },
    (s) => seen.push(s.status),
  );
  assert.equal(result.output, "预计三天送达");
  assert.equal(seen.filter((s) => s === "succeeded").length, 4);
  const failed = await executeWorkflow(def, "配送", {
    knowledge: async () => {
      throw Error("检索不可用");
    },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.steps.at(-1).nodeId, "search");
  assert.equal(failed.error, "检索不可用");
});

test("knowledge/model retry is bounded, records attempts, and cancellation interrupts the retry delay", async () => {
  const definition = {
    nodes: [
      { id: "s", type: "start" },
      { id: "k", type: "knowledge", retry: { retries: 2, delayMs: 1 } },
      { id: "o", type: "output", config: { value: "{{nodes.k}}" } },
    ],
    edges: [
      { source: "s", target: "k" },
      { source: "k", target: "o" },
    ],
  };
  let count = 0;
  let r = await executeWorkflow(definition, "query", {
    knowledge: async () => {
      if (++count === 1) throw Error("transient");
      return "found";
    },
  });
  assert.equal(r.status, "succeeded");
  assert.equal(r.output, "found");
  assert.equal(r.steps[1].attempt, 2);
  count = 0;
  r = await executeWorkflow(definition, "query", {
    knowledge: async () => {
      count++;
      throw Error("down");
    },
  });
  assert.equal(r.status, "failed");
  assert.equal(count, 3);
  assert.equal(r.output, null);
  const controller = new AbortController();
  definition.nodes[1].retry.delayMs = 5000;
  count = 0;
  r = await executeWorkflow(
    definition,
    "query",
    {
      knowledge: async () => {
        count++;
        setTimeout(() => controller.abort(), 10);
        throw Error("down");
      },
    },
    () => {},
    controller.signal,
  );
  assert.equal(r.status, "cancelled");
  assert.equal(count, 1);
  definition.nodes[1].type = "tool";
  assert.throws(() => validateWorkflow(definition), /仅知识/);
});
