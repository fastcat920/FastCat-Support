import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateFeatures, indexKnowledge } from "../lib/features.mjs";
import { migrateProviders, createProviders } from "../lib/providers.mjs";
import { createModelCatalog } from "../lib/model-catalog.mjs";
import {
  migrateRetrieval,
  createRetrieval,
  fuseRanks,
} from "../lib/retrieval.mjs";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE resources(id TEXT PRIMARY KEY,kind TEXT,name TEXT,description TEXT,config TEXT,created TEXT);",
  );
  migrateFeatures(db);
  migrateProviders(db);
  migrateRetrieval(db);
  const dir = mkdtempSync(join(tmpdir(), "fc-retrieval-"));
  let time = 100000,
    fail = false,
    hook = null;
  const calls = [];
  const providerConfig = {
    name: "测试供应商",
    protocol: "openai",
    endpoint: "https://model.example/v1",
    model: "chat",
    key: "test-secret-value",
    enabled: true,
    isDefault: true,
    pricing: { currency: "USD" },
  };
  const providers = createProviders(db, {
    keyPath: join(dir, "key"),
    fetcher: async (url, o) => {
      const input = JSON.parse(o.body || "{}");
      calls.push({ path: new URL(url).pathname, ...input });
      if (hook) await hook(input);
      if (fail) throw Error("offline");
      if (String(url).endsWith("/models"))
        return new Response(
          JSON.stringify({ data: [{ id: "chat" }, { id: "embed-v1" }] }),
        );
      if (String(url).endsWith("/chat/completions"))
        return new Response(
          "data: " +
            JSON.stringify({
              choices: [
                { delta: { content: '["取消购买"]' }, finish_reason: "stop" },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      return new Response(
        JSON.stringify({
          data: input.input
            .map((text, index) => ({
              index,
              embedding: /取消|money|refund|返还/.test(text)
                ? [10, 0, 0]
                : [0, 10, 0],
            }))
            .reverse(),
          usage: { prompt_tokens: 20 },
        }),
      );
    },
  });
  const p = providers.save(providerConfig),
    catalog = createModelCatalog({ db, providers });
  const m = catalog.save({
    provider_id: p.id,
    model: "embed-v1",
    name: "语义模型",
    model_type: "embedding",
    enabled: true,
    dimensions: 3,
    pricing: { currency: "USD", input: 1 },
  });
  const r = createRetrieval({
    db,
    providers,
    catalog,
    autostart: false,
    clock: () => time,
  });
  function document(id, body, collection = "default") {
    db.prepare(
      "INSERT INTO resources VALUES(?,'knowledge',?,?,?,?) ON CONFLICT(id) DO UPDATE SET description=excluded.description,config=excluded.config",
    ).run(id, id, body, JSON.stringify({ collectionId: collection }), "2026");
    indexKnowledge(db, id);
  }
  async function configure(collection = "default", extra = {}) {
    let value;
    await r.handle({
      req: { method: "PUT" },
      res: {},
      url: new URL(
        "http://localhost/api/knowledge/retrieval/collections/" + collection,
      ),
      body: async () => ({
        model_id: m.id,
        mode: "hybrid",
        auto_index: false,
        expand_query: false,
        expectedRevision: r.config(collection).revision,
        ...extra,
      }),
      currentUser: () => ({ role: "admin" }),
      send: (_r, _s, v) => (value = v),
    });
    return value;
  }
  return {
    db,
    providers,
    catalog,
    p,
    m,
    r,
    calls,
    providerConfig,
    document,
    configure,
    fail(value = true) {
      fail = value;
    },
    hook(value) {
      hook = value;
    },
    advance(ms) {
      time += ms;
    },
    close() {
      r.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("semantic search matches a paraphrase with no lexical overlap; vectors are normalized, bounded to collections and usage is recorded", async () => {
  const x = setup();
  try {
    x.document("returns", "收到商品后七天内可取消购买");
    x.document("delivery", "订单会在翌日发出");
    x.db
      .prepare("INSERT INTO collections VALUES('private','其他库','','2026')")
      .run();
    x.document("private-doc", "取消购买仅限其他业务", "private");
    await x.configure();
    x.r.enqueue("default");
    await x.r.tick();
    assert.equal(x.r.coverage("default").pending, 0);
    const keyword = await x.r.search({
      query: "money back",
      collectionIds: ["default"],
      mode: "bm25",
    });
    assert.equal(keyword.results.length, 0);
    const semantic = await x.r.search({
      query: "money back",
      collectionIds: ["default"],
      mode: "semantic",
    });
    assert.equal(semantic.results[0].id, "returns");
    assert.equal(semantic.results[0].score, 1);
    assert.ok(semantic.results.every((r) => r.collectionId === "default"));
    assert.equal(semantic.results[0].vector, undefined);
    assert.ok(
      x.db
        .prepare(
          "SELECT count(*) n FROM ai_usage WHERE context='embedding-query'",
        )
        .get().n > 0,
    );
    assert.equal(
      x.db
        .prepare("SELECT cost FROM ai_usage WHERE context=?")
        .get("embedding-index").cost,
      null,
    );
  } finally {
    x.close();
  }
});
test("hybrid RRF reports ranking provenance and query expansion without treating keyword search as semantic", async () => {
  const x = setup();
  try {
    x.document("returns", "七天内可取消购买");
    x.document("shipping", "包裹物流查询");
    await x.configure("default", { expand_query: true });
    x.r.enqueue("default");
    await x.r.tick();
    const result = await x.r.search({
      query: "返还款项",
      collectionIds: ["default"],
      mode: "hybrid",
    });
    assert.ok(result.metadata.queryVariants.includes("取消购买"));
    assert.equal(result.results[0].id, "returns");
    assert.ok(result.results[0].ranks.some((r) => r.kind === "semantic"));
    assert.ok(result.results[0].ranks.some((r) => r.kind === "keyword"));
    assert.ok(result.results[0].rrfScore > 0);
    const fused = fuseRanks([
      {
        kind: "a",
        rows: [
          { chunkId: "1", score: 1 },
          { chunkId: "2", score: 0.9 },
        ],
      },
      { kind: "b", rows: [{ chunkId: "2", score: 1 }] },
    ]);
    assert.equal(fused[0].chunkId, "2");
  } finally {
    x.close();
  }
});
test("knowledge edits invalidate old vectors, reject not-ready semantic search and allow a fresh index", async () => {
  const x = setup();
  try {
    x.document("returns", "取消购买");
    await x.configure();
    x.r.enqueue("default");
    await x.r.tick();
    x.document("returns", "只允许包裹物流查询");
    assert.equal(x.r.coverage("default").pending, 1);
    await assert.rejects(
      x.r.search({
        query: "money back",
        collectionIds: ["default"],
        mode: "semantic",
      }),
      (e) => e.status === 409,
    );
    x.r.enqueue("default");
    await x.r.tick();
    const result = await x.r.search({
      query: "money back",
      collectionIds: ["default"],
      mode: "semantic",
    });
    assert.equal(result.results.length, 0);
  } finally {
    x.close();
  }
});
test("model/endpoint changes never mix vector spaces, but credential rotation retains reusable vectors", async () => {
  const x = setup();
  try {
    x.document("returns", "取消购买");
    await x.configure();
    x.r.enqueue("default");
    await x.r.tick();
    x.providers.save(
      { ...x.providerConfig, key: "rotated-key", expectedRevision: 0 },
      x.p.id,
    );
    assert.equal(x.r.coverage("default").pending, 0);
    x.providers.save(
      {
        ...x.providerConfig,
        endpoint: "https://changed.example/v1",
        expectedRevision: 1,
      },
      x.p.id,
    );
    assert.equal(x.r.coverage("default").pending, 1);
    await assert.rejects(
      x.r.search({
        query: "money",
        collectionIds: ["default"],
        mode: "semantic",
      }),
      (e) => e.status === 409,
    );
  } finally {
    x.close();
  }
});
test("index jobs retry at most three times and restart safely; manual retry remains explicit", async () => {
  const x = setup();
  try {
    x.document("returns", "取消购买");
    await x.configure("default", { auto_index: true });
    x.fail();
    await x.r.tick();
    x.advance(1000);
    await x.r.tick();
    x.advance(2000);
    await x.r.tick();
    assert.equal(
      x.db.prepare("SELECT attempts FROM embedding_jobs").get().attempts,
      3,
    );
    assert.equal(
      x.db.prepare("SELECT status FROM embedding_jobs").get().status,
      "failed",
    );
    x.advance(50000);
    await x.r.tick();
    assert.equal(
      x.db.prepare("SELECT count(*) n FROM embedding_jobs").get().n,
      1,
    );
    x.fail(false);
    const job = x.r.enqueue("default");
    x.db
      .prepare(
        "UPDATE embedding_jobs SET status='running',attempts=1 WHERE id=?",
      )
      .run(job.id);
    migrateRetrieval(x.db, 0);
    assert.equal(
      x.db.prepare("SELECT status FROM embedding_jobs WHERE id=?").get(job.id)
        .status,
      "queued",
    );
    await x.r.tick();
    assert.equal(
      x.db.prepare("SELECT status FROM embedding_jobs WHERE id=?").get(job.id)
        .status,
      "succeeded",
    );
  } finally {
    x.close();
  }
});
test("edits during an embedding request cancel publication; edits during a query reject stale results", async () => {
  const x = setup();
  try {
    x.document("returns", "取消购买");
    await x.configure();
    x.r.enqueue("default");
    x.hook((input) => {
      if (input.input) x.document("returns", "已变更为物流内容");
    });
    await x.r.tick();
    assert.equal(
      x.db.prepare("SELECT status FROM embedding_jobs").get().status,
      "cancelled",
    );
    assert.equal(x.r.coverage("default").indexed, 0);
    x.hook(null);
    x.r.enqueue("default");
    await x.r.tick();
    x.hook((input) => {
      if (input.input) x.document("returns", "再次更新内容");
    });
    await assert.rejects(
      x.r.search({
        query: "money",
        collectionIds: ["default"],
        mode: "semantic",
      }),
      (e) => e.status === 409,
    );
  } finally {
    x.close();
  }
});
test("embedding-only providers and typed catalog entries stay masked; malformed scopes are rejected", async () => {
  const x = setup();
  try {
    const embedOnly = x.providers.save({
      ...x.providerConfig,
      name: "仅向量",
      model: "",
      isDefault: false,
    });
    assert.equal(embedOnly.model, "");
    assert.ok(!JSON.stringify(x.catalog.list()).includes(x.providerConfig.key));
    assert.throws(
      () => x.catalog.save({ ...x.m, dimensions: -1, expectedRevision: 0 }),
      (e) => e.status === 400,
    );
    assert.throws(
      () =>
        x.catalog.save(
          { ...x.m, model_type: "chat", expectedRevision: 0 },
          x.m.id,
        ),
      (e) => e.status === 400,
    );
    await assert.rejects(
      x.r.search({ query: "q", collectionIds: {} }),
      (e) => e.status === 400,
    );
    await assert.rejects(
      x.r.search({ query: "q", collectionIds: ["missing"] }),
      (e) => e.status === 400,
    );
    assert.equal((await x.providers.discoverModels(x.p.id)).models.length, 2);
  } finally {
    x.close();
  }
});
