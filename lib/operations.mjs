import { randomUUID } from "node:crypto";
import { createBackups } from "./backups.mjs";
import { HttpError, assertConversationAccess } from "./management.mjs";
import { indexKnowledge } from "./features.mjs";
export function createOperations({
  db,
  dbPath,
  revision,
  version,
  push,
  userPush,
  service,
  presence,
  assistance,
  broadcast,
  clock = Date.now,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS operational_events(id TEXT PRIMARY KEY,event TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_outcomes(conversation_id TEXT PRIMARY KEY,resolved INTEGER NOT NULL,actor_id TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_candidates(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,question TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'pending',created_by TEXT NOT NULL,created TEXT NOT NULL,resource_id TEXT,reviewed_by TEXT,reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS readiness_probe(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);`);
  for (const column of ["reviewed_by", "reviewed_at"])
    if (
      !db
        .prepare("PRAGMA table_info(knowledge_candidates)")
        .all()
        .some((c) => c.name === column)
    )
      db.exec(`ALTER TABLE knowledge_candidates ADD COLUMN ${column} TEXT`);
  const record = (event, status) =>
    db
      .prepare("INSERT INTO operational_events VALUES(?,?,?,?)")
      .run(randomUUID(), event, status, new Date(clock()).toISOString());
  const backups = createBackups({
    db,
    dbPath,
    onResult: (r) => record("backup", r.ok ? "succeeded" : "failed"),
  });
  let probeAt = 0,
    probeReady = false;
  function ready() {
    if (clock() - probeAt < 1000) return probeReady;
    probeAt = clock();
    try {
      db.prepare(
        "INSERT INTO readiness_probe VALUES(1,1) ON CONFLICT(id) DO UPDATE SET value=value+1",
      ).run();
      return (probeReady = true);
    } catch {
      return (probeReady = false);
    }
  }
  function queue(prefix) {
    return {
      states: db
        .prepare(
          `SELECT state,count(*) count FROM ${prefix}_jobs GROUP BY state`,
        )
        .all(),
      events: db.prepare(`SELECT count(*) n FROM ${prefix}_events`).get().n,
      failures: db
        .prepare(
          `SELECT reason,count(*) count FROM ${prefix}_jobs WHERE state='failed' GROUP BY reason ORDER BY count(*) DESC LIMIT 10`,
        )
        .all(),
    };
  }
  function status() {
    return {
      version,
      revision,
      uptimeSeconds: Math.floor(process.uptime()),
      port: Number(process.env.PORT || 4310),
      database: {
        ready: ready(),
        journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
      },
      push: {
        staff: push.configuration(),
        user: userPush.configuration(),
        staffQueue: queue("push"),
        userQueue: queue("user_push"),
      },
      agents: db
        .prepare(
          "SELECT id,name,availability,capacity FROM users WHERE active=1",
        )
        .all()
        .map((u) => ({ ...u, online: presence.online(u.id) })),
      backups: {
        items: backups.list(),
        busy: backups.busy,
        lastResult:
          db
            .prepare(
              "SELECT status,created FROM operational_events WHERE event='backup' ORDER BY rowid DESC LIMIT 1",
            )
            .get() || null,
      },
      recentEvents: db
        .prepare(
          "SELECT event,status,created FROM operational_events ORDER BY rowid DESC LIMIT 20",
        )
        .all(),
    };
  }
  function summary(c) {
    const visitor = db
      .prepare("SELECT name,email,profile FROM visitors WHERE id=?")
      .get(c.visitor_id);
    const profile = JSON.parse(visitor?.profile || "{}");
    const known = {};
    for (const k of ["platform", "os", "device", "appVersion", "language"])
      if (profile[k]) known[k] = profile[k];
    for (const k of ["os", "client_version"])
      if (profile.custom?.[k]) known[k] = profile.custom[k];
    const consents = assistance.state(c.id).consents;
    return {
      conversationId: c.id,
      consents,
      handoffReason: c.handoff_reason || "",
      visitor: { name: visitor?.name, email: visitor?.email, device: known },
      assignment: service.assignment(c.id),
      questions: db
        .prepare(
          "SELECT body,created FROM messages WHERE conversation_id=? AND role='visitor' ORDER BY created DESC,rowid DESC LIMIT 3",
        )
        .all(c.id)
        .reverse()
        .map((m) => ({ ...m, body: m.body?.slice(0, 1000) })),
      diagnostics: db
        .prepare(
          "SELECT capability,status,created,finished,report FROM assistance_requests WHERE conversation_id=? ORDER BY created DESC LIMIT 5",
        )
        .all(c.id)
        .map((r) => {
          let report = {};
          try {
            report = JSON.parse(r.report || "{}");
          } catch {}
          return {
            ...r,
            report: undefined,
            summary:
              typeof report.summary === "string"
                ? report.summary.slice(0, 1000)
                : null,
          };
        }),
      repairs: db
        .prepare(
          "SELECT operation,status,created,finished,result FROM assistance_repairs WHERE conversation_id=? ORDER BY created DESC LIMIT 5",
        )
        .all(c.id)
        .map((r) => {
          let result = {};
          try {
            result = JSON.parse(r.result || "{}");
          } catch {}
          return {
            ...r,
            result: {
              outcome: result.outcome || null,
              rollback: result.rollback || null,
              verified: result.verified === true,
              summary:
                typeof result.summary === "string"
                  ? result.summary.slice(0, 1000)
                  : null,
            },
          };
        }),
      outcome:
        db
          .prepare(
            "SELECT resolved,updated FROM conversation_outcomes WHERE conversation_id=?",
          )
          .get(c.id) || null,
    };
  }
  function metrics(days) {
    const since = new Date(clock() - days * 86400000).toISOString();
    const total = db
      .prepare("SELECT count(*) n FROM conversations WHERE created>=?")
      .get(since).n;
    const waits = db
      .prepare(
        "SELECT c.id,coalesce(nullif(c.queue_started,''),min(m.created)) firstMessage FROM conversations c JOIN messages m ON m.conversation_id=c.id AND m.role='visitor' WHERE c.assignee='' AND c.status!='closed' AND c.automation_mode='human' AND c.handoff_pending=1 GROUP BY c.id",
      )
      .all();
    const response = db
      .prepare(
        `SELECT avg((julianday(reply)-julianday(firstMessage))*86400) seconds,count(*) samples FROM (SELECT (SELECT min(created) FROM messages WHERE conversation_id=c.id AND role='visitor') firstMessage,(SELECT min(created) FROM messages WHERE conversation_id=c.id AND role='agent' AND coalesce(source,'manual') IN ('manual','telegram') AND created>=(SELECT min(created) FROM messages WHERE conversation_id=c.id AND role='visitor')) reply FROM conversations c WHERE created>=?) WHERE reply IS NOT NULL AND firstMessage IS NOT NULL`,
      )
      .get(since);
    const firstReply = db
      .prepare(
        `SELECT avg((julianday(reply)-julianday(firstMessage))*86400) seconds,count(*) samples FROM (SELECT (SELECT min(created) FROM messages WHERE conversation_id=c.id AND role='visitor') firstMessage,(SELECT min(created) FROM messages WHERE conversation_id=c.id AND role='agent' AND coalesce(source,'manual') IN ('manual','telegram','ai') AND created>=(SELECT min(created) FROM messages WHERE conversation_id=c.id AND role='visitor')) reply FROM conversations c WHERE created>=?) WHERE reply IS NOT NULL AND firstMessage IS NOT NULL`,
      )
      .get(since);
    const aiCohort = db
      .prepare(
        `SELECT count(*) total,coalesce(sum(CASE WHEN EXISTS(SELECT 1 FROM audit_logs a WHERE a.target_id=c.id AND a.action='service.handoff' AND a.created>=(SELECT min(created) FROM auto_runs WHERE conversation_id=c.id) AND coalesce(json_extract(a.details,'$.reason'),'') NOT IN ('人工接待自动分配','人工优先自动分配')) THEN 1 ELSE 0 END),0) transferred FROM conversations c WHERE c.created>=? AND EXISTS(SELECT 1 FROM auto_runs WHERE conversation_id=c.id)`,
      )
      .get(since);
    const outcomes = db
      .prepare(
        "SELECT count(*) recorded,coalesce(sum(o.resolved),0) resolved FROM conversation_outcomes o JOIN conversations c ON c.id=o.conversation_id WHERE c.created>=?",
      )
      .get(since);
    const usage = db
      .prepare(
        "SELECT count(*) requests,coalesce(sum(input_tokens),0) inputTokens,coalesce(sum(output_tokens),0) outputTokens,sum(cost) cost,count(cost) pricedRequests FROM ai_usage WHERE created>=?",
      )
      .get(since);
    usage.costByCurrency = db
      .prepare(
        "SELECT currency,sum(cost) cost,count(*) requests FROM ai_usage WHERE created>=? AND cost IS NOT NULL GROUP BY currency",
      )
      .all(since);
    delete usage.cost;
    const handoffs = db
      .prepare(
        "SELECT count(DISTINCT target_id) n FROM audit_logs WHERE action='service.handoff' AND created>=?",
      )
      .get(since).n;
    return {
      days,
      totalConversations: total,
      firstHumanReply: response,
      firstReply,
      aiHandoff: {
        total: aiCohort.total,
        transferred: aiCohort.transferred,
        rate: aiCohort.total ? aiCohort.transferred / aiCohort.total : null,
      },
      waiting: {
        count: waits.length,
        oldestSeconds: Math.max(
          0,
          ...waits.map((w) =>
            Math.floor((clock() - Date.parse(w.firstMessage)) / 1000),
          ),
        ),
      },
      outcomes: {
        ...outcomes,
        resolutionRate: outcomes.recorded
          ? outcomes.resolved / outcomes.recorded
          : null,
        source: "staff_recorded",
      },
      handoffs,
      ai: usage,
    };
  }
  async function handle({ req, res, url, u, body, send }) {
    const p = url.pathname,
      m = req.method;
    const conversationPath = p.match(
      /^\/api\/conversations\/([^/]+)\/(assignment|handover|outcome|knowledge-candidate)$/,
    );
    if (conversationPath) {
      const c = db
        .prepare("SELECT * FROM conversations WHERE id=?")
        .get(conversationPath[1]);
      if (!c) throw new HttpError(404, "会话不存在");
      assertConversationAccess(u, c);
      const type = conversationPath[2];
      if (m === "GET" && ["assignment", "handover"].includes(type)) {
        send(
          res,
          200,
          type === "assignment" ? service.assignment(c.id) : summary(c),
        );
        return true;
      }
      if (m !== "POST" || !["outcome", "knowledge-candidate"].includes(type))
        throw new HttpError(405, "不支持的请求方法");
      const b = await body(req);
      if (type === "outcome") {
        if (typeof b.resolved !== "boolean")
          throw new HttpError(400, "请选择是否解决");
        db.prepare(
          "INSERT INTO conversation_outcomes VALUES(?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET resolved=excluded.resolved,actor_id=excluded.actor_id,updated=excluded.updated",
        ).run(c.id, b.resolved ? 1 : 0, u.id, new Date(clock()).toISOString());
        record("outcome", "recorded");
      } else {
        const question = String(b.question || c.subject || "").trim(),
          answer = String(b.answer || "").trim();
        if (!question || question.length > 2000 || answer.length > 12000)
          throw new HttpError(400, "问题或答案长度无效");
        const existing = db
          .prepare(
            "SELECT id FROM knowledge_candidates WHERE conversation_id=? AND state='pending'",
          )
          .get(c.id);
        if (existing) {
          send(res, 200, { id: existing.id });
          return true;
        }
        const id = randomUUID();
        db.prepare(
          "INSERT INTO knowledge_candidates(id,conversation_id,question,answer,created_by,created) VALUES(?,?,?,?,?,?)",
        ).run(
          id,
          c.id,
          question,
          answer,
          u.id,
          new Date(clock()).toISOString(),
        );
        send(res, 201, { id });
        return true;
      }
      send(res, 200, { ok: true });
      broadcast(c.id);
      return true;
    }
    if (!p.startsWith("/api/operations")) return false;
    if (u.role !== "admin") throw new HttpError(403, "仅管理员可访问运行管理");
    if (p === "/api/operations/alerts" && m === "GET") {
      send(res, 200, {
        backup:
          db
            .prepare(
              "SELECT id,status,created FROM operational_events WHERE event='backup' ORDER BY rowid DESC LIMIT 1",
            )
            .get() || null,
      });
      return true;
    }
    if (p === "/api/operations/status" && m === "GET") {
      send(res, 200, status());
      return true;
    }
    if (p === "/api/operations/metrics" && m === "GET") {
      const days = Number(url.searchParams.get("days") || 30);
      if (![7, 30, 90].includes(days)) throw new HttpError(400, "统计范围无效");
      send(res, 200, metrics(days));
      return true;
    }
    if (p === "/api/operations/backups" && m === "POST") {
      send(res, 201, await backups.run());
      return true;
    }
    const verification = p.match(
      /^\/api\/operations\/backups\/(backup-[\w-]+)\/verify$/,
    );
    if (verification && m === "POST") {
      try {
        const result = backups.verify(verification[1]);
        record("backup.verify", "succeeded");
        send(res, 200, { ok: true, created: result.created });
      } catch {
        record("backup.verify", "failed");
        throw new HttpError(409, "备份校验失败，请检查服务端备份文件");
      }
      return true;
    }
    if (p === "/api/operations/knowledge-candidates" && m === "GET") {
      send(res, 200, {
        items: db
          .prepare(
            "SELECT * FROM knowledge_candidates ORDER BY created DESC LIMIT 100",
          )
          .all(),
      });
      return true;
    }
    const candidate = p.match(
      /^\/api\/operations\/knowledge-candidates\/([^/]+)$/,
    );
    if (candidate && m === "POST") {
      const row = db
        .prepare("SELECT * FROM knowledge_candidates WHERE id=?")
        .get(candidate[1]);
      if (!row) throw new HttpError(404, "待审核条目不存在");
      const b = await body(req);
      if (!["approve", "reject"].includes(b.action))
        throw new HttpError(400, "审核操作无效");
      if (row.state !== "pending") {
        if (b.action === "approve" && row.state === "approved") {
          send(res, 200, { ok: true, resourceId: row.resource_id });
          return true;
        }
        throw new HttpError(409, "条目已经审核");
      }
      const question = String(b.question ?? row.question).trim(),
        answer = String(b.answer ?? row.answer).trim();
      if (
        !question ||
        question.length > 2000 ||
        answer.length > 12000 ||
        (b.action === "approve" && !answer)
      )
        throw new HttpError(400, "请填写有效的问题和经过审核的答案");
      const collection = b.collectionId || "default";
      if (!db.prepare("SELECT id FROM collections WHERE id=?").get(collection))
        throw new HttpError(400, "知识库不存在");
      db.exec("SAVEPOINT approve_candidate");
      let resourceId = null;
      try {
        if (b.action === "approve") {
          resourceId = randomUUID();
          db.prepare(
            "INSERT INTO resources(id,kind,name,description,config,created) VALUES(?,'knowledge',?,?,?,?)",
          ).run(
            resourceId,
            question.slice(0, 200),
            "问题：" + question + "\n答案：" + answer,
            JSON.stringify({
              collectionId: collection,
              source: "reviewed_conversation",
            }),
            new Date(clock()).toISOString(),
          );
          indexKnowledge(db, resourceId);
        }
        db.prepare(
          "UPDATE knowledge_candidates SET state=?,question=?,answer=?,resource_id=?,reviewed_by=?,reviewed_at=? WHERE id=?",
        ).run(
          b.action === "approve" ? "approved" : "rejected",
          question,
          answer,
          resourceId,
          u.id,
          new Date(clock()).toISOString(),
          row.id,
        );
        record("knowledge.review", b.action);
        db.exec("RELEASE approve_candidate");
      } catch (e) {
        db.exec("ROLLBACK TO approve_candidate; RELEASE approve_candidate");
        throw e;
      }
      broadcast();
      send(res, 200, { ok: true, resourceId });
      return true;
    }
    throw new HttpError(404, "运行管理接口不存在");
  }
  let lastBackupAttempt = 0;
  const timer = setInterval(() => {
    presence.purge();
    db.prepare("DELETE FROM operational_events WHERE created<?").run(
      new Date(clock() - 90 * 86400000).toISOString(),
    );
    const latest = backups.list()[0];
    if (
      !backups.busy &&
      clock() - lastBackupAttempt >= 3600000 &&
      (!latest || clock() - Date.parse(latest.created) >= 86400000)
    ) {
      lastBackupAttempt = clock();
      backups.run().catch(() => {});
    }
  }, 60000);
  timer.unref();
  return {
    ready,
    status,
    metrics,
    handle,
    record,
    close: () => clearInterval(timer),
  };
}
