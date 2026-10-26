import { randomUUID, createHash } from "node:crypto";
import { parse } from "parse5";
import { HttpError } from "./management.mjs";
import {
  integrationUrl,
  integrationFetch,
  boundedText,
} from "./integrations.mjs";
import { htmlToText } from "./knowledge.mjs";
export function migrateKnowledgeJobs(db, now = Date.now()) {
  db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_sources(id TEXT PRIMARY KEY,name TEXT,root_url TEXT,collection_id TEXT REFERENCES collections(id),max_pages INTEGER,depth INTEGER,path_prefix TEXT,interval_minutes INTEGER,enabled INTEGER,revision INTEGER DEFAULT 0,next_run INTEGER,last_job TEXT,created TEXT);
CREATE TABLE IF NOT EXISTS knowledge_jobs(id TEXT PRIMARY KEY,source_id TEXT REFERENCES knowledge_sources(id) ON DELETE CASCADE,status TEXT,trigger TEXT,attempts INTEGER DEFAULT 0,available INTEGER,created TEXT,started TEXT,finished TEXT,error TEXT,progress TEXT,config TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_job_active ON knowledge_jobs(source_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS knowledge_job_queue ON knowledge_jobs(status,available);
CREATE TABLE IF NOT EXISTS knowledge_source_pages(source_id TEXT REFERENCES knowledge_sources(id) ON DELETE CASCADE,url TEXT,resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,hash TEXT,synced TEXT,PRIMARY KEY(source_id,url));`);
  db.prepare(
    "UPDATE knowledge_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,available=?,error='服务重启，未完成任务重新排队' WHERE status='running'",
  ).run(now);
}
export function withinPath(path, prefix) {
  return (
    !/%(?:2f|5c|2e|25|00)/i.test(path) &&
    (prefix === "/" ||
      path === prefix ||
      path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"))
  );
}
export function pageLinks(html, url, source) {
  const tree = parse(html),
    stack = [tree],
    links = [],
    origin = new URL(source.root_url).origin;
  let nodes = 0,
    title = "";
  while (stack.length) {
    const n = stack.pop();
    if (++nodes > 50000) throw Error("网页结构超过限制");
    if (["script", "style", "noscript", "svg", "template"].includes(n.tagName))
      continue;
    if (!title && n.tagName === "title")
      title = (n.childNodes || [])
        .filter((c) => c.nodeName === "#text")
        .map((c) => c.value)
        .join("")
        .trim()
        .slice(0, 150);
    if (n.tagName === "a") {
      const href = n.attrs?.find((a) => a.name === "href")?.value;
      if (href) {
        try {
          const next = new URL(href, url);
          next.hash = "";
          next.searchParams.sort();
          if (
            next.origin === origin &&
            !next.username &&
            !next.password &&
            ["http:", "https:"].includes(next.protocol) &&
            withinPath(next.pathname, source.path_prefix) &&
            next.href.length < 2000 &&
            !/\.(pdf|docx?|xlsx?|zip|png|jpe?g|gif|webp|svg|css|js|mp[34])$/i.test(
              next.pathname,
            )
          )
            links.push(next.href);
        } catch {}
      }
    }
    if (n.childNodes)
      for (let i = n.childNodes.length - 1; i >= 0; i--)
        stack.push(n.childNodes[i]);
  }
  return { title, links: [...new Set(links)] };
}
export async function crawlKnowledge(
  source,
  { signal, onProgress = () => {}, fetcher, allowed } = {},
) {
  const root = integrationUrl(source.root_url, allowed);
  root.hash = "";
  root.searchParams.sort();
  const queue = [{ url: root.href, depth: 0 }],
    seen = new Set(),
    pages = [],
    errors = [];
  let bytes = 0,
    characters = 0;
  while (queue.length && seen.size < source.max_pages) {
    if (signal?.aborted) throw Error("采集已取消");
    const next = queue.shift();
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    try {
      const response = await integrationFetch(
        next.url,
        {
          headers: {
            Accept: "text/html,text/plain",
            "User-Agent": "FastCatKnowledge/0.7",
          },
          signal,
        },
        {
          ...(fetcher ? { fetcher } : {}),
          ...(allowed !== undefined ? { allowed } : {}),
        },
      );
      const type = response.headers.get("content-type") || "";
      if (!/text\/(html|plain)/i.test(type))
        throw Error("网页需返回 HTML 或纯文本");
      const raw = await boundedText(response, 1048576);
      bytes += Buffer.byteLength(raw);
      if (bytes > 5 * 1048576) throw Error("本次采集超过 5 MB");
      const content = (
        type.includes("text/plain") ? raw : htmlToText(raw)
      ).trim();
      if (!content || content.length > 200000)
        throw Error("正文为空或超过 200,000 字符");
      characters += content.length;
      if (characters > 1000000) throw Error("本次采集正文超过 1,000,000 字符");
      const parsed = type.includes("html")
        ? pageLinks(raw, next.url, source)
        : { title: "", links: [] };
      pages.push({
        url: next.url,
        title: parsed.title || new URL(next.url).pathname,
        content,
      });
      if (next.depth < source.depth)
        for (const link of parsed.links) {
          if (queue.length < 1000 && !seen.has(link))
            queue.push({ url: link, depth: next.depth + 1 });
        }
    } catch (error) {
      if (signal?.aborted) throw Error("采集已取消");
      if (next.depth === 0) throw error;
      errors.push({ url: next.url, error: error.message });
      if (bytes > 5 * 1048576 || characters > 1000000) break;
    }
    await onProgress({
      visited: seen.size,
      importable: pages.length,
      remaining: queue.length,
      errors: errors.length,
    });
  }
  return { pages, errors, truncated: queue.length > 0 };
}
export function createKnowledgeJobs({
  db,
  indexKnowledge,
  broadcast = () => {},
  clock = () => Date.now(),
  fetcher,
  allowed,
  autostart = true,
}) {
  let closed = false,
    working = false,
    timer;
  const active = new Map();
  const now = () => new Date(clock()).toISOString();
  const get = (id) => {
    const r = db.prepare("SELECT * FROM knowledge_sources WHERE id=?").get(id);
    if (!r) throw new HttpError(404, "网站来源不存在");
    return r;
  };
  function validate(b) {
    const url = integrationUrl(b.url || b.root_url, allowed);
    url.hash = "";
    const defaultPrefix = /\.[a-z0-9]{1,8}$/i.test(url.pathname)
      ? url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1)
      : url.pathname;
    const prefix = b.pathPrefix || b.path_prefix || defaultPrefix;
    if (
      typeof b.name !== "string" ||
      !b.name.trim() ||
      b.name.length > 150 ||
      typeof prefix !== "string" ||
      !prefix.startsWith("/") ||
      prefix.includes("?") ||
      prefix.includes("#") ||
      !withinPath(url.pathname, prefix)
    )
      throw new HttpError(400, "来源名称或路径范围无效");
    const collectionId = b.collectionId || b.collection_id || "default";
    if (!db.prepare("SELECT id FROM collections WHERE id=?").get(collectionId))
      throw new HttpError(400, "知识库不存在");
    const maxPages = b.maxPages ?? b.max_pages ?? 10,
      depth = b.depth ?? 2,
      interval = b.intervalMinutes ?? b.interval_minutes ?? 60;
    if (
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 30 ||
      !Number.isInteger(depth) ||
      depth < 0 ||
      depth > 5 ||
      !Number.isInteger(interval) ||
      interval < 15 ||
      interval > 43200
    )
      throw new HttpError(
        400,
        "最多 1–30 页、深度 0–5，定时同步间隔 15–43200 分钟",
      );
    return {
      name: b.name.trim(),
      url: url.href,
      prefix,
      collectionId,
      maxPages,
      depth,
      interval,
      enabled: b.enabled === true || b.enabled === 1,
    };
  }
  function save(b, id) {
    const old = id ? get(id) : null;
    if (old && old.revision !== b.expectedRevision)
      throw new HttpError(409, "网站来源已更新，请刷新后重试");
    if (
      old &&
      db
        .prepare(
          "SELECT id FROM knowledge_jobs WHERE source_id=? AND status IN ('queued','running')",
        )
        .get(id)
    )
      throw new HttpError(409, "请先取消该来源未完成的任务");
    const v = validate(b),
      sourceId = id || randomUUID();
    if (
      old &&
      old.root_url !== v.url &&
      db
        .prepare(
          "SELECT url FROM knowledge_source_pages WHERE source_id=? LIMIT 1",
        )
        .get(id)
    )
      throw new HttpError(409, "已有采集页面的来源不能更换入口，请新建来源");
    db.exec("SAVEPOINT knowledge_source_save");
    try {
      db.prepare(
        "INSERT INTO knowledge_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,collection_id=excluded.collection_id,max_pages=excluded.max_pages,depth=excluded.depth,path_prefix=excluded.path_prefix,interval_minutes=excluded.interval_minutes,enabled=excluded.enabled,revision=revision+1,next_run=excluded.next_run,root_url=excluded.root_url",
      ).run(
        sourceId,
        v.name,
        v.url,
        v.collectionId,
        v.maxPages,
        v.depth,
        v.prefix,
        v.interval,
        v.enabled ? 1 : 0,
        0,
        v.enabled ? clock() + v.interval * 60000 : null,
        old?.last_job || null,
        old?.created || now(),
      );
      if (old && old.collection_id !== v.collectionId) {
        for (const row of db
          .prepare(
            "SELECT r.id,r.config FROM knowledge_source_pages p JOIN resources r ON r.id=p.resource_id WHERE p.source_id=?",
          )
          .all(id)) {
          const c = JSON.parse(row.config);
          db.prepare("UPDATE resources SET config=? WHERE id=?").run(
            JSON.stringify({ ...c, collectionId: v.collectionId }),
            row.id,
          );
          indexKnowledge(db, row.id);
        }
      }
      db.exec("RELEASE knowledge_source_save");
    } catch (e) {
      db.exec("ROLLBACK TO knowledge_source_save");
      db.exec("RELEASE knowledge_source_save");
      throw e;
    }
    return get(sourceId);
  }
  function enqueue(id, trigger = "manual") {
    const s = get(id),
      existing = db
        .prepare(
          "SELECT id FROM knowledge_jobs WHERE source_id=? AND status IN ('queued','running')",
        )
        .get(id);
    if (existing) return { id: existing.id, duplicate: true };
    if (
      db
        .prepare(
          "SELECT count(*) n FROM knowledge_jobs WHERE status IN ('queued','running')",
        )
        .get().n >= 100
    )
      throw new HttpError(429, "采集队列已满");
    const jobId = randomUUID();
    db.prepare(
      "INSERT INTO knowledge_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      jobId,
      id,
      "queued",
      trigger,
      0,
      clock(),
      now(),
      null,
      null,
      "",
      "{}",
      JSON.stringify(s),
    );
    db.prepare("UPDATE knowledge_sources SET last_job=? WHERE id=?").run(
      jobId,
      id,
    );
    wake();
    return { id: jobId };
  }
  function cancel(id) {
    const job = db.prepare("SELECT * FROM knowledge_jobs WHERE id=?").get(id);
    if (!job) throw new HttpError(404, "任务不存在");
    if (!["queued", "running"].includes(job.status)) return { ok: true };
    db.prepare(
      "UPDATE knowledge_jobs SET status='cancelled',finished=?,error='管理员取消任务' WHERE id=?",
    ).run(now(), id);
    active.get(id)?.abort();
    return { ok: true };
  }
  async function run(job) {
    const controller = new AbortController();
    active.set(job.id, controller);
    const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(120000),
      ]),
      source = JSON.parse(job.config);
    try {
      const result = await crawlKnowledge(source, {
        signal,
        fetcher,
        allowed,
        onProgress: (progress) =>
          db
            .prepare("UPDATE knowledge_jobs SET progress=? WHERE id=?")
            .run(JSON.stringify(progress), job.id),
      });
      const current = get(source.id);
      if (
        signal.aborted ||
        current.revision !== source.revision ||
        db.prepare("SELECT status FROM knowledge_jobs WHERE id=?").get(job.id)
          ?.status !== "running"
      )
        throw Error("来源或任务状态已改变");
      let changed = 0;
      db.exec("SAVEPOINT import_crawl");
      try {
        for (const p of result.pages) {
          const old = db
              .prepare(
                "SELECT * FROM knowledge_source_pages WHERE source_id=? AND url=?",
              )
              .get(source.id, p.url),
            hash = createHash("sha256").update(p.content).digest("hex"),
            resourceId = old?.resource_id || randomUUID();
          const config = JSON.stringify({
            source: "website",
            sourceId: source.id,
            sourceUrl: p.url,
            collectionId: source.collection_id,
            syncedAt: now(),
          });
          if (!old) {
            db.prepare("INSERT INTO resources VALUES(?,?,?,?,?,?)").run(
              resourceId,
              "knowledge",
              (source.name === p.title
                ? source.name
                : source.name + " · " + p.title
              ).slice(0, 200),
              p.content,
              config,
              now(),
            );
            indexKnowledge(db, resourceId);
            changed++;
          } else {
            db.prepare(
              "UPDATE resources SET name=?,description=?,config=? WHERE id=?",
            ).run(
              (source.name === p.title
                ? source.name
                : source.name + " · " + p.title
              ).slice(0, 200),
              p.content,
              config,
              resourceId,
            );
            if (old.hash !== hash) {
              indexKnowledge(db, resourceId);
              changed++;
            }
          }
          db.prepare(
            "INSERT INTO knowledge_source_pages VALUES(?,?,?,?,?) ON CONFLICT(source_id,url) DO UPDATE SET hash=excluded.hash,synced=excluded.synced",
          ).run(source.id, p.url, resourceId, hash, now());
        }
        const progress = {
          imported: result.pages.length,
          changed,
          errors: result.errors,
          truncated: result.truncated,
        };
        db.prepare(
          "UPDATE knowledge_jobs SET status=?,finished=?,progress=?,error=? WHERE id=?",
        ).run(
          result.errors.length || result.truncated ? "partial" : "succeeded",
          now(),
          JSON.stringify(progress),
          result.errors.length
            ? "部分网页采集失败"
            : result.truncated
              ? "达到采集页数或资源上限"
              : "",
          job.id,
        );
        db.exec("RELEASE import_crawl");
      } catch (e) {
        db.exec("ROLLBACK TO import_crawl");
        db.exec("RELEASE import_crawl");
        throw e;
      }
      broadcast();
    } catch (error) {
      const row = db
        .prepare("SELECT status,attempts FROM knowledge_jobs WHERE id=?")
        .get(job.id);
      if (row?.status === "running") {
        const cancelled = controller.signal.aborted,
          again = !cancelled && row.attempts < 3 && !closed;
        db.prepare(
          "UPDATE knowledge_jobs SET status=?,available=?,finished=?,error=? WHERE id=?",
        ).run(
          cancelled ? "cancelled" : again ? "queued" : "failed",
          clock() + row.attempts * 2000,
          again ? null : now(),
          error.message,
          job.id,
        );
      }
    } finally {
      active.delete(job.id);
    }
  }
  async function tick() {
    if (closed || working) return;
    working = true;
    try {
      for (const s of db
        .prepare(
          "SELECT * FROM knowledge_sources WHERE enabled=1 AND next_run<=?",
        )
        .all(clock())) {
        try {
          enqueue(s.id, "schedule");
          db.prepare("UPDATE knowledge_sources SET next_run=? WHERE id=?").run(
            clock() + s.interval_minutes * 60000,
            s.id,
          );
        } catch {
          db.prepare("UPDATE knowledge_sources SET next_run=? WHERE id=?").run(
            clock() + 60000,
            s.id,
          );
        }
      }
      const job = db
        .prepare(
          "SELECT * FROM knowledge_jobs WHERE status='queued' AND available<=? ORDER BY created,rowid LIMIT 1",
        )
        .get(clock());
      if (job) {
        const claim = db
          .prepare(
            "UPDATE knowledge_jobs SET status='running',attempts=attempts+1,started=? WHERE id=? AND status='queued'",
          )
          .run(now(), job.id);
        if (claim.changes) await run(job);
      }
    } finally {
      working = false;
    }
  }
  function wake() {
    if (autostart && !closed) setTimeout(() => tick().catch(() => {}), 0);
  }
  if (autostart) {
    timer = setInterval(() => tick().catch(() => {}), 1000);
    timer.unref();
    wake();
  }
  async function handle({ req, res, url, u, body, send, currentUser }) {
    const p = url.pathname,
      m = req.method;
    const read = async () => {
      const b = await body(req);
      if (currentUser && currentUser()?.role !== "admin")
        throw new HttpError(403, "管理员权限已变化");
      return b;
    };
    if (p === "/api/knowledge/sources" && m === "GET") {
      send(
        res,
        200,
        db
          .prepare(
            "SELECT s.*,(SELECT count(*) FROM knowledge_source_pages p WHERE p.source_id=s.id) page_count FROM knowledge_sources s ORDER BY s.created DESC",
          )
          .all(),
      );
      return true;
    }
    if (p === "/api/knowledge/sources" && m === "POST") {
      send(res, 201, save(await read()));
      return true;
    }
    const sm = p.match(
      /^\/api\/knowledge\/sources\/([^/]+)(?:\/(run|pages))?$/,
    );
    if (sm) {
      const s = get(sm[1]);
      if (m === "PUT" && !sm[2]) {
        send(res, 200, save(await read(), s.id));
        return true;
      }
      if (m === "POST" && sm[2] === "run") {
        send(res, 202, enqueue(s.id));
        return true;
      }
      if (m === "GET" && sm[2] === "pages") {
        send(
          res,
          200,
          db
            .prepare(
              "SELECT p.url,p.resource_id,p.synced,r.name FROM knowledge_source_pages p JOIN resources r ON r.id=p.resource_id WHERE source_id=? ORDER BY p.url",
            )
            .all(s.id),
        );
        return true;
      }
      if (m === "DELETE" && !sm[2]) {
        if (
          db
            .prepare(
              "SELECT id FROM knowledge_jobs WHERE source_id=? AND status IN ('queued','running')",
            )
            .get(s.id)
        )
          throw new HttpError(409, "请先取消未完成的任务");
        db.exec("SAVEPOINT remove_source");
        try {
          for (const r of db
            .prepare(
              "SELECT r.id,r.config FROM resources r JOIN knowledge_source_pages p ON p.resource_id=r.id WHERE p.source_id=?",
            )
            .all(s.id)) {
            const config = JSON.parse(r.config);
            delete config.sourceId;
            db.prepare("UPDATE resources SET config=? WHERE id=?").run(
              JSON.stringify(config),
              r.id,
            );
          }
          db.prepare("DELETE FROM knowledge_sources WHERE id=?").run(s.id);
          db.exec("RELEASE remove_source");
        } catch (e) {
          db.exec("ROLLBACK TO remove_source");
          db.exec("RELEASE remove_source");
          throw e;
        }
        send(res, 200, { ok: true, documentsRetained: true });
        return true;
      }
    }
    if (p === "/api/knowledge/jobs" && m === "GET") {
      send(
        res,
        200,
        db
          .prepare(
            "SELECT j.*,s.name source_name FROM knowledge_jobs j JOIN knowledge_sources s ON s.id=j.source_id ORDER BY j.created DESC,j.rowid DESC LIMIT 100",
          )
          .all()
          .map((r) => ({
            ...r,
            config: undefined,
            progress: JSON.parse(r.progress),
          })),
      );
      return true;
    }
    const jm = p.match(/^\/api\/knowledge\/jobs\/([^/]+)\/(cancel|retry)$/);
    if (jm && m === "POST") {
      const job = db
        .prepare("SELECT * FROM knowledge_jobs WHERE id=?")
        .get(jm[1]);
      if (!job) throw new HttpError(404, "任务不存在");
      send(
        res,
        jm[2] === "cancel" ? 200 : 202,
        jm[2] === "cancel" ? cancel(job.id) : enqueue(job.source_id),
      );
      return true;
    }
    const collection = p.match(/^\/api\/knowledge\/collections\/([^/]+)$/);
    if (
      collection &&
      m === "DELETE" &&
      db
        .prepare("SELECT id FROM knowledge_sources WHERE collection_id=?")
        .get(collection[1])
    )
      throw new HttpError(409, "该知识库仍有网站来源，请先移除来源");
    const resource = p.match(
      /^\/api\/(?:resources|knowledge)\/([^/]+)(?:\/sync)?$/,
    );
    if (
      resource &&
      ["PATCH", "DELETE", "POST"].includes(m) &&
      db
        .prepare(
          "SELECT source_id FROM knowledge_source_pages WHERE resource_id=?",
        )
        .get(resource[1])
    )
      throw new HttpError(
        409,
        "该页面由网站采集维护，请从网站来源中同步或调整；移除来源后可单独编辑",
      );
    return false;
  }
  return {
    handle,
    save,
    enqueue,
    cancel,
    tick,
    close() {
      closed = true;
      clearInterval(timer);
      for (const c of active.values()) c.abort();
    },
  };
}
