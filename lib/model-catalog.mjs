import { randomUUID, createHash } from "node:crypto";
import { HttpError } from "./management.mjs";
export function migrateModels(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS ai_defaults(id INTEGER PRIMARY KEY CHECK(id=1),embedding_id TEXT,revision INTEGER NOT NULL DEFAULT 0);INSERT OR IGNORE INTO ai_defaults VALUES(1,NULL,0)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS ai_models(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,model TEXT NOT NULL,name TEXT NOT NULL,model_type TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,dimensions INTEGER NOT NULL DEFAULT 0,pricing TEXT,revision INTEGER NOT NULL DEFAULT 0,created TEXT,UNIQUE(provider_id,model_type,model))",
  );
  for (const p of db
    .prepare("SELECT id,model FROM ai_providers WHERE model!=''")
    .all())
    db.prepare(
      "INSERT OR IGNORE INTO ai_models(id,provider_id,model,name,model_type,created) VALUES(?,?,?,?,'chat',?)",
    ).run(randomUUID(), p.id, p.model, p.model, new Date().toISOString());
}
export function modelSpace(p, m) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: p.id,
        endpoint: p.endpoint,
        protocol: p.protocol,
        model: m.model,
        dimensions: m.dimensions,
      }),
    )
    .digest("hex");
}
export function createModelCatalog({ db, providers }) {
  const row = ({ pricing, ...r }) => ({ ...r, enabled: !!r.enabled });
  const list = () =>
    db
      .prepare(
        "SELECT m.*,p.name provider_name,p.enabled provider_enabled,p.protocol FROM ai_models m JOIN ai_providers p ON p.id=m.provider_id ORDER BY p.name,m.model_type,m.name",
      )
      .all()
      .map(row);
  function spec(id) {
    const m = db.prepare("SELECT * FROM ai_models WHERE id=?").get(id);
    if (!m || !m.enabled || m.model_type !== "embedding")
      throw new HttpError(400, "请选择启用的 embedding 模型");
    const p = db
      .prepare("SELECT * FROM ai_providers WHERE id=?")
      .get(m.provider_id);
    if (!p || !p.enabled || p.protocol !== "openai")
      throw new HttpError(503, "embedding 需要启用的兼容 OpenAI 供应商");
    return { ...row(m), spaceKey: modelSpace(p, m) };
  }
  function save(b, id) {
    const old = id && db.prepare("SELECT * FROM ai_models WHERE id=?").get(id);
    if (id && !old) throw new HttpError(404, "模型不存在");
    if (old && b.expectedRevision !== old.revision)
      throw new HttpError(409, "模型已更新，请重新打开");
    const p = db
      .prepare("SELECT * FROM ai_providers WHERE id=?")
      .get(b.provider_id);
    if (!p) throw new HttpError(400, "供应商不存在");
    if (
      !["chat", "embedding"].includes(b.model_type) ||
      typeof b.model !== "string" ||
      !b.model.trim() ||
      b.model.length > 200 ||
      typeof b.name !== "string" ||
      !b.name.trim() ||
      b.name.length > 100 ||
      typeof b.enabled !== "boolean" ||
      !Number.isInteger(b.dimensions) ||
      b.dimensions < 0 ||
      b.dimensions > 8192
    )
      throw new HttpError(400, "模型配置无效");
    if (b.model_type === "embedding" && p.protocol !== "openai")
      throw new HttpError(400, "embedding 仅支持兼容 OpenAI 协议");
    if (
      old &&
      (old.provider_id !== b.provider_id ||
        old.model !== b.model.trim() ||
        old.model_type !== b.model_type)
    )
      throw new HttpError(400, "模型标识、类型和供应商不可更改，请添加新模型");
    if (!b.enabled && b.model_type === "chat" && p.model === b.model)
      throw new HttpError(409, "请先更换供应商默认对话模型");
    const pricing = null;
    const mid = id || randomUUID();
    try {
      db.prepare(
        "INSERT INTO ai_models VALUES(?,?,?,?,?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,dimensions=excluded.dimensions,pricing=excluded.pricing,revision=ai_models.revision+1",
      ).run(
        mid,
        p.id,
        b.model.trim(),
        b.name.trim(),
        b.model_type,
        b.enabled ? 1 : 0,
        b.dimensions,
        pricing === null ? null : JSON.stringify(pricing),
        new Date().toISOString(),
      );
    } catch (e) {
      if (String(e.message).includes("UNIQUE"))
        throw new HttpError(409, "此模型已在目录中");
      throw e;
    }
    return row(db.prepare("SELECT * FROM ai_models WHERE id=?").get(mid));
  }
  async function handle({ req, res, url, body, send, currentUser }) {
    const p = url.pathname,
      m = p.match(/^\/api\/ai\/models\/([^/]+)$/);
    if (p === "/api/ai/defaults" && req.method === "GET") {
      send(res, 200, defaults());
      return true;
    }
    if (p === "/api/ai/defaults" && req.method === "PUT") {
      const b = await body(req);
      if (currentUser()?.role !== "admin")
        throw new HttpError(403, "管理员权限已变化");
      if (
        [b.chat_id, b.embedding_id].some(
          (id) => id != null && typeof id !== "string",
        )
      )
        throw new HttpError(400, "默认模型标识无效");
      if (b.expectedRevision !== defaults().revision)
        throw new HttpError(409, "默认模型已变化，请刷新");
      const chat = b.chat_id
        ? list().find(
            (m) =>
              m.id === b.chat_id &&
              m.model_type === "chat" &&
              m.enabled &&
              m.provider_enabled,
          )
        : null;
      if (b.chat_id && !chat) throw new HttpError(400, "请选择可用的对话模型");
      if (b.embedding_id) spec(b.embedding_id);
      db.exec("BEGIN");
      try {
        db.prepare(
          "UPDATE ai_providers SET is_default=0,revision=revision+1 WHERE is_default=1",
        ).run();
        if (chat)
          db.prepare(
            "UPDATE ai_providers SET is_default=1,model=?,revision=revision+1 WHERE id=?",
          ).run(chat.model, chat.provider_id);
        db.prepare(
          "UPDATE ai_defaults SET embedding_id=?,revision=revision+1 WHERE id=1",
        ).run(b.embedding_id || null);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      send(res, 200, defaults());
      return true;
    }
    if (p === "/api/ai/models/batch" && req.method === "POST") {
      const b = await body(req);
      if (currentUser()?.role !== "admin")
        throw new HttpError(403, "管理员权限已变化");
      if (
        !Array.isArray(b.models) ||
        !b.models.length ||
        b.models.length > 100 ||
        b.models.some((m) => !m || typeof m !== "object" || Array.isArray(m))
      )
        throw new HttpError(400, "一次添加 1–100 个模型");
      const result = [];
      db.exec("BEGIN");
      try {
        for (const m of b.models)
          result.push(
            save({
              ...m,
              provider_id: b.provider_id,
              name: typeof m.model === "string" ? m.model.slice(0, 100) : "",
              enabled: true,
              dimensions: 0,
              pricing: null,
            }),
          );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      send(res, 201, result);
      return true;
    }
    if (p === "/api/ai/models" && req.method === "GET") {
      send(res, 200, list());
      return true;
    }
    if (
      (p === "/api/ai/models" && req.method === "POST") ||
      (m && req.method === "PUT")
    ) {
      const b = await body(req);
      if (currentUser()?.role !== "admin")
        throw new HttpError(403, "管理员权限已变化");
      send(res, m ? 200 : 201, save(b, m?.[1]));
      return true;
    }
    const discover = p.match(
      /^\/api\/ai\/providers\/([^/]+)\/models\/discover$/,
    );
    if (discover && req.method === "POST") {
      const revision = db
        .prepare("SELECT revision FROM ai_providers WHERE id=?")
        .get(discover[1])?.revision;
      const result = await providers.discoverModels(discover[1]);
      if (currentUser()?.role !== "admin")
        throw new HttpError(403, "管理员权限已变化");
      if (
        db
          .prepare("SELECT revision FROM ai_providers WHERE id=?")
          .get(discover[1])?.revision !== revision
      )
        throw new HttpError(409, "供应商已变化，请重新发现");
      send(res, 200, result);
      return true;
    }
    return false;
  }
  function defaults() {
    const d = db.prepare("SELECT * FROM ai_defaults WHERE id=1").get();
    const p = db
      .prepare("SELECT id,model FROM ai_providers WHERE is_default=1")
      .get();
    return {
      embedding_id: d.embedding_id,
      revision: d.revision,
      chat_id: p
        ? list().find(
            (m) =>
              m.provider_id === p.id &&
              m.model === p.model &&
              m.model_type === "chat",
          )?.id || null
        : null,
    };
  }
  return { list, spec, save, handle, defaults };
}
