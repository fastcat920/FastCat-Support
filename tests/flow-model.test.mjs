import { test } from "node:test";
import assert from "node:assert/strict";
import {
  layoutFlow,
  flowHistory,
  duplicateNode,
  connectNodes,
} from "../public/flow-model.js";
const graph = () => ({
  nodes: [
    { id: "s", type: "start" },
    { id: "t", type: "text", config: { text: "{{input}}" } },
    { id: "o", type: "output" },
  ],
  edges: [
    { source: "s", target: "t" },
    { source: "t", target: "o" },
  ],
});
test("canvas layout persists manual positions and handles invalid cyclic drafts without recursion", () => {
  const g = graph();
  layoutFlow(g);
  g.nodes[1].position = { x: 450, y: 200 };
  layoutFlow(g);
  assert.deepEqual(g.nodes[1].position, { x: 450, y: 200 });
  layoutFlow(g, true);
  assert.notEqual(g.nodes[1].position.y, 200);
  g.edges.push({ source: "o", target: "s" });
  assert.doesNotThrow(() => layoutFlow(g, true));
});
test("canvas history restores structural changes and discards redo after new edits", () => {
  const g = graph(),
    h = flowHistory(g);
  g.nodes.pop();
  h.record(g);
  assert.equal(h.undo().nodes.length, 3);
  assert.equal(h.redo().nodes.length, 2);
  h.undo();
  g.nodes = [];
  h.record(g);
  assert.equal(h.canRedo, false);
});
test("copy preserves node configuration without duplicating start or connections; ports reject cycles", () => {
  const g = graph();
  layoutFlow(g);
  const id = duplicateNode(g, "t");
  assert.notEqual(id, "t");
  assert.deepEqual(g.nodes.at(-1).config, g.nodes[1].config);
  g.nodes.at(-1).config.text = "changed";
  assert.notEqual(g.nodes[1].config.text, "changed");
  assert.equal(g.edges.length, 2);
  assert.throws(() => duplicateNode(g, "s"), /开始/);
  assert.throws(() => connectNodes(g, "t", "s"), /不能/);
  assert.throws(() => connectNodes(g, "t", "o"), /已存在/);
  connectNodes(g, "s", id);
  assert.throws(() => connectNodes(g, id, "s"), /不能/);
  g.nodes.push({ id: "x", type: "text" });
  connectNodes(g, id, "x");
  assert.throws(() => connectNodes(g, "x", id), /循环/);
});
