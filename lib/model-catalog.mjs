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
  function createService(b, actor) {
    if (
      !b ||
      typeof b !== "object" ||
      !b.provider ||
      !Array.isArray(b.models) ||
      !b.models.length ||
      b.models.length > 100 ||
      b.models.some(
        (m) =>
          !m ||
          typeof m !== "object" ||
          Array.isArray(m) ||
          typeof m.model !== "string",
      )
    )
      throw new HttpError(400, "请选择 1–100 个模型");
    if (!b.provider.key && !b.provider.keyEnv)
      throw new HttpError(400, "请填写密钥或密钥环境变量");
    const chosen = b.defaults || {};
    for (const k of ["chat_model", "embedding_model"])
      if (chosen[k] != null && typeof chosen[k] !== "string")
        throw new HttpError(400, "默认模型无效");
    if (
      (chosen.chat_model || chosen.embedding_model) &&
      b.expectedDefaultsRevision !== defaults().revision
    )
      throw new HttpError(409, "默认模型已变化，请刷新后重试");
    db.exec("SAVEPOINT model_service_create");
    try {
      const provider = providers.save({
        ...b.provider,
        model: "",
        isDefault: false,
      });
      const models = b.models.map((m) =>
        save({
          provider_id: provider.id,
          model: m?.model,
          name: typeof m?.name === "string" ? m.name : m?.model?.slice(0, 100),
          model_type: m?.model_type,
          enabled: true,
          dimensions: m?.dimensions ?? 0,
        }),
      );
      const firstChat = models.find((m) => m.model_type === "chat");
      if (firstChat)
        db.prepare("UPDATE ai_providers SET model=? WHERE id=?").run(
          firstChat.model,
          provider.id,
        );
      for (const [key, type] of [
        ["chat_model", "chat"],
        ["embedding_model", "embedding"],
      ]) {
        if (!chosen[key]) continue;
        const model = models.find(
          (m) => m.model_type === type && m.model === chosen[key],
        );
        if (!model || !provider.enabled)
          throw new HttpError(400, "默认模型必须是本次选择的可用模型");
        if (type === "chat") {
          db.prepare(
            "UPDATE ai_providers SET is_default=0,revision=revision+1 WHERE is_default=1",
          ).run();
          db.prepare(
            "UPDATE ai_providers SET is_default=1,model=? WHERE id=?",
          ).run(model.model, provider.id);
        } else
          db.prepare("UPDATE ai_defaults SET embedding_id=? WHERE id=1").run(
            model.id,
          );
      }
      db.prepare("INSERT INTO audit_logs VALUES(?,?,?,?,?,?)").run(
        randomUUID(),
        actor.id,
        "ai.service.create",
        provider.id,
        JSON.stringify({ models: models.length, protocol: provider.protocol }),
        new Date().toISOString(),
      );
      db.exec("RELEASE model_service_create");
      return {
        provider: providers.list().find((p) => p.id === provider.id),
        models,
        defaults: defaults(),
      };
    } catch (error) {
      db.exec("ROLLBACK TO model_service_create");
      db.exec("RELEASE model_service_create");
      throw error;
    }
  }
  function assertRemovable(provider, models) {
    const chosen = defaults();
    if (
      models.some(
        (m) => m.id === chosen.chat_id || m.id === chosen.embedding_id,
      )
    )
      throw new HttpError(409, "请先更换或清除工作空间默认模型");
    for (const model of models) {
      if (
        db
          .prepare("SELECT 1 FROM retrieval_settings WHERE model_id=? LIMIT 1")
          .get(model.id)
      )
        throw new HttpError(409, "模型正被知识库使用，请先更换知识库模型");
      if (
        db
          .prepare(
            "SELECT 1 FROM embedding_jobs WHERE model_id=? AND status IN ('queued','running') LIMIT 1",
          )
          .get(model.id)
      )
        throw new HttpError(409, "模型正在用于知识库索引，请等待任务结束");
    }
    const references = (value) => {
      if (!value || typeof value !== "object") return false;
      if (
        value.providerId === provider.id &&
        models.some(
          (model) =>
            model.model_type === "chat" &&
            (value.model === model.model ||
              (!value.model && provider.model === model.model)),
        )
      )
        return true;
      return Object.values(value).some(references);
    };
    const configs = db.prepare("SELECT config FROM resources").all();
    const published = db
      .prepare(
        "SELECT v.snapshot config FROM workflow_versions v JOIN workflow_state s ON s.workflow_id=v.workflow_id AND s.published_version=v.version",
      )
      .all();
    if (
      [...configs, ...published].some((r) =>
        references(JSON.parse(r.config || "{}")),
      )
    )
      throw new HttpError(409, "模型正被智能体或工作流使用，请先更换相关配置");
  }
  function removeModel(id, revision, actor) {
    const model = db.prepare("SELECT * FROM ai_models WHERE id=?").get(id);
    if (!model) throw new HttpError(404, "模型不存在");
    if (revision !== model.revision)
      throw new HttpError(409, "模型已更新，请刷新后重试");
    const provider = db
      .prepare("SELECT * FROM ai_providers WHERE id=?")
      .get(model.provider_id);
    assertRemovable(provider, [model]);
    db.exec("SAVEPOINT model_delete");
    try {
      if (model.model_type === "chat" && provider.model === model.model)
        db.prepare(
          "UPDATE ai_providers SET model='',revision=revision+1 WHERE id=?",
        ).run(provider.id);
      db.prepare("DELETE FROM ai_models WHERE id=?").run(id);
      db.prepare("INSERT INTO audit_logs VALUES(?,?,?,?,?,?)").run(
        randomUUID(),
        actor.id,
        "ai.model.delete",
        id,
        JSON.stringify({ name: model.name, provider: provider.name }),
        new Date().toISOString(),
      );
      db.exec("RELEASE model_delete");
    } catch (error) {
      db.exec("ROLLBACK TO model_delete");
      db.exec("RELEASE model_delete");
      throw error;
    }
  }
  function removeProvider(id, revision, actor) {
    const provider = db
      .prepare("SELECT * FROM ai_providers WHERE id=?")
      .get(id);
    if (!provider) throw new HttpError(404, "模型服务不存在");
    if (revision !== provider.revision)
      throw new HttpError(409, "模型服务已更新，请刷新后重试");
    if (provider.is_default)
      throw new HttpError(409, "请先更换或清除工作空间默认模型");
    const models = db
      .prepare("SELECT * FROM ai_models WHERE provider_id=?")
      .all(id);
    assertRemovable(provider, models);
    const hasProvider = (value) =>
      value &&
      typeof value === "object" &&
      (value.providerId === id || Object.values(value).some(hasProvider));
    const configs = db.prepare("SELECT config FROM resources").all();
    const published = db
      .prepare(
        "SELECT v.snapshot config FROM workflow_versions v JOIN workflow_state s ON s.workflow_id=v.workflow_id AND s.published_version=v.version",
      )
      .all();
    if (
      [...configs, ...published].some((r) =>
        hasProvider(JSON.parse(r.config || "{}")),
      )
    )
      throw new HttpError(
        409,
        "模型服务正被智能体或工作流使用，请先更换相关配置",
      );
    db.exec("SAVEPOINT provider_delete");
    try {
      db.prepare("DELETE FROM ai_models WHERE provider_id=?").run(id);
      db.prepare("DELETE FROM ai_providers WHERE id=?").run(id);
      db.prepare("INSERT INTO audit_logs VALUES(?,?,?,?,?,?)").run(
        randomUUID(),
        actor.id,
        "ai.provider.delete",
        id,
        JSON.stringify({ name: provider.name, models: models.length }),
        new Date().toISOString(),
      );
      db.exec("RELEASE provider_delete");
    } catch (error) {
      db.exec("ROLLBACK TO provider_delete");
      db.exec("RELEASE provider_delete");
      throw error;
    }
  }
  async function handle({ req, res, url, body, send, currentUser, u }) {
    const p = url.pathname,
      m = p.match(/^\/api\/ai\/models\/([^/]+)$/);
    const providerDelete = p.match(/^\/api\/ai\/providers\/([^/]+)$/);
    if (req.method === "DELETE" && (m || providerDelete)) {
      const b = await body(req),
        actor = currentUser();
      if (actor?.role !== "admin") throw new HttpError(403, "管理员权限已变化");
      if (m) removeModel(m[1], b.expectedRevision, actor);
      else removeProvider(providerDelete[1], b.expectedRevision, actor);
      send(res, 200, { ok: true });
      return true;
    }
    if (p === "/api/ai/providers/preview-models" && req.method === "POST") {
      const b = await body(req);
      if (currentUser()?.role !== "admin")
        throw new HttpError(403, "管理员权限已变化");
      const result = await providers.previewModels(b);
      if (currentUser()?.role !== "admin")
        throw new HttpError(403, "管理员权限已变化");
      send(res, 200, result);
      return true;
    }
    if (p === "/api/ai/services" && req.method === "POST") {
      const b = await body(req),
        actor = currentUser();
      if (actor?.role !== "admin") throw new HttpError(403, "管理员权限已变化");
      send(res, 201, createService(b, actor));
      return true;
    }
    const testModel = p.match(/^\/api\/ai\/models\/([^/]+)\/test$/);
    if (testModel && req.method === "POST") {
      const actor = currentUser();
      if (actor?.role !== "admin") throw new HttpError(403, "管理员权限已变化");
      const model = list().find((m) => m.id === testModel[1]);
      if (!model || !model.enabled || !model.provider_enabled)
        throw new HttpError(400, "模型不存在或已停用");
      if (model.model_type === "embedding")
        await providers.embed({
          catalogId: model.id,
          input: ["连接测试"],
          actorId: actor.id,
          context: "connection-test",
        });
      else
        for await (const _ of providers.complete({
          providerId: model.provider_id,
          model: model.model,
          messages: [{ role: "user", content: "Reply OK." }],
          actorId: actor.id,
          context: "connection-test",
        })) {
        }
      if (currentUser()?.role !== "admin")
        throw new HttpError(403, "管理员权限已变化");
      send(res, 200, { ok: true });
      return true;
    }
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
