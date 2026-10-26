import { test } from "node:test";
import assert from "node:assert/strict";
import { retrieveKnowledge, streamCompletion } from "../lib/ai.mjs";
test("knowledge ranks Chinese and English terms and handles empty input", () => {
  const rows = [
    { id: "a", name: "配送物流", description: "查看订单物流信息" },
    { id: "b", name: "退款政策", description: "申请退货退款" },
    { id: "c", name: "billing", description: "invoice details" },
  ];
  assert.equal(retrieveKnowledge(rows, "物流")[0].id, "a");
  assert.equal(retrieveKnowledge(rows, "invoice")[0].id, "c");
  assert.equal(retrieveKnowledge(rows, "").length, 0);
});
test("completion adapter parses split UTF-8 SSE chunks and preserves model", async () => {
  let payload;
  const fetcher = async (url, opts) => {
    payload = JSON.parse(opts.body);
    assert.equal(String(url), "https://example.test/v1/chat/completions");
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":"，世界"}}]}\n\ndata: [DONE]\n\n',
    );
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += 7)
            c.enqueue(bytes.slice(i, i + 7));
          c.close();
        },
      }),
    );
  };
  let output = "";
  for await (const text of streamCompletion({
    baseUrl: "https://example.test/v1",
    key: "test",
    model: "my-model",
    messages: [{ role: "user", content: "hi" }],
    fetcher,
  }))
    output += text;
  assert.equal(output, "你好，世界");
  assert.equal(payload.model, "my-model");
  assert.equal(payload.stream, true);
});
test("adapter rejects missing credentials and interrupted responses", async () => {
  await assert.rejects(async () => {
    for await (const x of streamCompletion({})) {
    }
  }, /AI_BASE_URL/);
  await assert.rejects(async () => {
    for await (const x of streamCompletion({
      baseUrl: "https://example.test/v1",
      key: "test",
      model: "test",
      messages: [],
      fetcher: async () =>
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
    })) {
    }
  }, /未完成/);
});
