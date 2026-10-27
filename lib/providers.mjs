import { randomUUID } from "node:crypto";
import { createVault } from "./vault.mjs";
import { HttpError } from "./management.mjs";
import { streamCompletion } from "./ai.mjs";
import { migrateModels } from "./model-catalog.mjs";
import { createEmbeddingClient } from "./embedding-client.mjs";
export function providerEndpoint(value) {
  const endpoint = String(value || "").replace(/\/$/, "");
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, "接口地址无效");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new HttpError(400, "请使用 HTTPS 接口，HTTP 仅允许本机调试");
  return endpoint;
}
export function migrateProviders(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_providers(id TEXT PRIMARY KEY,name TEXT,protocol TEXT,endpoint TEXT,model TEXT,secret TEXT,key_env TEXT,enabled INTEGER,is_default INTEGER,pricing TEXT,max_tokens INTEGER,include_usage INTEGER,revision INTEGER DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS ai_one_default ON ai_providers(is_default) WHERE is_default=1;
CREATE TABLE IF NOT EXISTS ai_usage(id TEXT PRIMARY KEY,provider_id TEXT,provider_name TEXT,model TEXT,actor_id TEXT,context TEXT,status TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,cost REAL,currency TEXT,pricing TEXT,error TEXT,created TEXT,finished TEXT);`);
  migrateModels(db);
  db.prepare(
    "UPDATE ai_usage SET status='interrupted',error='服务重启导致请求中断',finished=? WHERE status='running'",
  ).run(new Date().toISOString());
}
export function createProviders(db, { keyPath, fetcher = fetch } = {}) {
  const { seal, unseal } = createVault(keyPath);
  const rows = () =>
    db
      .prepare("SELECT * FROM ai_providers ORDER BY is_default DESC,name")
      .all();
  const publicRow = (r) => {
    const { secret, pricing, ...safe } = r;
    return {
      ...safe,
      keyConfigured: !!(secret || (r.key_env && process.env[r.key_env])),
      enabled: !!r.enabled,
      is_default: !!r.is_default,
    };
  };
  function resolve(id, override, kind = "chat") {
    let r = id
      ? db.prepare("SELECT * FROM ai_providers WHERE id=?").get(id)
      : db.prepare("SELECT * FROM ai_providers WHERE is_default=1").get();
    if (id && !r) throw new HttpError(400, "模型供应商不存在");
    if (r) {
      if (!r.enabled) throw new HttpError(503, "模型供应商已停用");
      const key = r.key_env
        ? process.env[r.key_env]
        : r.secret
          ? unseal(r.secret, r.id)
          : "";
      if (!key) throw new HttpError(503, "模型供应商尚未配置密钥");
      const selected = override || r.model;
      const catalog = db
        .prepare(
          "SELECT * FROM ai_models WHERE provider_id=? AND model=? AND model_type=?",
        )
        .get(r.id, selected, kind);
      if (catalog && !catalog.enabled)
        throw new HttpError(503, "所选模型已停用");
      if (kind === "embedding" && !catalog)
        throw new HttpError(400, "embedding 模型未登记");
      if (
        kind === "chat" &&
        !catalog &&
        db
          .prepare(
            "SELECT id FROM ai_models WHERE provider_id=? AND model=? AND model_type='embedding'",
          )
          .get(r.id, selected)
      )
        throw new HttpError(400, "embedding 模型不能用于对话");
      return {
        ...r,
        key,
        baseUrl: r.endpoint,
        maxTokens: r.max_tokens,
        includeUsage: !!r.include_usage,
        model: override || r.model,
      };
    }
    return {
      id: "environment",
      name: "服务器默认",
      protocol: "openai",
      baseUrl: process.env.AI_BASE_URL,
      key: process.env.AI_API_KEY,
      model: override || process.env.AI_MODEL,
      includeUsage: true,
    };
  }
  function configured() {
    return (
      rows().some(
        (r) =>
          r.enabled &&
          r.model &&
          (r.secret || (r.key_env && process.env[r.key_env])),
      ) ||
      !!(
        process.env.AI_BASE_URL &&
        process.env.AI_API_KEY &&
        process.env.AI_MODEL
      )
    );
  }
  async function* complete({
    providerId,
    model,
    messages,
    signal,
    actorId = null,
    context = "draft",
    tools = [],
    onToolCalls = () => {},
  }) {
    const p = resolve(providerId, model),
      id = randomUUID(),
      now = () => new Date().toISOString();
    let usage = null,
      status = "succeeded",
      error = "",
      output = 0,
      completed = false;
    db.prepare(
      "INSERT INTO ai_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      p.id,
      p.name,
      p.model || "",
      actorId,
      context,
      "running",
      null,
      null,
      null,
      null,
      null,
      "",
      "{}",
      "",
      now(),
      null,
    );
    try {
      for await (const text of streamCompletion({
        ...p,
        messages,
        signal,
        tools,
        onToolCalls,
        fetcher,
        onUsage: (u) => {
          usage = u;
        },
      })) {
        output += text.length;
        if (output > 100000) throw Error("模型回复过长");
        yield text;
      }
      completed = true;
    } catch (e) {
      status = signal?.aborted ? "cancelled" : "failed";
      error = e.message;
      throw e;
    } finally {
      if (status === "succeeded" && (!completed || signal?.aborted))
        status = "cancelled";
      const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
      const input = n(
          p.protocol === "anthropic"
            ? usage?.input_tokens
            : usage?.prompt_tokens,
        ),
        out = n(
          p.protocol === "anthropic"
            ? usage?.output_tokens
            : usage?.completion_tokens,
        ),
        read =
          n(
            p.protocol === "anthropic"
              ? usage?.cache_read_input_tokens
              : usage?.prompt_tokens_details?.cached_tokens,
          ) || 0,
        write = n(usage?.cache_creation_input_tokens) || 0;
      const cost = null;
      db.prepare(
        "UPDATE ai_usage SET status=?,input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,cost=?,error=?,finished=? WHERE id=?",
      ).run(
        status,
        input,
        out,
        usage ? read : null,
        usage ? write : null,
        cost,
        error,
        now(),
        id,
      );
    }
  }
  async function previewModels(b) {
    if (!b || typeof b !== "object" || Array.isArray(b))
      throw new HttpError(400, "连接配置无效");
    const endpoint = providerEndpoint(b.endpoint);
    if (!["openai", "anthropic"].includes(b.protocol))
      throw new HttpError(400, "协议无效");
    if (b.keyEnv && !/^FC_SECRET_[A-Z0-9_]{1,80}$/.test(b.keyEnv))
      throw new HttpError(400, "环境变量须使用 FC_SECRET_ 前缀");
    const key = b.keyEnv ? process.env[b.keyEnv] : b.key;
    if (
      typeof key !== "string" ||
      !key ||
      key.length > 8192 ||
      /[\r\n]/.test(key)
    )
      throw new HttpError(400, "请填写有效密钥或已配置的密钥环境变量");
    return createEmbeddingClient({
      db,
      fetcher,
      resolve: () => ({ protocol: b.protocol, baseUrl: endpoint, key }),
    }).discoverModels("preview");
  }
  function save(b, id) {
    const old = id
      ? db.prepare("SELECT * FROM ai_providers WHERE id=?").get(id)
      : null;
    if (id && !old) throw new HttpError(404, "供应商不存在");
    if (old && b.expectedRevision !== old.revision)
      throw new HttpError(409, "供应商已更新，请重新打开");
    const endpoint = providerEndpoint(b.endpoint);
    if (
      !["openai", "anthropic"].includes(b.protocol) ||
      typeof b.name !== "string" ||
      !b.name.trim() ||
      b.name.length > 100 ||
      typeof b.model !== "string" ||
      b.model.length > 200 ||
      (b.isDefault && !b.model.trim())
    )
      throw new HttpError(400, "名称、协议或模型标识无效");
    if (
      id &&
      db
        .prepare(
          "SELECT enabled FROM ai_models WHERE provider_id=? AND model_type='chat' AND model=?",
        )
        .get(id, b.model.trim())?.enabled === 0
    )
      throw new HttpError(409, "默认对话模型已停用，请先在本地模型目录启用");
    const pricing = {};
    if (b.keyEnv && !/^FC_SECRET_[A-Z0-9_]{1,80}$/.test(b.keyEnv))
      throw new HttpError(400, "环境变量须使用 FC_SECRET_ 前缀");
    if (
      b.key !== undefined &&
      (typeof b.key !== "string" ||
        b.key.length > 8192 ||
        b.key.length < 1 ||
        /[\r\n]/.test(b.key))
    )
      throw new HttpError(400, "密钥格式无效");
    if (b.clearKey && b.key) throw new HttpError(400, "不能同时清除和设置密钥");
    const maxTokens = b.maxTokens ?? 2048;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768)
      throw new HttpError(400, "输出上限须为 1–32768");
    const providerId = id || randomUUID(),
      secret = b.clearKey
        ? ""
        : b.key
          ? seal(b.key, providerId)
          : old?.secret || "";
    db.exec("SAVEPOINT provider_save");
    try {
      if (b.isDefault)
        db.prepare(
          "UPDATE ai_providers SET is_default=0 WHERE is_default=1",
        ).run();
      db.prepare(
        "INSERT INTO ai_providers VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,protocol=excluded.protocol,endpoint=excluded.endpoint,model=excluded.model,secret=excluded.secret,key_env=excluded.key_env,enabled=excluded.enabled,is_default=excluded.is_default,pricing=excluded.pricing,max_tokens=excluded.max_tokens,include_usage=excluded.include_usage,revision=ai_providers.revision+1",
      ).run(
        providerId,
        b.name.trim(),
        b.protocol,
        endpoint,
        b.model.trim(),
        secret,
        b.keyEnv || "",
        b.enabled === false ? 0 : 1,
        b.isDefault ? 1 : 0,
        JSON.stringify(pricing),
        maxTokens,
        b.includeUsage === false ? 0 : 1,
        0,
      );
      if (b.model.trim())
        db.prepare(
          "INSERT OR IGNORE INTO ai_models(id,provider_id,model,name,model_type,created) VALUES(?,?,?,?,'chat',?)",
        ).run(
          randomUUID(),
          providerId,
          b.model.trim(),
          b.model.trim(),
          new Date().toISOString(),
        );
      db.prepare("UPDATE ai_defaults SET revision=revision+1 WHERE id=1").run();
      db.exec("RELEASE provider_save");
    } catch (e) {
      db.exec("ROLLBACK TO provider_save");
      db.exec("RELEASE provider_save");
      throw e;
    }
    return publicRow(
      db.prepare("SELECT * FROM ai_providers WHERE id=?").get(providerId),
    );
  }
  async function handle({ req, res, url, u, body, send, currentUser }) {
    const p = url.pathname,
      m = req.method;
    if (p === "/api/ai/providers" && m === "GET") {
      send(res, 200, rows().map(publicRow));
      return true;
    }
    const one = p.match(/^\/api\/ai\/providers\/([^/]+)$/);
    if ((p === "/api/ai/providers" && m === "POST") || (one && m === "PUT")) {
      const b = await body(req);
      if (currentUser && currentUser()?.role !== "admin")
        throw new HttpError(403, "管理员权限已变化");
      const result = save(b, one?.[1]);
      db.prepare("INSERT INTO audit_logs VALUES(?,?,?,?,?,?)").run(
        randomUUID(),
        u.id,
        "ai.provider.save",
        result.id,
        JSON.stringify({
          protocol: result.protocol,
          model: result.model,
          keyChanged: !!b.key || !!b.clearKey,
          revision: result.revision,
        }),
        new Date().toISOString(),
      );
      send(res, one ? 200 : 201, result);
      return true;
    }
    const test = p.match(/^\/api\/ai\/providers\/([^/]+)\/test$/);
    if (test && m === "POST") {
      let text = "";
      for await (const t of complete({
        providerId: test[1],
        messages: [{ role: "user", content: "Reply OK." }],
        actorId: u.id,
        context: "connection-test",
      }))
        text += t;
      send(res, 200, { ok: true, text: text.slice(0, 500) });
      return true;
    }
    if (p === "/api/ai/usage" && m === "GET") {
      const start = url.searchParams.get("start") || "0000",
        end = url.searchParams.get("end") || "9999";
      const items = db
        .prepare(
          "SELECT id,provider_id,provider_name,model,actor_id,context,status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,error,created,finished FROM ai_usage WHERE created>=? AND created<=? ORDER BY created DESC LIMIT 500",
        )
        .all(start, end + "T23:59:59.999Z");
      const summary = db
        .prepare(
          "SELECT count(*) requests,sum(input_tokens) inputTokens,sum(output_tokens) outputTokens FROM ai_usage WHERE created>=? AND created<=?",
        )
        .all(start, end + "T23:59:59.999Z");
      send(res, 200, { items, summary });
      return true;
    }
    return false;
  }
  return {
    ...createEmbeddingClient({ db, resolve, fetcher }),
    complete,
    handle,
    configured,
    previewModels,
    save,
    list: () => rows().map(publicRow),
    resolve,
  };
}
