import {
  parseOpenapiSpec,
  resolveOpenapi,
  queryParameter,
} from "./openapi.mjs";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
const ajv = new Ajv({ allErrors: true, strict: false });
const ajv2020 = new Ajv2020({ allErrors: true, strict: false });
export function validateArguments(schema, args) {
  let validate;
  try {
    validate = (schema?.$schema?.includes("2020-12") ? ajv2020 : ajv).compile(
      schema || { type: "object" },
    );
  } catch {
    throw Error("工具参数 Schema 无效或含不支持的引用");
  }
  if (!validate(args))
    throw Error(
      "参数无效：" + ajv.errorsText(validate.errors, { separator: "；" }),
    );
  return args;
}
export function integrationUrl(
  value,
  allowed = process.env.INTEGRATION_ALLOWED_ORIGINS || "",
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("服务地址无效");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("只允许不含凭据的 HTTP(S) 地址");
  const origins = allowed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!origins.includes(url.origin))
    throw Error(
      "请将 " + url.origin + " 加入服务器 INTEGRATION_ALLOWED_ORIGINS",
    );
  return url;
}
export function integrationHeaders(config) {
  if (!config.tokenEnv) return {};
  if (!/^FC_SECRET_[A-Z0-9_]+$/.test(config.tokenEnv))
    throw Error("凭据变量必须以 FC_SECRET_ 开头");
  const token = process.env[config.tokenEnv];
  if (!token) throw Error("服务器尚未设置凭据变量 " + config.tokenEnv);
  return { Authorization: "Bearer " + token };
}
export async function boundedText(response, max = 1048576) {
  if (!response.body) return "";
  let size = 0,
    text = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw Error("远程响应超过大小限制");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
export async function integrationFetch(endpoint, options = {}, deps = {}) {
  const url = integrationUrl(endpoint, deps.allowed);
  const response = await (deps.fetcher || fetch)(url, {
    ...options,
    redirect: "manual",
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (response.status >= 300 && response.status < 400)
    throw Error("远程服务重定向已拒绝，请填写最终地址");
  if (!response.ok && response.status !== 202)
    throw Error("远程服务请求失败 (" + response.status + ")");
  return response;
}
export class McpConnection {
  constructor(config, deps = {}) {
    this.config = config;
    this.deps = deps;
    this.counter = 0;
    this.version = "2025-06-18";
  }
  async rpc(method, params, notification = false) {
    const id = ++this.counter;
    const r = await integrationFetch(
      this.config.endpoint,
      {
        method: "POST",
        signal: this.deps.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...integrationHeaders(this.config),
          ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
          ...(this.ready ? { "MCP-Protocol-Version": this.version } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(notification ? {} : { id }),
          method,
          ...(params === undefined ? {} : { params }),
        }),
      },
      this.deps,
    );
    if (method === "initialize") this.session = r.headers.get("mcp-session-id");
    if (notification) {
      await r.body?.cancel();
      return;
    }
    let message;
    if (r.headers.get("content-type")?.includes("text/event-stream")) {
      const decoder = new TextDecoder();
      let buffer = "",
        size = 0;
      try {
        for await (const chunk of r.body) {
          size += chunk.length;
          if (size > 1048576) throw Error("MCP 响应超过大小限制");
          buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(
            /\r\n/g,
            "\n",
          );
          let i;
          while ((i = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const m = JSON.parse(data);
            if (m.id === id) {
              message = m;
              break;
            }
          }
          if (message) break;
        }
      } catch (e) {
        throw Error("MCP 流读取失败：" + e.message);
      }
    } else message = JSON.parse(await boundedText(r));
    if (!message || message.jsonrpc !== "2.0" || message.id !== id)
      throw Error("MCP 返回无效响应");
    if (message.error) throw Error("MCP 错误：" + message.error.message);
    return message.result;
  }
  async open() {
    const result = await this.rpc("initialize", {
      protocolVersion: this.version,
      capabilities: {},
      clientInfo: { name: "fastcat-support", version: "0.2.0" },
    });
    if (!["2025-06-18", "2025-03-26"].includes(result.protocolVersion))
      throw Error("不支持 MCP 协议版本 " + result.protocolVersion);
    this.version = result.protocolVersion;
    if (!result.capabilities?.tools) throw Error("MCP 服务未声明工具能力");
    this.ready = true;
    await this.rpc("notifications/initialized", undefined, true);
    return result;
  }
  async list() {
    let cursor;
    const tools = [];
    for (let page = 0; page < 20; page++) {
      const result = await this.rpc("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(result.tools)) throw Error("MCP 工具列表无效");
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw Error("工具分页超过限制");
  }
  async call(name, args) {
    const tools = await this.list(),
      tool = tools.find((t) => t.name === name);
    if (!tool) throw Error("工具不存在");
    validateArguments(tool.inputSchema, args);
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result.isError)
      throw Error(
        "工具执行失败：" +
          (result.content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n") || "远程工具错误"),
      );
    return result;
  }
  async close() {
    if (this.session)
      try {
        const r = await integrationFetch(
          this.config.endpoint,
          {
            method: "DELETE",
            headers: {
              ...integrationHeaders(this.config),
              "Mcp-Session-Id": this.session,
              "MCP-Protocol-Version": this.version,
            },
          },
          this.deps,
        );
        await r.body?.cancel();
      } catch {}
  }
}
export function openapiOperations(spec) {
  spec = parseOpenapiSpec(spec);
  const result = [],
    names = new Set();
  for (const [path, rawItem] of Object.entries(spec.paths || {})) {
    if (!path.startsWith("/") || /[?#]/.test(path))
      throw Error("OpenAPI 路径须以 / 开头且不包含查询串或片段");
    const item = resolveOpenapi(rawItem, spec);
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const raw = item[method];
      if (!raw) continue;
      const op = raw,
        pathItem = item;
      if (!op) continue;
      const properties = {},
        required = [];
      const parameters = [
        ...new Map(
          [...(pathItem.parameters || []), ...(op.parameters || [])].map(
            (p) => [p.in + ":" + p.name, p],
          ),
        ).values(),
      ];
      for (const p of parameters) {
        if (!["path", "query"].includes(p.in))
          throw Error("暂不支持参数位置：" + p.in);
        if (
          Object.hasOwn(properties, p.name) ||
          p.name === "body" ||
          ["__proto__", "prototype", "constructor"].includes(p.name)
        )
          throw Error("参数名称重复或保留，请调整参数名");
        if (p.in === "path" && p.style && p.style !== "simple")
          throw Error("路径参数暂仅支持 simple 序列化");
        properties[p.name] = p.schema || { type: "string" };
        if (p.required || p.in === "path") required.push(p.name);
      }
      const body = op.requestBody?.content?.["application/json"]?.schema;
      if (op.requestBody && !op.requestBody.content?.["application/json"])
        throw Error("请求体暂仅支持 application/json");
      if (body) {
        properties.body = body;
        if (op.requestBody.required) required.push("body");
      }
      const name = op.operationId || method.toUpperCase() + " " + path;
      if (names.has(name)) throw Error("operationId 重复：" + name);
      names.add(name);
      if (result.length >= 200) throw Error("一个工具服务最多支持 200 个操作");
      result.push({
        name,
        description: op.summary || op.description || "",
        method: method.toUpperCase(),
        path,
        parameters,
        inputSchema: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      });
    }
  }
  return result;
}
export async function callOpenapi(config, name, args, deps = {}) {
  const op = openapiOperations(config.spec).find((o) => o.name === name);
  if (!op) throw Error("接口不存在");
  validateArguments(op.inputSchema, args);
  const base = integrationUrl(config.endpoint, deps.allowed);
  let path = op.path;
  const query = new URLSearchParams();
  for (const p of op.parameters) {
    if (args[p.name] === undefined) continue;
    if (p.in === "path")
      path = path.replaceAll(
        "{" + p.name + "}",
        Array.isArray(args[p.name])
          ? args[p.name].map((v) => encodeURIComponent(String(v))).join(",")
          : args[p.name] && typeof args[p.name] === "object"
            ? Object.entries(args[p.name])
                .map(
                  ([k, v]) =>
                    encodeURIComponent(k) +
                    (p.explode ? "=" : ",") +
                    encodeURIComponent(String(v)),
                )
                .join(",")
            : encodeURIComponent(String(args[p.name])),
      );
    if (p.in === "query") queryParameter(query, p, args[p.name]);
  }
  const url = new URL(
    base.toString().replace(/\/$/, "") + "/" + path.replace(/^\//, ""),
  );
  if (url.origin !== base.origin) throw Error("接口路径必须属于配置的服务");
  url.search = query.toString();
  const response = await integrationFetch(
    url.toString(),
    {
      method: op.method,
      signal: deps.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...integrationHeaders(config),
      },
      ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
    },
    deps,
  );
  const text = await boundedText(response);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}
