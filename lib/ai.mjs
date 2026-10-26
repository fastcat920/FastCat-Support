export function retrieveKnowledge(rows, query, limit = 5) {
  const text = String(query).toLowerCase(),
    terms = [...new Set(text.match(/[a-z0-9]+|[\p{Script=Han}]/gu) || [])];
  return rows
    .map((row) => {
      const corpus = (row.name + " " + row.description).toLowerCase();
      const score = terms.reduce((n, t) => n + (corpus.includes(t) ? 1 : 0), 0);
      return { ...row, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
export async function* streamCompletion({
  baseUrl,
  key,
  model,
  messages,
  signal,
  fetcher = fetch,
  protocol = "openai",
  maxTokens = 2048,
  includeUsage = true,
  onUsage = () => {},
  tools = [],
  onToolCalls = () => {},
}) {
  if (!baseUrl || !key || !model)
    throw Error("请在服务器配置 AI_BASE_URL、AI_API_KEY 和 AI_MODEL");
  const anthropic = protocol === "anthropic";
  if (!["openai", "anthropic"].includes(protocol))
    throw Error("不支持的模型协议");
  const url = new URL(
    baseUrl.replace(/\/$/, "") +
      (anthropic ? "/messages" : "/chat/completions"),
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("模型接口地址无效");
  const system = messages
    .filter((m) => ["system", "developer"].includes(m.role))
    .map((m) => m.content)
    .join("\n");
  const converted = [];
  if (anthropic)
    for (const m of messages.filter(
      (m) => !["system", "developer"].includes(m.role),
    )) {
      if (m.role === "tool") {
        const block = {
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: m.content,
        };
        if (
          converted.at(-1)?.role === "user" &&
          Array.isArray(converted.at(-1).content)
        )
          converted.at(-1).content.push(block);
        else converted.push({ role: "user", content: [block] });
      } else if (m.tool_calls) {
        converted.push({
          role: "assistant",
          content: [
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...m.tool_calls.map((c) => ({
              type: "tool_use",
              id: c.id,
              name: c.function.name,
              input: JSON.parse(c.function.arguments),
            })),
          ],
        });
      } else if (Array.isArray(m.content))
        converted.push({
          ...m,
          content: m.content.map((block) => {
            if (block.type === "image_url") {
              const match = block.image_url.url.match(
                /^data:(image\/(?:png|jpeg));base64,(.+)$/,
              );
              if (!match) throw Error("不支持的图片格式");
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: match[1],
                  data: match[2],
                },
              };
            }
            return block;
          }),
        });
      else converted.push(m);
    }
  const payload = anthropic
    ? {
        model,
        system,
        messages: converted,
        max_tokens: maxTokens,
        stream: true,
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              })),
            }
          : {}),
      }
    : {
        model,
        messages,
        stream: true,
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                type: "function",
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                },
              })),
            }
          : {}),
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      };
  const response = await fetcher(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(anthropic
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { Authorization: "Bearer " + key }),
    },
    body: JSON.stringify(payload),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error("模型服务请求失败 (" + response.status + ")");
  if (!response.body) throw Error("模型未返回流式内容");
  let buffer = "",
    done = false,
    finish = "",
    usage = {},
    bytes = 0;
  const calls = new Map();
  function callPart(index, part) {
    if (!Number.isInteger(index) || index < 0 || index >= 16)
      throw Error("工具调用数量或序号无效");
    const c = calls.get(index) || { id: "", name: "", arguments: "" };
    for (const key of ["id", "name", "arguments"])
      if (part[key] !== undefined) {
        if (typeof part[key] !== "string") throw Error("工具调用数据无效");
        c[key] += part[key];
      }
    if (c.id.length > 256 || c.name.length > 128 || c.arguments.length > 65536)
      throw Error("工具调用参数过长");
    calls.set(index, c);
  }
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw Error("模型流式响应过大");
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(
      /\r\n/g,
      "\n",
    );
    let pos;
    while ((pos = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, pos);
      buffer = buffer.slice(pos + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        done = true;
        break;
      }
      let e;
      try {
        e = JSON.parse(data);
      } catch {
        throw Error("模型返回了无效的流式数据");
      }
      if (e.error || e.type === "error") throw Error("模型返回错误");
      if (anthropic) {
        if (
          e.type === "content_block_start" &&
          e.content_block?.type === "tool_use"
        )
          callPart(e.index, {
            id: e.content_block.id,
            name: e.content_block.name,
            arguments: Object.keys(e.content_block.input || {}).length
              ? JSON.stringify(e.content_block.input)
              : "",
          });
        if (
          e.type === "content_block_delta" &&
          e.delta?.type === "input_json_delta"
        )
          callPart(e.index, { arguments: e.delta.partial_json });
        if (e.type === "message_start") {
          usage = { ...e.message?.usage };
          onUsage(usage);
        }
        if (e.type === "message_delta") {
          usage = { ...usage, ...e.usage };
          finish = e.delta?.stop_reason || finish;
          onUsage(usage);
        }
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta")
          yield e.delta.text;
        if (e.type === "message_stop") {
          done = true;
          break;
        }
      } else {
        if (e.usage) {
          usage = e.usage;
          onUsage(usage);
        }
        for (const part of e.choices?.[0]?.delta?.tool_calls || [])
          callPart(part.index, {
            id: part.id,
            name: part.function?.name,
            arguments: part.function?.arguments,
          });
        const text = e.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text) yield text;
        if (e.choices?.[0]?.finish_reason) finish = e.choices[0].finish_reason;
      }
    }
    if (done) break;
  }
  if (!done) throw Error("模型连接中断，回复未完成");
  if (calls.size) {
    if (!tools.length || !["tool_calls", "tool_use"].includes(finish))
      throw Error("模型工具调用未完整结束或未获得授权");
    const result = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => {
        if (!c.id || !tools.some((t) => t.name === c.name))
          throw Error("模型请求了未绑定的工具");
        let args;
        try {
          args = JSON.parse(c.arguments || "{}");
        } catch {
          throw Error("工具参数不是有效 JSON");
        }
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw Error("工具参数必须是对象");
        return { id: c.id, name: c.name, arguments: args };
      });
    if (new Set(result.map((c) => c.id)).size !== result.length)
      throw Error("工具调用标识重复");
    await onToolCalls(result);
    return;
  }
  if (
    [
      "length",
      "max_tokens",
      "tool_calls",
      "tool_use",
      "content_filter",
      "refusal",
    ].includes(finish)
  )
    throw Error("模型回复未完整结束：" + finish);
}
