export function layoutFlow(definition, reset = false) {
  const byId = new Map(definition.nodes.map((n) => [n.id, n])),
    depth = new Map(),
    visiting = new Set();
  function level(id) {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = definition.edges.filter(
      (e) => e.target === id && byId.has(e.source),
    );
    const d = parents.length
      ? Math.min(20, 1 + Math.max(...parents.map((e) => level(e.source))))
      : 0;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  }
  const lanes = new Map();
  for (const node of definition.nodes) {
    const d = level(node.id),
      lane = lanes.get(d) || 0;
    lanes.set(d, lane + 1);
    if (
      reset ||
      !node.position ||
      !Number.isFinite(node.position.x) ||
      !Number.isFinite(node.position.y)
    )
      node.position = { x: 35 + d * 225, y: 35 + lane * 120 };
    node.position = {
      x: Math.max(12, Math.min(10000, node.position.x)),
      y: Math.max(12, Math.min(10000, node.position.y)),
    };
  }
  return new Map(definition.nodes.map((n) => [n.id, n.position]));
}
export function flowHistory(initial, limit = 100) {
  let past = [],
    future = [],
    current = JSON.stringify(initial);
  return {
    record(value) {
      const next = JSON.stringify(value);
      if (next === current) return;
      past.push(current);
      if (past.length > limit) past.shift();
      current = next;
      future = [];
    },
    undo() {
      if (!past.length) return null;
      future.push(current);
      current = past.pop();
      return JSON.parse(current);
    },
    redo() {
      if (!future.length) return null;
      past.push(current);
      current = future.pop();
      return JSON.parse(current);
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
  };
}
export function duplicateNode(definition, id) {
  const old = definition.nodes.find((n) => n.id === id);
  if (!old || old.type === "start") throw Error("开始节点不能复制");
  if (definition.nodes.length >= 50) throw Error("最多 50 个节点");
  const copy = structuredClone(old);
  copy.id =
    old.type + "_" + crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  copy.name = (old.name || old.type) + " 副本";
  copy.position = {
    x: Math.min(10000, (old.position?.x || 35) + 40),
    y: Math.min(10000, (old.position?.y || 35) + 90),
  };
  definition.nodes.push(copy);
  return copy.id;
}
export function connectNodes(definition, source, target, branch = "") {
  const a = definition.nodes.find((n) => n.id === source),
    b = definition.nodes.find((n) => n.id === target);
  if (
    !a ||
    !b ||
    source === target ||
    a.type === "output" ||
    b.type === "start"
  )
    throw Error("不能连接这些节点");
  if (definition.edges.length >= 150) throw Error("最多 150 条连接");
  if (definition.edges.some((e) => e.source === source && e.target === target))
    throw Error("连接已存在");
  const seen = new Set();
  function reaches(id) {
    if (id === source) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return definition.edges
      .filter((e) => e.source === id)
      .some((e) => reaches(e.target));
  }
  if (reaches(target)) throw Error("连接会形成循环");
  if (a.type === "condition") {
    if (!["true", "false"].includes(branch)) throw Error("请选择条件分支");
    if (
      definition.edges.some((e) => e.source === source && e.branch === branch)
    )
      throw Error("该条件分支已有连接");
  }
  definition.edges.push({
    source,
    target,
    ...(a.type === "condition" ? { branch } : {}),
  });
}
