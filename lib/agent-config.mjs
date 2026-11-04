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

// Only locally stored conversation attachments are forwarded, never arbitrary URLs.
export function agentImageMessages(db, messages, config = {}, context = "") {
  const conversationId = /^(?:automatic|conversation):(.+)$/.exec(context)?.[1];
  return messages.map(({ attachment_id, ...message }) => {
    if (Array.isArray(message.content) && !config.imageRecognition)
      message.content = message.content.filter((b) => b.type === "text");
    if (
      !config.imageRecognition ||
      !conversationId ||
      !attachment_id ||
      message.role !== "user"
    )
      return message;
    const image = db
      .prepare(
        "SELECT mime,data FROM attachments WHERE id=? AND conversation_id=?",
      )
      .get(attachment_id, conversationId);
    if (
      !image ||
      !["image/png", "image/jpeg", "image/webp"].includes(image.mime)
    )
      return message;
    return {
      ...message,
      content: [
        {
          type: "text",
          text:
            typeof message.content === "string"
              ? message.content
              : "用户上传图片",
        },
        {
          type: "image_url",
          image_url: {
            url: `data:${image.mime};base64,${Buffer.from(image.data).toString("base64")}`,
          },
        },
      ],
    };
  });
}

export async function* completeWithFallback(
  providers,
  options,
  config,
  onFallback = () => {},
) {
  const fallback = config.fallbackProviderId && config.fallbackModel;
  if (!fallback) {
    yield* providers.complete(options);
    return;
  }
  // Buffer one model round: a broken stream must not leak half an answer or execute tools twice.
  let tokens = [],
    calls;
  try {
    for await (const token of providers.complete({
      ...options,
      onToolCalls: (value) => {
        calls = value;
      },
    }))
      tokens.push(token);
    if (!tokens.join("").trim() && !calls?.length)
      throw Error("模型未返回内容");
  } catch (error) {
    if (options.signal?.aborted) throw error;
    onFallback();
    tokens = [];
    calls = undefined;
    for await (const token of providers.complete({
      ...options,
      providerId: config.fallbackProviderId,
      model: config.fallbackModel,
      onToolCalls: (value) => {
        calls = value;
      },
    }))
      tokens.push(token);
    if (!tokens.join("").trim() && !calls?.length)
      throw Error("备用模型未返回内容");
  }
  if (calls) await options.onToolCalls?.(calls);
  yield* tokens;
}
