import { randomUUID } from "node:crypto";
import { HttpError } from "./management.mjs";
export function createAssistanceConsents({
  db,
  clock = () => Date.now(),
  getDevice,
  broadcast = () => {},
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS assistance_consents(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,device_id TEXT NOT NULL,session_id TEXT NOT NULL,scope TEXT NOT NULL,capabilities TEXT NOT NULL,routes TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER);
 CREATE INDEX IF NOT EXISTS assistance_consent_scope ON assistance_consents(conversation_id,device_id,scope);`);
  const fail = (s) => {
    throw new HttpError(403, s);
  };
  function state(id) {
    const d = getDevice(id);
    const closed =
      db.prepare("SELECT status FROM conversations WHERE id=?").get(id)
        ?.status === "closed";
    const result = { query: null, operation: null };
    for (const r of db
      .prepare(
        "SELECT * FROM assistance_consents WHERE conversation_id=? AND revoked IS NULL ORDER BY created DESC,rowid DESC",
      )
      .all(id)) {
      if (
        closed ||
        r.expires <= clock() ||
        r.device_id !== d?.deviceId ||
        r.session_id !== d?.consentSessionId
      ) {
        db.prepare("UPDATE assistance_consents SET revoked=? WHERE id=?").run(
          clock(),
          r.id,
        );
        continue;
      }
      if (!result[r.scope])
        result[r.scope] = {
          id: r.id,
          scope: r.scope,
          capabilities: JSON.parse(r.capabilities),
          routes: JSON.parse(r.routes),
          expires: r.expires,
        };
    }
    db.prepare(
      "UPDATE assistance_requests SET status='revoked',finished=? WHERE conversation_id=? AND status='running' AND grant_id IN (SELECT id FROM assistance_consents WHERE revoked IS NOT NULL)",
    ).run(clock(), id);
    return result;
  }
  function require(id, grantId, scope, capability, target = null) {
    const d = getDevice(id);
    if (!d?.consentRequired && !grantId) return null; // Legacy SDK continues explicit per-request consent, never automatic execution.
    const grant = state(id)[scope];
    if (
      !grant ||
      grant.id !== grantId ||
      !grant.capabilities.includes(capability) ||
      (target &&
        !grant.routes.some(
          (r) => r.id === target.id && r.label === target.label,
        ))
    )
      fail("本次协助授权未开启、已到期或不包含此能力");
    return grant;
  }
  function handle(id, b) {
    const d = getDevice(id);
    if (
      !d ||
      d.deviceId !== b.deviceId ||
      d.consentSessionId !== b.consentSessionId
    ) {
      if (b.action === "scope_end") return state(id);
      fail("授权与当前设备或协助会话不匹配");
    }
    if (b.action === "scope_end") {
      db.prepare(
        "UPDATE assistance_consents SET revoked=? WHERE conversation_id=? AND device_id=? AND session_id=? AND revoked IS NULL",
      ).run(clock(), id, b.deviceId, b.consentSessionId);
    } else {
      if (!["query", "operation"].includes(b.scope)) fail("授权类别无效");
      if (b.action === "scope_decline") {
        const table =
          b.scope === "query" ? "assistance_requests" : "assistance_repairs";
        db.prepare(
          `UPDATE ${table} SET status='declined',finished=? WHERE conversation_id=? AND device_id=? AND status='pending'`,
        ).run(clock(), id, b.deviceId);
      } else if (b.action === "scope_revoke")
        db.prepare(
          "UPDATE assistance_consents SET revoked=? WHERE conversation_id=? AND device_id=? AND session_id=? AND scope=? AND revoked IS NULL",
        ).run(clock(), id, b.deviceId, b.consentSessionId, b.scope);
      else if (b.action === "scope_grant") {
        if (
          !d.consentRequired ||
          !d.online ||
          db.prepare("SELECT status FROM conversations WHERE id=?").get(id)
            ?.status === "closed"
        )
          fail("当前会话不能授权");
        const capabilities =
          b.scope === "query" ? d.capabilities : d.repairCapabilities;
        if (!capabilities.length) fail("当前客户端未提供此类能力");
        const routes = b.scope === "operation" ? d.routeOptions : [];
        const old = state(id)[b.scope];
        if (
          old &&
          JSON.stringify([...old.capabilities].sort()) ===
            JSON.stringify([...capabilities].sort()) &&
          JSON.stringify(
            [...old.routes].sort((a, b) => a.id.localeCompare(b.id)),
          ) ===
            JSON.stringify([...routes].sort((a, b) => a.id.localeCompare(b.id)))
        )
          return state(id); // Heartbeats/repeated clicks do not extend the deadline.
        db.prepare(
          "UPDATE assistance_consents SET revoked=? WHERE conversation_id=? AND scope=? AND revoked IS NULL",
        ).run(clock(), id, b.scope);
        db.prepare(
          "INSERT INTO assistance_consents VALUES(?,?,?,?,?,?,?,?,?,NULL)",
        ).run(
          randomUUID(),
          id,
          d.deviceId,
          d.consentSessionId,
          b.scope,
          JSON.stringify(capabilities),
          JSON.stringify(routes),
          clock(),
          clock() + 30 * 60000,
        );
      } else fail("未知授权操作");
    }
    broadcast(id);
    return state(id);
  }
  return { state, require, handle };
}
