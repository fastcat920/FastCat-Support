export function agentKnowledgeScope(config = {}) {
  if (config.knowledgeScope === "none") return null;
  if (config.knowledgeScope === "all") return undefined;
  return config.collectionIds?.length
    ? config.collectionIds
    : config.collectionId;
}
export function agentMessages(messages, config = {}) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => ({ ...m }));
  const instructions = [];
  if (config.profession) instructions.push("职业/角色：" + config.profession);
  if (config.markdown === true)
    instructions.push("使用 Markdown 格式组织回答。");
  if (config.markdown === false)
    instructions.push("使用纯文本回答，不使用 Markdown 格式。");
  if (config.addDatetime)
    instructions.push("当前日期时间（UTC）：" + new Date().toISOString());
  if (instructions.length) {
    if (system.length) system[0].content += "\n" + instructions.join("\n");
    else system.push({ role: "system", content: instructions.join("\n") });
  }
  const rest = messages.filter((m) => m.role !== "system");
  if (config.historyRuns === undefined) return [...system, ...rest];
  let count = 0,
    start = rest.length;
  for (let i = rest.length - 1; i >= 0; i--)
    if (rest[i].role === "user") {
      if (++count > config.historyRuns + 1) break;
      start = i;
    }
  return [...system, ...rest.slice(start)];
}

export function assertAgentRetrySafe(db, id, execution = {}) {
  if (!execution.retries || !id) return;
  const config = JSON.parse(
    db
      .prepare("SELECT config FROM resources WHERE id=? AND kind='agent'")
      .get(id)?.config || "{}",
  );
  if (
    config.toolBindings?.length ||
    config.workflowIds?.length ||
    config.boundDeviceId
  )
    throw Error("含自动操作的智能体节点不允许自动重试");
}
