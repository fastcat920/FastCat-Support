import { isIP } from "node:net";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./management.mjs";
export function clientAddress(req, trust = process.env.TRUST_PROXY) {
  const remote = req.socket.remoteAddress || "unknown";
  if (
    trust !== "loopback" ||
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)
  )
    return remote;
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .at(-1)
    .trim();
  return isIP(forwarded) ? forwarded : remote;
}
export function createLimiter({ clock = Date.now, maxKeys = 10000 } = {}) {
  const buckets = new Map();
  return function limit(key, count, window = 60000) {
    const now = clock();
    let b = buckets.get(key);
    if (!b || b.until <= now) {
      for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k);
      if (buckets.size >= maxKeys && !buckets.has(key))
        throw new HttpError(429, "请求过于频繁，请稍后重试");
      b = { used: 0, until: now + window };
      buckets.set(key, b);
    }
    if (++b.used > count) {
      const e = new HttpError(429, "请求过于频繁，请稍后重试");
      e.retryAfter = Math.max(1, Math.ceil((b.until - now) / 1000));
      throw e;
    }
  };
}
export function createPresence(db, { clock = Date.now, ttl = 75000 } = {}) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS staff_presence(session_token TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS staff_presence_user ON staff_presence(user_id,expires)",
  );
  return {
    touch(userId, token) {
      if (!token) return;
      db.prepare(
        "INSERT INTO staff_presence VALUES(?,?,?) ON CONFLICT(session_token) DO UPDATE SET expires=excluded.expires",
      ).run(token, userId, clock() + ttl);
    },
    drop(token) {
      db.prepare("DELETE FROM staff_presence WHERE session_token=?").run(token);
    },
    online(userId) {
      return !!db
        .prepare(
          "SELECT 1 FROM staff_presence p JOIN sessions s ON s.token=p.session_token AND s.user_id=p.user_id WHERE p.user_id=? AND p.expires>? AND s.expires>? LIMIT 1",
        )
        .get(userId, clock(), clock());
    },
    purge() {
      db.prepare(
        "DELETE FROM staff_presence WHERE expires<=? OR session_token NOT IN (SELECT token FROM sessions WHERE expires>?)",
      ).run(clock(), clock());
    },
  };
}
export function createVisitorSessions(
  db,
  { secret = process.env.VISITOR_IDENTITY_SECRET, clock = Date.now } = {},
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS visitor_bindings(binding_hash TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,updated INTEGER NOT NULL)",
  );
  function binding(input, channel) {
    if (!input.identityToken) return null;
    if (!secret || Buffer.byteLength(secret) < 32)
      throw new HttpError(503, "未配置访客身份签名密钥");
    try {
      if (
        typeof input.identityToken !== "string" ||
        input.identityToken.length > 4096 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
          input.identityToken,
        )
      )
        throw Error();
      const [header, payload, signature, extra] =
        input.identityToken.split(".");
      const expected = createHmac("sha256", secret)
        .update(header + "." + payload)
        .digest();
      const actual = Buffer.from(signature || "", "base64url");
      if (
        extra ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw Error();
      const h = JSON.parse(Buffer.from(header, "base64url")),
        c = JSON.parse(Buffer.from(payload, "base64url"));
      const now = Math.floor(clock() / 1000);
      if (
        h.alg !== "HS256" ||
        typeof c.sub !== "string" ||
        !c.sub.trim() ||
        c.sub.length > 200 ||
        !Number.isFinite(c.exp) ||
        c.exp <= now ||
        c.exp > now + 3600 ||
        !Number.isFinite(c.iat) ||
        c.iat > now + 60 ||
        c.iat < now - 3600 ||
        c.exp - c.iat > 3600 ||
        c.appKey !== channel.public_key ||
        typeof c.deviceId !== "string" ||
        !/^[\w-]{16,128}$/.test(c.deviceId) ||
        c.deviceId !== input.deviceId ||
        (c.email &&
          c.email.toLowerCase() !== String(input.email).trim().toLowerCase())
      )
        throw Error();
      return createHash("sha256")
        .update(JSON.stringify([channel.id, c.sub, c.deviceId]))
        .digest("hex");
    } catch {
      throw new HttpError(401, "访客身份凭据无效或已过期");
    }
  }
  return {
    binding,
    find(key) {
      return (
        key &&
        db
          .prepare(
            "SELECT c.*,v.token FROM visitor_bindings b JOIN conversations c ON c.id=b.conversation_id JOIN visitors v ON v.id=c.visitor_id WHERE b.binding_hash=?",
          )
          .get(key)
      );
    },
    save(key, id) {
      if (key)
        db.prepare(
          "INSERT INTO visitor_bindings VALUES(?,?,?) ON CONFLICT(binding_hash) DO UPDATE SET conversation_id=excluded.conversation_id,updated=excluded.updated",
        ).run(key, id, clock());
    },
  };
}
export function requestLog(event, fields = {}) {
  // Never serialize request bodies, URLs, cookies, credentials, or raw errors.
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }),
  );
}
