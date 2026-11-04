import { createAssistanceConsents } from "./assistance-consents.mjs";
import { createRepairs, repairOperations } from "./repairs.mjs";
import { randomUUID } from "node:crypto";
import { HttpError, canAccess } from "./management.mjs";
export const diagnosticCapabilities = [
  "basic",
  "status",
  "network",
  "logs",
  "routes",
];
export function createAssistance({
  db,
  clock = () => Date.now(),
  broadcast = () => {},
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS assistance_devices(conversation_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,capabilities TEXT NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS assistance_requests(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,device_id TEXT NOT NULL,capability TEXT NOT NULL,actor_id TEXT,reason TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,finished INTEGER,report TEXT,error TEXT);
CREATE INDEX IF NOT EXISTS assistance_conversation ON assistance_requests(conversation_id,created);`);
  if (
    !db
      .prepare("PRAGMA table_info(assistance_devices)")
      .all()
      .some((c) => c.name === "repair_capabilities")
  )
    db.exec(
      "ALTER TABLE assistance_devices ADD COLUMN repair_capabilities TEXT NOT NULL DEFAULT '[]'",
    );
  if (
    !db
      .prepare("PRAGMA table_info(assistance_devices)")
      .all()
      .some((c) => c.name === "route_options")
  )
    db.exec(
      "ALTER TABLE assistance_devices ADD COLUMN route_options TEXT NOT NULL DEFAULT '[]'",
    );
  for (const [name, type] of [
    ["consent_session_id", "TEXT NOT NULL DEFAULT ''"],
    ["consent_protocol", "INTEGER NOT NULL DEFAULT 0"],
  ])
    if (
      !db
        .prepare("PRAGMA table_info(assistance_devices)")
        .all()
        .some((c) => c.name === name)
    )
      db.exec(`ALTER TABLE assistance_devices ADD COLUMN ${name} ${type}`);
  if (
    !db
      .prepare("PRAGMA table_info(assistance_requests)")
      .all()
      .some((c) => c.name === "grant_id")
  )
    db.exec("ALTER TABLE assistance_requests ADD COLUMN grant_id TEXT");
  const deviceState = (id) => {
    const row = db
      .prepare("SELECT * FROM assistance_devices WHERE conversation_id=?")
      .get(id);
    return row
      ? {
          deviceId: row.device_id,
          capabilities: JSON.parse(row.capabilities),
          repairCapabilities: JSON.parse(row.repair_capabilities),
          routeOptions: JSON.parse(row.route_options),
          consentSessionId: row.consent_session_id,
          consentRequired: row.consent_protocol === 1,
          online: clock() - row.updated < 30000,
        }
      : null;
  };
  const consents = createAssistanceConsents({
    db,
    clock,
    getDevice: deviceState,
    broadcast,
  });
  const repairs = createRepairs({
    consents,
    db,
    clock,
    broadcast,
    getDevice: deviceState,
  });
  const purge = () =>
    db
      .prepare(
        "UPDATE assistance_requests SET report=NULL WHERE report IS NOT NULL AND finished<?",
      )
      .run(clock() - 7 * 86400000);
  purge();
  // Execution interrupted by a server restart is never retried automatically.
  db.prepare(
    "UPDATE assistance_requests SET status='unknown',error='服务重启，请重新请求诊断',finished=? WHERE status='running'",
  ).run(clock());
  const fail = (code, text) => {
    throw new HttpError(code, text);
  };
  function expire(id) {
    db.prepare(
      "UPDATE assistance_requests SET status='expired',finished=? WHERE conversation_id=? AND status IN ('pending','running') AND expires<=?",
    ).run(clock(), id, clock());
    db.prepare(
      "UPDATE assistance_requests SET report=NULL WHERE conversation_id=? AND finished<?",
    ).run(id, clock() - 7 * 86400000);
  }
  function state(id) {
    expire(id);
    if (
      db.prepare("SELECT status FROM conversations WHERE id=?").get(id)
        ?.status === "closed"
    )
      db.prepare(
        "UPDATE assistance_requests SET status='revoked',finished=? WHERE conversation_id=? AND status IN ('pending','running')",
      ).run(clock(), id);
    return {
      device: deviceState(id),
      consents: consents.state(id),
      repairs: repairs.state(id),
      requests: db
        .prepare(
          "SELECT * FROM assistance_requests WHERE conversation_id=? ORDER BY created DESC LIMIT 20",
        )
        .all(id)
        .map((r) => ({ ...r, report: r.report ? JSON.parse(r.report) : null })),
    };
  }
  function request(id, capability, reason, actorId = null) {
    expire(id);
    const c = db.prepare("SELECT status FROM conversations WHERE id=?").get(id);
    if (!c || c.status === "closed") fail(409, "会话已结束");
    const device = state(id).device;
    if (
      !device?.online ||
      !diagnosticCapabilities.includes(capability) ||
      !device.capabilities.includes(capability)
    )
      fail(409, "客户端未接入此诊断能力或已离线");
    const existing = db
      .prepare(
        "SELECT id FROM assistance_requests WHERE conversation_id=? AND capability=? AND status IN ('pending','running')",
      )
      .get(id, capability);
    if (existing) return { id: existing.id, status: "pending" };
    if (
      db
        .prepare(
          "SELECT count(*) n FROM assistance_requests WHERE conversation_id=? AND created>?",
        )
        .get(id, clock() - 60000).n >= 5
    )
      fail(429, "诊断请求过于频繁");
    const uid = randomUUID();
    db.prepare(
      "INSERT INTO assistance_requests(id,conversation_id,device_id,capability,actor_id,reason,status,created,expires,finished,report,error) VALUES(?,?,?,?,?,?,'pending',?,?,NULL,NULL,NULL)",
    ).run(
      uid,
      id,
      device.deviceId,
      capability,
      actorId,
      String(reason || "排查当前问题").slice(0, 300),
      clock(),
      clock() + 5 * 60000,
    );
    broadcast(id);
    return { id: uid, status: "pending" };
  }
  function cleanReport(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(400, "诊断报告格式无效");
    const text = JSON.stringify(value);
    if (text.length > 24000) fail(400, "诊断报告过长");
    // Do not accept arbitrary client settings or credentials as diagnostic fields.
    const allowed = [
      "summary",
      "appVersion",
      "osVersion",
      "platform",
      "connection",
      "kernel",
      "proxy",
      "tun",
      "checks",
      "logs",
    ];
    const safe = {};
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(400, "报告包含未允许的字段：" + key);
      safe[key] = value[key];
    }
    const redact = (v) => {
      if (typeof v === "string")
        return v
          .replace(/https?:\/\/[^\s"<>]+/gi, "[链接已隐藏]")
          .replace(
            /((?:token|password|secret|authorization|subscription|密码|密钥)\s*[:=]\s*)[^\s,;]+/gi,
            "$1[已隐藏]",
          )
          .slice(0, 8000);
      if (Array.isArray(v)) return v.slice(0, 100).map(redact);
      if (v && typeof v === "object")
        return Object.fromEntries(
          Object.entries(v)
            .slice(0, 30)
            .filter(
              ([k]) =>
                !/(token|password|secret|authorization|subscription|credential|密码|密钥)/i.test(
                  k,
                ),
            )
            .map(([k, x]) => [k, redact(x)]),
        );
      return v;
    };
    return redact(safe);
  }
  function visitor(id, method, b = {}) {
    if (method === "GET") return state(id);
    const op = b.action;
    if (op?.startsWith("scope_")) {
      consents.handle(id, b);
      return state(id);
    }
    if (op?.startsWith("repair_")) return repairs.visitor(id, b);
    if (op === "register") {
      if (
        typeof b.deviceId !== "string" ||
        !/^[-\w]{16,100}$/.test(b.deviceId) ||
        !Array.isArray(b.capabilities) ||
        b.capabilities.some((c) => !diagnosticCapabilities.includes(c)) ||
        (b.repairCapabilities !== undefined &&
          (!Array.isArray(b.repairCapabilities) ||
            b.repairCapabilities.some(
              (c) => !Object.hasOwn(repairOperations, c),
            ) ||
            (b.repairCapabilities.length &&
              ![2, 3].includes(b.repairProtocol))))
      )
        fail(400, "设备能力无效");
      if (
        b.consentProtocol !== undefined &&
        (b.consentProtocol !== 1 ||
          typeof b.consentSessionId !== "string" ||
          !/^[-\w]{40,100}$/.test(b.consentSessionId))
      )
        fail(400, "协助授权会话无效");
      const options = b.routeOptions || [];
      if (
        !Array.isArray(options) ||
        options.length > 3 ||
        new Set(options.map((o) => o?.id)).size !== options.length ||
        options.some(
          (o) =>
            !o ||
            typeof o.id !== "string" ||
            !/^[-\w]{1,80}$/.test(o.id) ||
            typeof o.label !== "string" ||
            !o.label.trim() ||
            o.label.length > 100 ||
            /https?:|[\r\n]/i.test(o.label),
        )
      )
        fail(400, "备用线路信息无效");
      if (
        b.repairCapabilities?.includes("switch_route") &&
        (b.repairProtocol !== 3 || !options.length)
      )
        fail(400, "切换线路需要协议3和明确的备用线路");
      const old = db
        .prepare(
          "SELECT device_id FROM assistance_devices WHERE conversation_id=?",
        )
        .get(id);
      if (old && old.device_id !== b.deviceId) {
        db.prepare(
          "UPDATE assistance_requests SET status='revoked',finished=? WHERE conversation_id=? AND status IN ('pending','running')",
        ).run(clock(), id);
      }
      db.prepare(
        "INSERT INTO assistance_devices(conversation_id,device_id,capabilities,updated,repair_capabilities,route_options,consent_session_id,consent_protocol) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET device_id=excluded.device_id,capabilities=excluded.capabilities,updated=excluded.updated,repair_capabilities=excluded.repair_capabilities,route_options=excluded.route_options,consent_session_id=excluded.consent_session_id,consent_protocol=excluded.consent_protocol",
      ).run(
        id,
        b.deviceId,
        JSON.stringify([...new Set(b.capabilities)]),
        clock(),
        JSON.stringify([...new Set(b.repairCapabilities || [])]),
        JSON.stringify(
          options.map((o) => ({ id: o.id, label: o.label.trim() })),
        ),
        b.consentSessionId || "",
        b.consentProtocol || 0,
      );
      return state(id);
    }
    const c = db.prepare("SELECT status FROM conversations WHERE id=?").get(id);
    if (c?.status === "closed" && op !== "revoke") fail(409, "会话已结束");
    const row = db
      .prepare(
        "SELECT * FROM assistance_requests WHERE id=? AND conversation_id=?",
      )
      .get(b.requestId, id);
    if (!row || row.device_id !== b.deviceId) fail(403, "诊断请求与设备不匹配");
    expire(id);
    const current = db
      .prepare("SELECT status FROM assistance_requests WHERE id=?")
      .get(row.id).status;
    if (op === "revoke") {
      if (!["pending", "running"].includes(current)) return state(id);
      db.prepare(
        "UPDATE assistance_requests SET status='revoked',finished=? WHERE id=?",
      ).run(clock(), row.id);
    } else if (op === "decline") {
      if (current !== "pending") fail(409, "请求状态已变化");
      db.prepare(
        "UPDATE assistance_requests SET status='declined',finished=? WHERE id=?",
      ).run(clock(), row.id);
    } else if (op === "accept") {
      if (current !== "pending") fail(409, "请求已处理或已过期");
      const grant = consents.require(id, b.grantId, "query", row.capability);
      db.prepare(
        "UPDATE assistance_requests SET status='running',expires=?,grant_id=? WHERE id=?",
      ).run(
        Math.min(clock() + 2 * 60000, grant?.expires || Infinity),
        grant?.id || null,
        row.id,
      );
    } else if (op === "result") {
      if (["succeeded", "failed"].includes(current)) return state(id); // HTTP result retry never re-executes the host operation.
      if (current !== "running") fail(409, "授权已失效，拒绝报告");
      if (row.grant_id)
        consents.require(id, row.grant_id, "query", row.capability);
      const report = b.error ? null : cleanReport(b.report);
      if (
        row.capability === "routes" &&
        report &&
        (!Array.isArray(report.checks) ||
          report.checks.length < 1 ||
          report.checks.length > 3)
      )
        fail(400, "线路检测仅允许返回1至3条已测线路");
      db.prepare(
        "UPDATE assistance_requests SET status=?,report=?,error=?,finished=? WHERE id=?",
      ).run(
        b.error ? "failed" : "succeeded",
        report ? JSON.stringify(report) : null,
        b.error ? String(b.error).slice(0, 300) : null,
        clock(),
        row.id,
      );
    } else fail(400, "未知协助操作");
    broadcast(id);
    return state(id);
  }
  async function handle({ req, res, url, u, body, send }) {
    const match = url.pathname.match(
      /^\/api\/conversations\/([^/]+)\/assistance$/,
    );
    if (!match) return false;
    const c = db
      .prepare("SELECT * FROM conversations WHERE id=?")
      .get(match[1]);
    if (!c || !canAccess(u, c)) fail(403, "无权访问此会话");
    if (req.method === "GET") send(res, 200, state(c.id));
    else if (req.method === "POST") {
      const b = await body(req);
      send(
        res,
        201,
        b.kind === "repair"
          ? repairs.request(
              c.id,
              b.operation,
              b.reason,
              u.id,
              b.restoreRequestId,
              b.targetRouteId,
            )
          : request(c.id, b.capability, b.reason, u.id),
      );
    } else fail(405, "不支持的请求");
    return true;
  }
  return {
    state,
    request,
    visitor,
    handle,
    purge,
    requestRepair: repairs.request,
  };
}
