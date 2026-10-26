import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { randomId } from "../public/ids.js";
import { duplicateNode } from "../public/flow-model.js";
test("HTTP-compatible identifiers retain UUID version, randomness and native support", () => {
  const httpCrypto = {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  };
  const ids = Array.from({ length: 1000 }, () => randomId(httpCrypto));
  assert.equal(new Set(ids).size, 1000);
  for (const id of ids)
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  assert.equal(randomId({ randomUUID: () => "native-id" }), "native-id");
  assert.throws(() => randomId({}), /安全随机数/);
});

test("workflow copy works when browser crypto lacks randomUUID", () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
  });
  try {
    const graph = {
      nodes: [{ id: "reply", type: "text", config: { text: "hello" } }],
    };
    const id = duplicateNode(graph, "reply");
    assert.notEqual(id, "reply");
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.nodes[1].config.text, "hello");
  } finally {
    Object.defineProperty(globalThis, "crypto", prior);
  }
});
