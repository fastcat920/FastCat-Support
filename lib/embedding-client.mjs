import { randomUUID } from "node:crypto";
import { boundedText } from "./integrations.mjs";
import { HttpError } from "./management.mjs";
export function createEmbeddingClient({ db, resolve, fetcher = fetch }) {
  async function discoverModels(providerId) {
    const p = resolve(providerId, undefined, "catalog");
    if (p.protocol !== "openai")
      throw new HttpError(400, "此协议请手动添加模型");
    let response;
    try {
      response = await fetcher(p.baseUrl.replace(/\/$/, "") + "/models", {
        redirect: "error",
        headers: { Authorization: "Bearer " + p.key },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(502, "模型目录请求失败");
    }
    if (!response.ok)
      throw new HttpError(502, "模型目录请求失败 (" + response.status + ")");
    let data;
    try {
      data = JSON.parse(await boundedText(response));
    } catch {
      throw new HttpError(502, "模型目录响应无效或过大");
    }
    if (!Array.isArray(data.data) || data.data.length > 2000)
      throw new HttpError(502, "模型目录响应无效");
    return {
      models: [
        ...new Set(
          data.data
            .map((m) => m.id)
            .filter(
              (id) =>
                typeof id === "string" && id.length > 0 && id.length <= 200,
            ),
        ),
      ].map((model) => ({
        model,
        suggestedType: /embed/i.test(model) ? "embedding" : "chat",
      })),
    };
  }
  async function embed({
    catalogId,
    input,
    signal,
    actorId = null,
    context = "embedding-query",
  }) {
    if (
      !Array.isArray(input) ||
      !input.length ||
      input.length > 32 ||
      input.some(
        (t) => typeof t !== "string" || !t.trim() || t.length > 4000,
      ) ||
      input.join("").length > 100000
    )
      throw new HttpError(400, "向量输入须为 1–32 条、每条 1–4000 字符");
    const m = db
      .prepare(
        "SELECT * FROM ai_models WHERE id=? AND model_type='embedding' AND enabled=1",
      )
      .get(catalogId);
    if (!m) throw new HttpError(400, "embedding 模型不存在或已停用");
    const p = resolve(m.provider_id, m.model, "embedding");
    if (p.protocol !== "openai")
      throw new HttpError(400, "不支持此 embedding 协议");
    const id = randomUUID(),
      created = new Date().toISOString();
    let usage = null,
      status = "failed",
      error = "向量请求失败",
      cost = null;
    db.prepare(
      "INSERT INTO ai_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      p.id,
      p.name,
      m.model,
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
      created,
      null,
    );
    try {
      let response;
      try {
        response = await fetcher(p.baseUrl.replace(/\/$/, "") + "/embeddings", {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + p.key,
          },
          body: JSON.stringify({
            model: m.model,
            input,
            encoding_format: "float",
            ...(m.dimensions ? { dimensions: m.dimensions } : {}),
          }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
            : AbortSignal.timeout(60000),
        });
      } catch {
        throw new HttpError(502, "向量服务连接失败或已取消");
      }
      if (!response.ok)
        throw new HttpError(502, "向量服务请求失败 (" + response.status + ")");
      let data;
      try {
        data = JSON.parse(await boundedText(response, 8 * 1024 * 1024));
      } catch {
        throw new HttpError(502, "向量响应无效或过大");
      }
      const n = data.usage?.prompt_tokens ?? data.usage?.total_tokens;
      usage = Number.isSafeInteger(n) && n >= 0 ? n : null;
      if (!Array.isArray(data.data) || data.data.length !== input.length)
        throw new HttpError(502, "向量返回数量不匹配");
      const ordered = new Array(input.length);
      let dimensions = m.dimensions;
      for (const item of data.data) {
        if (
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= input.length ||
          ordered[item.index] ||
          !Array.isArray(item.embedding) ||
          !item.embedding.length ||
          item.embedding.length > 8192 ||
          item.embedding.some((n) => !Number.isFinite(n))
        )
          throw new HttpError(502, "向量序号或内容无效");
        dimensions ||= item.embedding.length;
        if (item.embedding.length !== dimensions)
          throw new HttpError(502, "向量维度不一致");
        const norm = Math.sqrt(
          item.embedding.reduce((sum, n) => sum + n * n, 0),
        );
        if (!Number.isFinite(norm) || !norm)
          throw new HttpError(502, "向量长度无效");
        ordered[item.index] = item.embedding.map((n) => n / norm);
      }
      signal?.throwIfAborted();
      status = "succeeded";
      error = "";
      return { vectors: ordered, dimensions, usage };
    } catch (e) {
      status = signal?.aborted ? "cancelled" : "failed";
      error = e.message;
      throw e;
    } finally {
      db.prepare(
        "UPDATE ai_usage SET status=?,input_tokens=?,output_tokens=0,cache_read_tokens=0,cache_write_tokens=0,cost=?,error=?,finished=? WHERE id=?",
      ).run(status, usage, cost, error, new Date().toISOString(), id);
    }
  }
  return { embed, discoverModels };
}
