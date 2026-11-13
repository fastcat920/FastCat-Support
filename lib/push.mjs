import { pushEvents } from "./push-events.mjs";
import http2 from "node:http2";
import { readFileSync } from "node:fs";
import { sign } from "node:crypto";
import { HttpError } from "./management.mjs";

export function createAPNs(env = process.env) {
  const configured = !!(
    env.APNS_KEY_FILE &&
    env.APNS_KEY_ID &&
    env.APNS_TEAM_ID &&
    env.APNS_TOPIC
  );
  let jwt = "",
    issued = 0;
  return {
    configured,
    async send(device, payload) {
      if (!configured) throw Error("APNs not configured");
      if (Date.now() - issued > 45 * 60000) jwt = "";
      if (!jwt) {
        const encode = (value) =>
          Buffer.from(JSON.stringify(value)).toString("base64url");
        const value =
          encode({ alg: "ES256", kid: env.APNS_KEY_ID }) +
          "." +
          encode({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) });
        jwt =
          value +
          "." +
          sign("sha256", Buffer.from(value), {
            key: readFileSync(env.APNS_KEY_FILE),
            dsaEncoding: "ieee-p1363",
          }).toString("base64url");
        issued = Date.now();
      }
      return new Promise((resolve, reject) => {
        const connection = http2.connect(
          device.environment === "sandbox"
            ? "https://api.sandbox.push.apple.com"
            : "https://api.push.apple.com",
        );
        const timer = setTimeout(() => finish(Error("APNs timeout")), 15000);
        let settled = false;
        function finish(error, result) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          connection.destroy();
          error ? reject(error) : resolve(result);
        }
        connection.on("error", (error) => finish(error));
        connection.on("connect", () => {
          const request = connection.request({
            ":method": "POST",
            ":path": "/3/device/" + device.token,
            authorization: "bearer " + jwt,
            "apns-topic": env.APNS_TOPIC,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
          });
          let status = 0,
            data = "";
          request.on(
            "response",
            (headers) => (status = Number(headers[":status"])),
          );
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            if (data.length < 4096) data += chunk;
          });
          request.on("error", (error) => finish(error));
          request.on("end", () => {
            let reason;
            try {
              reason = JSON.parse(data).reason;
            } catch {}
            finish(null, { status, reason });
          });
          request.end(JSON.stringify(payload));
        });
      });
    },
  };
}
export function createPush(
  db,
  { transport = createAPNs(), clock = Date.now } = {},
) {
  db.exec(`CREATE TABLE IF NOT EXISTS push_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,session_token TEXT NOT NULL,token TEXT NOT NULL UNIQUE,environment TEXT NOT NULL,language TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,active_conversation TEXT,foreground_until INTEGER DEFAULT 0,updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS push_jobs(message_id TEXT NOT NULL,device_id TEXT NOT NULL,user_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL,reason TEXT,created INTEGER NOT NULL,PRIMARY KEY(message_id,device_id));
CREATE TABLE IF NOT EXISTS push_seen(message_id TEXT PRIMARY KEY);
CREATE INDEX IF NOT EXISTS push_due ON push_jobs(state,next_attempt);`);
  const events = pushEvents(db, "push", "visitor");
  const eligible = (u, c) =>
    !!u?.active &&
    (c.assignee ? c.assignee === u.id : ["admin", "agent"].includes(u.role));
  function unread(u) {
    return db
      .prepare(
        "SELECT count(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.role='visitor' AND m.read_at IS NULL AND (c.assignee=? OR (coalesce(c.assignee,'')='' AND ? IN ('admin','agent')))",
      )
      .get(u.id, u.role).n;
  }
  function observe(id) {
    if (!id) return;
    const c = db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
    if (!c) {
      events.complete(id);
      return;
    }
    const rows = db
      .prepare(
        "SELECT m.id FROM messages m JOIN push_events e ON e.message_id=m.id LEFT JOIN push_seen s ON s.message_id=m.id WHERE m.conversation_id=? AND m.role='visitor' AND s.message_id IS NULL",
      )
      .all(id);
    events.transaction(() => {
      for (const m of rows) {
        db.prepare("INSERT OR IGNORE INTO push_seen VALUES(?)").run(m.id);
        for (const d of db
          .prepare(
            "SELECT d.*,u.role,u.active FROM push_devices d JOIN users u ON u.id=d.user_id JOIN sessions s ON s.token=d.session_token AND s.user_id=d.user_id WHERE d.enabled=1 AND s.expires>?",
          )
          .all(clock())) {
          if (!eligible({ id: d.user_id, role: d.role, active: d.active }, c))
            continue;
          if (d.active_conversation === id && d.foreground_until > clock())
            continue;
          db.prepare(
            "INSERT OR IGNORE INTO push_jobs(message_id,device_id,user_id,next_attempt,created) VALUES(?,?,?,?,?)",
          ).run(m.id, d.id, d.user_id, clock(), clock());
        }
      }
      events.complete(id);
    });
  }

  let busy = false;
  async function drain() {
    if (busy) return;
    busy = true;
    try {
      events.reconcile(observe);
      if (!transport.configured) return;
      for (const job of db
        .prepare(
          "SELECT * FROM push_jobs WHERE state='pending' AND next_attempt<=? ORDER BY created LIMIT 20",
        )
        .all(clock())) {
        const d = db
          .prepare(
            "SELECT * FROM push_devices WHERE id=? AND user_id=? AND enabled=1",
          )
          .get(job.device_id, job.user_id);
        const u = db.prepare("SELECT * FROM users WHERE id=?").get(job.user_id);
        const m = db
          .prepare("SELECT * FROM messages WHERE id=?")
          .get(job.message_id);
        const c =
          m &&
          db
            .prepare("SELECT * FROM conversations WHERE id=?")
            .get(m.conversation_id);
        const valid =
          d &&
          db
            .prepare(
              "SELECT token FROM sessions WHERE token=? AND user_id=? AND expires>?",
            )
            .get(d.session_token, job.user_id, clock());
        const stop = (reason) =>
          db
            .prepare(
              "UPDATE push_jobs SET state='skipped',reason=? WHERE message_id=? AND device_id=?",
            )
            .run(reason, job.message_id, job.device_id);
        if (
          !valid ||
          !c ||
          !eligible(u, c) ||
          m.read_at ||
          clock() - job.created > 3600000
        ) {
          stop("No longer eligible");
          continue;
        }
        if (d.active_conversation === c.id && d.foreground_until > clock()) {
          stop("Viewing conversation");
          continue;
        }
        const en = d.language === "en";
        let result;
        try {
          result = await transport.send(d, {
            aps: {
              alert: {
                title: "FastCat Support",
                body: en
                  ? "You have a new customer message"
                  : "收到一条新的访客消息",
              },
              sound: "default",
              badge: unread(u),
              "thread-id": c.id,
            },
            type: "conversation.message",
            conversationId: c.id,
            messageId: m.id,
          });
        } catch {
          result = { status: 0, reason: "TransportError" };
        }
        const permanent = [400, 410, 413].includes(result.status);
        if (
          result.status === 410 ||
          (result.status === 400 &&
            ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(
              result.reason,
            ))
        )
          db.prepare(
            "UPDATE push_devices SET enabled=0 WHERE id=? AND token=?",
          ).run(d.id, d.token);
        const attempts = job.attempts + 1;
        db.prepare(
          "UPDATE push_jobs SET state=?,attempts=?,next_attempt=?,reason=? WHERE message_id=? AND device_id=?",
        ).run(
          result.status === 200
            ? "sent"
            : permanent || attempts >= 5
              ? "failed"
              : "pending",
          attempts,
          clock() + Math.min(300000, 5000 * 2 ** attempts),
          result.reason || null,
          job.message_id,
          job.device_id,
        );
      }
      db.prepare("DELETE FROM push_jobs WHERE created<?").run(
        clock() - 7 * 86400000,
      );
    } finally {
      busy = false;
    }
  }
  async function handle({ req, res, url, u, body, send, sessionToken }) {
    if (!url.pathname.startsWith("/api/push/")) return false;
    if (url.pathname === "/api/push/status" && req.method === "GET") {
      send(res, 200, {
        configured: transport.configured,
        provider: "apns",
        unreadCount: unread(u),
      });
      return true;
    }
    if (
      url.pathname !== "/api/push/device" ||
      !["PUT", "DELETE", "PATCH"].includes(req.method)
    )
      return false;
    const b = await body(req),
      id = b.deviceId;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(id))
      throw new HttpError(400, "deviceId 无效");
    if (req.method === "PUT") {
      if (
        !/^[a-fA-F0-9]{32,512}$/.test(b.token || "") ||
        !["sandbox", "production"].includes(b.environment) ||
        !["zh", "en"].includes(b.language || "zh")
      )
        throw new HttpError(400, "推送参数无效");
      // Token and installation may each belong to only one signed-in account.
      db.prepare("DELETE FROM push_devices WHERE token=? OR id=?").run(
        b.token.toLowerCase(),
        id,
      );
      db.prepare(
        "INSERT INTO push_devices(id,user_id,session_token,token,environment,language,enabled,updated) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        id,
        u.id,
        sessionToken,
        b.token.toLowerCase(),
        b.environment,
        b.language || "zh",
        b.enabled === false ? 0 : 1,
        clock(),
      );
    } else if (req.method === "DELETE")
      db.prepare(
        "DELETE FROM push_devices WHERE id=? AND user_id=? AND session_token=?",
      ).run(id, u.id, sessionToken);
    else {
      const active = b.activeConversationId ?? null;
      if (
        active !== null &&
        (typeof active !== "string" || active.length > 128)
      )
        throw new HttpError(400, "会话标识无效");
      db.prepare(
        "UPDATE push_devices SET active_conversation=?,foreground_until=?,updated=? WHERE id=? AND user_id=? AND session_token=?",
      ).run(
        active,
        b.foreground === true ? clock() + 60000 : 0,
        clock(),
        id,
        u.id,
        sessionToken,
      );
    }
    send(res, 200, {
      ok: true,
      configured: transport.configured,
      unreadCount: unread(u),
    });
    return true;
  }
  return {
    observe,
    drain,
    handle,
    configuration: () => ({ apns: transport.configured }),
  };
}
