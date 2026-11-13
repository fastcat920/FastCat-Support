import { pushEvents } from "./push-events.mjs";
import { createHash, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createAPNs } from "./push.mjs";
import { HttpError } from "./management.mjs";
const digest = (value) => createHash("sha256").update(value).digest("hex");
export function createFCM(env = process.env, request = fetch) {
  let access = "",
    expires = 0;
  return {
    configured: !!env.USER_FCM_SERVICE_ACCOUNT_FILE,
    async send(device, payload) {
      const account = JSON.parse(
        readFileSync(env.USER_FCM_SERVICE_ACCOUNT_FILE, "utf8"),
      );
      if (!access || Date.now() > expires) {
        const encode = (v) =>
          Buffer.from(JSON.stringify(v)).toString("base64url");
        const now = Math.floor(Date.now() / 1000);
        const unsigned =
          encode({ alg: "RS256", typ: "JWT" }) +
          "." +
          encode({
            iss: account.client_email,
            scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: "https://oauth2.googleapis.com/token",
            iat: now,
            exp: now + 3600,
          });
        const assertion =
          unsigned +
          "." +
          sign(
            "RSA-SHA256",
            Buffer.from(unsigned),
            account.private_key,
          ).toString("base64url");
        const response = await request("https://oauth2.googleapis.com/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error("FCM authentication failed");
        const data = await response.json();
        access = data.access_token;
        expires = Date.now() + Math.max(60, data.expires_in - 60) * 1000;
      }
      const response = await request(
        "https://fcm.googleapis.com/v1/projects/" +
          encodeURIComponent(account.project_id) +
          "/messages:send",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + access,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            message: {
              token: device.token,
              notification: payload.aps.alert,
              data: {
                type: payload.type,
                conversationId: payload.conversationId,
                messageId: payload.messageId,
                unreadCount: String(payload.aps.badge),
              },
              android: {
                priority: "HIGH",
                ttl: "3600s",
                notification: {
                  channel_id: "fastcat_support",
                  sound: "default",
                  tag: payload.messageId,
                  notification_count: payload.aps.badge,
                },
              },
            },
          }),
        },
      );
      const data = await response.json();
      if (response.status === 401) {
        access = "";
        expires = 0;
      }
      const code = data.error?.details?.find(
        (d) =>
          d["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError",
      )?.errorCode;
      return {
        status: response.ok
          ? 200
          : code === "UNREGISTERED"
            ? 410
            : response.status === 400
              ? 503
              : response.status,
        reason: code || data.error?.status,
      };
    },
  };
}
export function createUserPush(
  db,
  {
    apns = createAPNs({
      APNS_KEY_FILE: process.env.USER_APNS_KEY_FILE,
      APNS_KEY_ID: process.env.USER_APNS_KEY_ID,
      APNS_TEAM_ID: process.env.USER_APNS_TEAM_ID,
      APNS_TOPIC: process.env.USER_APNS_TOPIC,
    }),
    fcm = createFCM(),
    clock = Date.now,
  } = {},
) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_push_devices(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,visitor_id TEXT NOT NULL,credential_hash TEXT NOT NULL,provider TEXT NOT NULL,token TEXT NOT NULL,environment TEXT NOT NULL,language TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,foreground_until INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,UNIQUE(provider,token));
CREATE TABLE IF NOT EXISTS user_push_jobs(message_id TEXT NOT NULL,device_id TEXT NOT NULL,credential_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL,reason TEXT,created INTEGER NOT NULL,PRIMARY KEY(message_id,device_id));
CREATE INDEX IF NOT EXISTS user_push_due ON user_push_jobs(state,next_attempt);
CREATE TABLE IF NOT EXISTS user_push_seen(message_id TEXT PRIMARY KEY);`);
  const events = pushEvents(db, "user_push", "agent");
  const unread = (id) =>
    db
      .prepare(
        "SELECT count(*) n FROM messages WHERE conversation_id=? AND role='agent' AND coalesce(source,'manual') NOT IN ('system','welcome') AND coalesce(seq,0)>coalesce((SELECT read_seq FROM message_receipts WHERE conversation_id=? AND actor='visitor'),0)",
      )
      .get(id, id).n;
  const configured = () => ({ apns: apns.configured, fcm: fcm.configured });
  function observe(id) {
    if (!id) return;
    const rows = db
      .prepare(
        "SELECT m.id FROM messages m JOIN user_push_events e ON e.message_id=m.id LEFT JOIN user_push_seen s ON s.message_id=m.id WHERE m.conversation_id=? AND m.role='agent' AND coalesce(m.source,'manual') NOT IN ('system','welcome') AND s.message_id IS NULL",
      )
      .all(id);
    events.transaction(() => {
      for (const m of rows) {
        db.prepare("INSERT OR IGNORE INTO user_push_seen VALUES(?)").run(m.id);
        for (const d of db
          .prepare(
            "SELECT * FROM user_push_devices WHERE conversation_id=? AND enabled=1 AND foreground_until<=?",
          )
          .all(id, clock()))
          db.prepare(
            "INSERT OR IGNORE INTO user_push_jobs(message_id,device_id,credential_hash,next_attempt,created) VALUES(?,?,?,?,?)",
          ).run(m.id, d.id, d.credential_hash, clock(), clock());
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
      for (const j of db
        .prepare(
          "SELECT j.* FROM user_push_jobs j LEFT JOIN user_push_devices d ON d.id=j.device_id WHERE j.state='pending' AND j.next_attempt<=? AND (d.id IS NULL OR (d.provider='apns' AND ?) OR (d.provider='fcm' AND ?)) ORDER BY j.created LIMIT 20",
        )
        .all(clock(), apns.configured ? 1 : 0, fcm.configured ? 1 : 0)) {
        const d = db
          .prepare("SELECT * FROM user_push_devices WHERE id=? AND enabled=1")
          .get(j.device_id);
        const m = db
          .prepare("SELECT * FROM messages WHERE id=?")
          .get(j.message_id);
        const c =
          m &&
          db
            .prepare(
              "SELECT c.*,v.token FROM conversations c JOIN visitors v ON v.id=c.visitor_id WHERE c.id=?",
            )
            .get(m.conversation_id);
        const read =
          (m &&
            db
              .prepare(
                "SELECT read_seq FROM message_receipts WHERE conversation_id=? AND actor='visitor'",
              )
              .get(m.conversation_id)?.read_seq) ||
          0;
        const skip = (reason) =>
          db
            .prepare(
              "UPDATE user_push_jobs SET state='skipped',reason=? WHERE message_id=? AND device_id=?",
            )
            .run(reason, j.message_id, j.device_id);
        if (
          !d ||
          clock() - d.updated > 30 * 86400000 ||
          !c ||
          d.conversation_id !== c.id ||
          d.visitor_id !== c.visitor_id ||
          d.credential_hash !== j.credential_hash ||
          digest(c.token) !== d.credential_hash ||
          m.seq <= read ||
          clock() - j.created > 3600000
        ) {
          skip("No longer eligible");
          continue;
        }
        if (d.foreground_until > clock()) {
          skip("Viewing conversation");
          continue;
        }
        const transport = d.provider === "apns" ? apns : fcm;
        if (!transport.configured) continue;
        let result;
        try {
          result = await transport.send(d, {
            aps: {
              alert: {
                title: "FastCat Support",
                body:
                  d.language === "en"
                    ? "You have a new support reply"
                    : "客服有一条新回复",
              },
              sound: "default",
              badge: unread(c.id),
              "thread-id": c.id,
            },
            type: "support.reply",
            conversationId: c.id,
            messageId: m.id,
          });
        } catch {
          result = { status: 0, reason: "TransportError" };
        }
        if (
          result.status === 410 ||
          (result.status === 400 &&
            ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(
              result.reason,
            ))
        )
          db.prepare(
            "UPDATE user_push_devices SET enabled=0 WHERE id=? AND token=?",
          ).run(d.id, d.token);
        const attempts = j.attempts + 1;
        db.prepare(
          "UPDATE user_push_jobs SET state=?,attempts=?,next_attempt=?,reason=? WHERE message_id=? AND device_id=?",
        ).run(
          result.status === 200
            ? "sent"
            : [400, 410, 413].includes(result.status) || attempts >= 5
              ? "failed"
              : "pending",
          attempts,
          clock() + Math.min(300000, 5000 * 2 ** attempts),
          result.reason || null,
          j.message_id,
          j.device_id,
        );
      }
      db.prepare("DELETE FROM user_push_jobs WHERE created<?").run(
        clock() - 7 * 86400000,
      );
    } finally {
      busy = false;
    }
  }
  function handle(c, method, b) {
    const id = b.deviceId;
    if (method === "GET")
      return { configured: configured(), unreadCount: unread(c.id) };
    if (!["PUT", "PATCH", "DELETE"].includes(method))
      throw new HttpError(405, "不支持的请求方法");
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(id))
      throw new HttpError(400, "deviceId 无效");
    const hash = digest(c.token);
    if (method === "PUT") {
      const provider = b.provider;
      if (
        !["apns", "fcm"].includes(provider) ||
        typeof b.token !== "string" ||
        (provider === "apns"
          ? !/^[a-fA-F0-9]{32,512}$/.test(b.token)
          : !/^[a-zA-Z0-9_:.-]{20,4096}$/.test(b.token)) ||
        !["sandbox", "production"].includes(b.environment || "production") ||
        !["zh", "en"].includes(b.language || "zh")
      )
        throw new HttpError(400, "推送参数无效");
      const token = provider === "apns" ? b.token.toLowerCase() : b.token;
      db.prepare(
        "DELETE FROM user_push_devices WHERE id=? OR (provider=? AND token=?)",
      ).run(id, provider, token);
      db.prepare(
        "INSERT INTO user_push_devices(id,conversation_id,visitor_id,credential_hash,provider,token,environment,language,enabled,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        c.id,
        c.visitor_id,
        hash,
        provider,
        token,
        b.environment || "production",
        b.language || "zh",
        b.enabled === false ? 0 : 1,
        clock(),
      );
    } else if (method === "DELETE")
      db.prepare(
        "DELETE FROM user_push_devices WHERE id=? AND conversation_id=? AND credential_hash=?",
      ).run(id, c.id, hash);
    else
      db.prepare(
        "UPDATE user_push_devices SET foreground_until=?,updated=? WHERE id=? AND conversation_id=? AND credential_hash=?",
      ).run(
        b.foreground === true ? clock() + 60000 : 0,
        clock(),
        id,
        c.id,
        hash,
      );
    return { ok: true, configured: configured(), unreadCount: unread(c.id) };
  }
  return { observe, drain, handle, configuration: configured };
}
