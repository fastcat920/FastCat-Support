import { setTimeout as wait } from "node:timers/promises";
const TYPES = new Set([
  "start",
  "text",
  "knowledge",
  "condition",
  "llm",
  "tool",
  "output",
]);
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
export function lookup(scope, path) {
  const parts = String(path).trim().split(".");
  if (parts.some((p) => unsafe.has(p))) throw Error("变量路径无效");
  return parts.reduce(
    (value, key) =>
      value != null && Object.hasOwn(Object(value), key)
        ? value[key]
        : undefined,
    scope,
  );
}
export function interpolate(value, scope) {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (exact) {
      const result = lookup(scope, exact[1]);
      if (result === undefined) throw Error("变量不存在：" + exact[1]);
      return structuredClone(result);
    }
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path) => {
      const v = lookup(scope, path);
      if (v === undefined) throw Error("变量不存在：" + path);
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope));
  if (value && typeof value === "object") {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      if (unsafe.has(k)) throw Error("参数字段无效");
      result[k] = interpolate(v, scope);
    }
    return result;
  }
  return value;
}
export function validateWorkflow(definition) {
  const { nodes, edges } = definition || {};
  if (
    !Array.isArray(nodes) ||
    !Array.isArray(edges) ||
    !nodes.length ||
    nodes.length > 50 ||
    edges.length > 150
  )
    throw Error("工作流需要 1–50 个节点和不超过 150 条连接");
  const ids = new Set();
  for (const node of nodes) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(node.id) ||
      unsafe.has(node.id) ||
      ids.has(node.id)
    )
      throw Error("节点 ID 无效或重复");
    if (
      node.position &&
      (!Number.isFinite(node.position.x) ||
        !Number.isFinite(node.position.y) ||
        node.position.x < 0 ||
        node.position.y < 0 ||
        node.position.x > 10000 ||
        node.position.y > 10000)
    )
      throw Error("节点位置须在 0–10000 范围内");
    if (node.retry !== undefined) {
      const r = node.retry;
      if (
        !["knowledge", "llm"].includes(node.type) ||
        !r ||
        !Number.isInteger(r.retries) ||
        r.retries < 0 ||
        r.retries > 3 ||
        !Number.isInteger(r.delayMs) ||
        r.delayMs < 0 ||
        r.delayMs > 5000
      )
        throw Error("仅知识/模型节点支持重试：次数 0–3，间隔 0–5000 ms");
    }
    ids.add(node.id);
    if (!TYPES.has(node.type)) throw Error("未知节点类型：" + node.type);
    if (
      node.config !== undefined &&
      (!node.config ||
        typeof node.config !== "object" ||
        Array.isArray(node.config))
    )
      throw Error("节点配置必须是对象");
  }
  const starts = nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) throw Error("工作流必须且只能有一个开始节点");
  if (!nodes.some((n) => n.type === "output"))
    throw Error("至少需要一个输出节点");
  const incoming = new Map(nodes.map((n) => [n.id, []])),
    outgoing = new Map(nodes.map((n) => [n.id, []])),
    pairs = new Set();
  for (const edge of edges) {
    if (
      !ids.has(edge.source) ||
      !ids.has(edge.target) ||
      edge.source === edge.target
    )
      throw Error("连接指向无效节点");
    const key = edge.source + ">" + edge.target;
    if (pairs.has(key)) throw Error("不能重复连接相同节点");
    pairs.add(key);
    incoming.get(edge.target).push(edge);
    outgoing.get(edge.source).push(edge);
  }
  if (incoming.get(starts[0].id).length) throw Error("开始节点不能有前置节点");
  for (const node of nodes) {
    const outs = outgoing.get(node.id);
    if (node.type === "output" && outs.length)
      throw Error("输出节点不能有后续连接");
    if (node.type !== "output" && !outs.length)
      throw Error("非输出节点必须连接后续节点");
    if (
      node.type === "condition" &&
      (outs.length !== 2 ||
        !outs.some((e) => e.branch === "true") ||
        !outs.some((e) => e.branch === "false"))
    )
      throw Error("条件节点需要 true 和 false 两个分支");
    if (node.type !== "condition" && outs.some((e) => e.branch))
      throw Error("只有条件节点可以设置分支");
  }
  const degree = new Map(nodes.map((n) => [n.id, incoming.get(n.id).length])),
    queue = nodes.filter((n) => degree.get(n.id) === 0).map((n) => n.id),
    order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const e of outgoing.get(id)) {
      degree.set(e.target, degree.get(e.target) - 1);
      if (degree.get(e.target) === 0) queue.push(e.target);
    }
  }
  if (order.length !== nodes.length) throw Error("工作流不能包含循环");
  const reached = new Set([starts[0].id]);
  for (const id of order)
    if (reached.has(id))
      for (const e of outgoing.get(id)) reached.add(e.target);
  if (reached.size !== nodes.length) throw Error("存在未连接到开始节点的节点");
  return { nodes, edges, order, incoming, outgoing };
}
export async function executeWorkflow(
  definition,
  input,
  services = {},
  onStep = () => {},
  signal,
) {
  const graph = validateWorkflow(definition),
    scope = { input, nodes: Object.create(null) },
    steps = [],
    activeEdges = new Set();
  let output = null;
  for (const id of graph.order) {
    const node = graph.nodes.find((n) => n.id === id),
      started = Date.now();
    const enabled =
      node.type === "start" ||
      graph.incoming.get(id).some((e) => activeEdges.has(e));
    if (!enabled) {
      const step = {
        nodeId: id,
        name: node.name || id,
        type: node.type,
        status: "skipped",
        durationMs: 0,
      };
      steps.push(step);
      await onStep(step);
      continue;
    }
    const step = {
      nodeId: id,
      name: node.name || id,
      type: node.type,
      status: "running",
      started: new Date().toISOString(),
    };
    steps.push(step);
    await onStep({ ...step });
    try {
      if (signal?.aborted) throw Error("运行已取消");
      const config = interpolate(node.config || {}, scope);
      const invoke = async (operation) => {
        const retries = node.retry?.retries || 0;
        for (let attempt = 1; attempt <= retries + 1; attempt++) {
          if (signal?.aborted) throw Error("运行已取消");
          step.attempt = attempt;
          await onStep({ ...step });
          try {
            const result = await operation();
            if (signal?.aborted) throw Error("运行已取消");
            return result;
          } catch (error) {
            if (signal?.aborted || attempt > retries) throw error;
            step.lastError = error.message;
            await onStep({ ...step });
            if (node.retry.delayMs)
              await wait(node.retry.delayMs, undefined, { signal });
          }
        }
      };
      let value;
      if (node.type === "start") value = input;
      if (node.type === "text") value = config.text ?? "";
      if (node.type === "knowledge") {
        if (!services.knowledge) throw Error("知识检索服务未配置");
        value = await invoke(() =>
          services.knowledge(
            String(config.query ?? input),
            config.collectionId,
          ),
        );
      }
      if (node.type === "llm") {
        if (!services.llm) throw Error("模型服务未配置");
        value = await invoke(() =>
          services.llm(String(config.prompt ?? input), config.agentId, signal, {
            retries: node.retry?.retries || 0,
          }),
        );
      }
      if (node.type === "tool") {
        if (!services.tool) throw Error("工具服务未配置");
        if (!config.resourceId || !config.name)
          throw Error("工具节点缺少服务或工具名称");
        value = await services.tool(
          config.resourceId,
          config.name,
          config.arguments || {},
        );
      }
      if (node.type === "condition") {
        const left = config.left ?? input,
          right = config.right;
        switch (config.operator || "contains") {
          case "contains":
            value = String(left).includes(String(right));
            break;
          case "equals":
            value = JSON.stringify(left) === JSON.stringify(right);
            break;
          case "not_empty":
            value =
              left !== null && left !== undefined && String(left).length > 0;
            break;
          case "greater_than":
            if (
              !Number.isFinite(Number(left)) ||
              !Number.isFinite(Number(right))
            )
              throw Error("比较值必须是数字");
            value = Number(left) > Number(right);
            break;
          default:
            throw Error("未知条件操作符");
        }
      }
      if (node.type === "output") {
        value = config.value ?? input;
        output = value;
      }
      scope.nodes[id] = value;
      Object.assign(step, {
        status: "succeeded",
        output: value,
        durationMs: Date.now() - started,
      });
      await onStep({ ...step });
      for (const edge of graph.outgoing.get(id))
        if (node.type !== "condition" || edge.branch === String(value))
          activeEdges.add(edge);
    } catch (error) {
      Object.assign(step, {
        status: "failed",
        error: error.message,
        durationMs: Date.now() - started,
      });
      await onStep({ ...step });
      return {
        status: signal?.aborted ? "cancelled" : "failed",
        output: null,
        error: error.message,
        steps,
      };
    }
  }
  return { status: "succeeded", output, steps };
}
