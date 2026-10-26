import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  migrateFeatures,
  indexKnowledge,
  searchKnowledge,
} from "../lib/features.mjs";
import {
  migrateKnowledgeJobs,
  createKnowledgeJobs,
  crawlKnowledge,
  pageLinks,
} from "../lib/knowledge-jobs.mjs";
const origin = "https://docs.example";
const response = (html) =>
  new Response(html, { headers: { "Content-Type": "text/html" } });
function setup(fetcher) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE resources(id TEXT PRIMARY KEY,kind TEXT,name TEXT,description TEXT,config TEXT,created TEXT)",
  );
  migrateFeatures(db);
  migrateKnowledgeJobs(db);
  let time = Date.parse("2026-10-26T00:00:00Z");
  const worker = createKnowledgeJobs({
    db,
    indexKnowledge,
    fetcher,
    allowed: origin,
    autostart: false,
    clock: () => time,
  });
  const source = worker.save({
    name: "帮助中心",
    url: origin + "/help",
    collectionId: "default",
    pathPrefix: "/help",
    maxPages: 10,
    depth: 2,
    intervalMinutes: 15,
    enabled: false,
  });
  return {
    db,
    worker,
    source,
    get time() {
      return time;
    },
    advance(ms) {
      time += ms;
    },
    close() {
      worker.close();
      db.close();
    },
  };
}
test("crawler follows bounded same-origin paths, deduplicates fragments and ignores active content links", async () => {
  const links = pageLinks(
    '<script><a href="/help/private">x</a></script><a href="/help/returns#one">a</a><a href="/help/returns#two">b</a><a href="/helpful">x</a><a href="https://outside.example/help">x</a><a href="javascript:alert(1)">x</a><a href="/help/a.pdf">x</a><a href="/help/%252e%252e/admin">x</a>',
    origin + "/help",
    { root_url: origin + "/help", path_prefix: "/help" },
  );
  assert.deepEqual(links.links, [origin + "/help/returns"]);
  const urls = [];
  const r = await crawlKnowledge(
    {
      root_url: origin + "/help",
      path_prefix: "/help",
      max_pages: 2,
      depth: 2,
    },
    {
      allowed: origin,
      fetcher: async (url) => {
        urls.push(url.href);
        return response(
          url.pathname === "/help"
            ? '<title>帮助</title><p>服务说明</p><a href="/help/returns">退货</a><a href="/help/more">更多</a>'
            : "<p>七天内申请退货</p>",
        );
      },
    },
  );
  assert.equal(r.pages.length, 2);
  assert.equal(r.truncated, true);
  assert.deepEqual(urls, [origin + "/help", origin + "/help/returns"]);
  await assert.rejects(
    crawlKnowledge(
      {
        root_url: origin + "/help",
        path_prefix: "/help",
        max_pages: 1,
        depth: 0,
      },
      {
        allowed: origin,
        fetcher: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://outside.example" },
          }),
      },
    ),
    /重定向/,
  );
});
test("persistent crawl jobs atomically import pages, keep stable IDs and chunks, and reindex changed content", async () => {
  let changed = false;
  const x = setup(async (url) =>
    response(
      url.pathname === "/help"
        ? '<title>服务指南</title><p>欢迎咨询</p><a href="/help/returns">退货政策</a>'
        : changed
          ? "<p>退款政策更新为十五天受理</p>"
          : "<p>签收七天内可以申请退款</p>",
    ),
  );
  try {
    let job = x.worker.enqueue(x.source.id);
    assert.equal(x.worker.enqueue(x.source.id).id, job.id);
    await x.worker.tick();
    assert.equal(
      x.db.prepare("SELECT status FROM knowledge_jobs WHERE id=?").get(job.id)
        .status,
      "succeeded",
    );
    const pages = x.db
      .prepare("SELECT * FROM knowledge_source_pages ORDER BY url")
      .all();
    assert.equal(pages.length, 2);
    const chunks = x.db
      .prepare("SELECT id FROM knowledge_chunks ORDER BY id")
      .all();
    x.worker.enqueue(x.source.id);
    await x.worker.tick();
    assert.deepEqual(
      x.db.prepare("SELECT id FROM knowledge_chunks ORDER BY id").all(),
      chunks,
    );
    assert.deepEqual(
      x.db
        .prepare("SELECT resource_id FROM knowledge_source_pages ORDER BY url")
        .all()
        .map((r) => r.resource_id),
      pages.map((r) => r.resource_id),
    );
    changed = true;
    x.worker.enqueue(x.source.id);
    await x.worker.tick();
    assert.match(searchKnowledge(x.db, "十五天")[0].content, /十五天/);
    assert.equal(
      x.db
        .prepare("SELECT count(*) n FROM resources WHERE kind='knowledge'")
        .get().n,
      2,
    );
  } finally {
    x.close();
  }
});
test("failed root imports preserve the prior index, retry only three times, and running jobs recover after restart", async () => {
  let fail = false;
  const x = setup(async () => {
    if (fail) throw Error("network down");
    return response("<p>原有售后政策</p>");
  });
  try {
    x.worker.enqueue(x.source.id);
    await x.worker.tick();
    const before = x.db
      .prepare("SELECT description FROM resources")
      .get().description;
    fail = true;
    let job = x.worker.enqueue(x.source.id);
    for (let i = 0; i < 3; i++) {
      await x.worker.tick();
      x.advance(10000);
    }
    assert.equal(
      x.db.prepare("SELECT status FROM knowledge_jobs WHERE id=?").get(job.id)
        .status,
      "failed",
    );
    assert.equal(
      x.db.prepare("SELECT attempts FROM knowledge_jobs WHERE id=?").get(job.id)
        .attempts,
      3,
    );
    assert.equal(
      x.db.prepare("SELECT description FROM resources").get().description,
      before,
    );
    fail = false;
    job = x.worker.enqueue(x.source.id);
    x.db
      .prepare(
        "UPDATE knowledge_jobs SET status='running',attempts=1 WHERE id=?",
      )
      .run(job.id);
    migrateKnowledgeJobs(x.db, x.time);
    await x.worker.tick();
    assert.equal(
      x.db.prepare("SELECT status FROM knowledge_jobs WHERE id=?").get(job.id)
        .status,
      "succeeded",
    );
  } finally {
    x.close();
  }
});
test("cancellation blocks imports even when a remote ignores abort; active tasks prevent configuration overwrites", async () => {
  let release, entered;
  const gate = new Promise((r) => (release = r)),
    seen = new Promise((r) => (entered = r));
  const x = setup(async () => {
    entered();
    await gate;
    return response("<p>不应导入</p>");
  });
  try {
    const job = x.worker.enqueue(x.source.id),
      running = x.worker.tick();
    await seen;
    assert.throws(
      () =>
        x.worker.save(
          { ...x.source, name: "覆盖", expectedRevision: 0 },
          x.source.id,
        ),
      (e) => e.status === 409,
    );
    x.worker.cancel(job.id);
    release();
    await running;
    assert.equal(
      x.db.prepare("SELECT status FROM knowledge_jobs WHERE id=?").get(job.id)
        .status,
      "cancelled",
    );
    assert.equal(x.db.prepare("SELECT count(*) n FROM resources").get().n, 0);
  } finally {
    x.close();
  }
});
test("scheduled jobs start only when due and a full queue does not prevent existing jobs from running", async () => {
  const x = setup(async () => response("<p>服务政策</p>"));
  try {
    const scheduled = x.worker.save(
      { ...x.source, enabled: true, expectedRevision: 0 },
      x.source.id,
    );
    await x.worker.tick();
    assert.equal(
      x.db.prepare("SELECT count(*) n FROM knowledge_jobs").get().n,
      0,
    );
    x.advance(15 * 60000);
    await x.worker.tick();
    assert.equal(
      x.db.prepare("SELECT trigger FROM knowledge_jobs").get().trigger,
      "schedule",
    );
    assert.equal(
      x.db.prepare("SELECT status FROM knowledge_jobs").get().status,
      "succeeded",
    );
    for (let i = 0; i < 100; i++) {
      const s = x.worker.save({
        name: "队列" + i,
        url: origin + "/help",
        enabled: false,
      });
      x.worker.enqueue(s.id);
    }
    x.advance(15 * 60000);
    await x.worker.tick();
    assert.equal(
      x.db
        .prepare("SELECT count(*) n FROM knowledge_jobs WHERE status='queued'")
        .get().n,
      99,
    );
  } finally {
    x.close();
  }
});

test("partial subpage failures preserve last known content and moving a source moves all its indexed pages", async () => {
  let broken = false;
  const x = setup(async (url) => {
    if (url.pathname === "/help/returns" && broken)
      throw Error("subpage unavailable");
    return response(
      url.pathname === "/help"
        ? '<p>帮助目录</p><a href="/help/returns">退货</a>'
        : "<p>原有退款政策</p>",
    );
  });
  try {
    x.worker.enqueue(x.source.id);
    await x.worker.tick();
    broken = true;
    const job = x.worker.enqueue(x.source.id);
    await x.worker.tick();
    const result = x.db
      .prepare("SELECT status,progress FROM knowledge_jobs WHERE id=?")
      .get(job.id);
    assert.equal(result.status, "partial");
    assert.equal(JSON.parse(result.progress).errors.length, 1);
    assert.equal(x.db.prepare("SELECT count(*) n FROM resources").get().n, 2);
    assert.ok(searchKnowledge(x.db, "退款").length > 0);
    x.db
      .prepare("INSERT INTO collections VALUES(?,?,?,?)")
      .run("moved", "目标知识库", "", "2026-10-26");
    x.worker.save(
      { ...x.source, collectionId: "moved", expectedRevision: 0 },
      x.source.id,
    );
    assert.equal(
      x.db
        .prepare(
          "SELECT count(*) n FROM knowledge_chunks WHERE collection_id='default'",
        )
        .get().n,
      0,
    );
    assert.ok(searchKnowledge(x.db, "退款", "moved").length > 0);
    assert.throws(
      () =>
        x.worker.save(
          {
            ...x.source,
            url: origin + "/other",
            pathPrefix: "/other",
            collectionId: "moved",
            expectedRevision: 1,
          },
          x.source.id,
        ),
      (e) => e.status === 409,
    );
  } finally {
    x.close();
  }
});
