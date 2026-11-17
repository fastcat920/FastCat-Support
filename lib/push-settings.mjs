import { createLimiter } from "./runtime-guards.mjs";
import { createPrivateKey } from "node:crypto";
import { createVault } from "./vault.mjs";
import { createAPNs } from "./push.mjs";
import { createFCM } from "./user-push.mjs";
import { HttpError } from "./management.mjs";
const names = ["staff_apns", "user_apns", "user_fcm"];
const fail = (message) => {
  throw new HttpError(400, message);
};
export function createPushSettings({
  db,
  keyPath,
  env = process.env,
  apnsFactory = createAPNs,
  fcmFactory = createFCM,
  clock = Date.now,
}) {
  const vault = createVault(keyPath),
    cache = new Map(),
    limit = createLimiter({ clock }),
    testing = new Set();
  db.exec(
    "CREATE TABLE IF NOT EXISTS push_settings(channel TEXT PRIMARY KEY,config TEXT NOT NULL,secret TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,updated TEXT NOT NULL,test TEXT); CREATE TABLE IF NOT EXISTS push_config_clock(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL); INSERT OR IGNORE INTO push_config_clock VALUES(1,0); UPDATE push_config_clock SET revision=max(revision,coalesce((SELECT max(revision) FROM push_settings),0)) WHERE id=1; CREATE TABLE IF NOT EXISTS push_config_tests(channel TEXT PRIMARY KEY,revision INTEGER NOT NULL,result TEXT NOT NULL)",
  );
  function transaction(fn) {
    db.exec("SAVEPOINT push_configuration");
    try {
      const result = fn();
      db.exec("RELEASE push_configuration");
      return result;
    } catch (error) {
      db.exec("ROLLBACK TO push_configuration; RELEASE push_configuration");
      throw error;
    }
  }
  function row(id) {
    if (!names.includes(id)) throw new HttpError(404, "推送通道不存在");
    return db.prepare("SELECT * FROM push_settings WHERE channel=?").get(id);
  }
  function effective(id) {
    const r = row(id);
    let config, secret;
    if (r) {
      config = JSON.parse(r.config);
      secret = r.enabled ? vault.unseal(r.secret, "push:" + id) : null;
    }
    const fingerprint = r ? String(r.revision) : "environment";
    const old = cache.get(id);
    if (old?.fingerprint === fingerprint) return old.transport;
    let transport;
    if (id === "user_fcm")
      transport = fcmFactory(
        r
          ? { USER_FCM_SERVICE_ACCOUNT: secret ? JSON.parse(secret) : null }
          : env,
      );
    else {
      const prefix = id === "staff_apns" ? "" : "USER_";
      transport = apnsFactory(
        r
          ? {
              APNS_PRIVATE_KEY: secret,
              APNS_KEY_ID: config.keyId,
              APNS_TEAM_ID: config.teamId,
              APNS_TOPIC: config.topic,
            }
          : {
              APNS_KEY_FILE: env[prefix + "APNS_KEY_FILE"],
              APNS_KEY_ID: env[prefix + "APNS_KEY_ID"],
              APNS_TEAM_ID: env[prefix + "APNS_TEAM_ID"],
              APNS_TOPIC: env[prefix + "APNS_TOPIC"],
            },
      );
    }
    cache.set(id, { fingerprint, transport });
    return transport;
  }
  function state(id) {
    const r = row(id);
    let configured = false,
      decryptable = true;
    try {
      configured = effective(id).configured;
    } catch {
      decryptable = false;
    }
    return {
      channel: id,
      source: r ? "database" : "environment",
      enabled: r ? !!r.enabled : true,
      configured: !!configured,
      decryptable,
      hasCredential: r
        ? !!r.secret
        : !!(id === "user_fcm"
            ? env.USER_FCM_SERVICE_ACCOUNT_FILE
            : env[
                id === "staff_apns" ? "APNS_KEY_FILE" : "USER_APNS_KEY_FILE"
              ]),
      config: r
        ? JSON.parse(r.config)
        : id === "user_fcm"
          ? {}
          : {
              keyId:
                env[id === "staff_apns" ? "APNS_KEY_ID" : "USER_APNS_KEY_ID"] ||
                "",
              teamId:
                env[
                  id === "staff_apns" ? "APNS_TEAM_ID" : "USER_APNS_TEAM_ID"
                ] || "",
              topic:
                env[id === "staff_apns" ? "APNS_TOPIC" : "USER_APNS_TOPIC"] ||
                "",
            },
      revision: r?.revision || 0,
      updated: r?.updated || null,
      test: r?.test
        ? JSON.parse(r.test)
        : (() => {
            const t = db
              .prepare(
                "SELECT result FROM push_config_tests WHERE channel=? AND revision=?",
              )
              .get(id, r?.revision || 0);
            return t ? JSON.parse(t.result) : null;
          })(),
    };
  }
  function save(id, b, actor) {
    const previous = row(id);
    if (
      !Number.isInteger(b.expectedRevision) ||
      b.expectedRevision !== (previous?.revision || 0)
    )
      throw new HttpError(409, "推送配置已更新，请刷新后重试");
    if (typeof b.enabled !== "boolean") fail("启用状态无效");
    let config = {},
      secret = previous?.secret;
    if (id === "user_fcm") {
      if (b.credential !== undefined && b.credential !== "") {
        if (typeof b.credential !== "string" || b.credential.length > 65536)
          fail("服务账号 JSON 文件无效");
        let account;
        try {
          account = JSON.parse(b.credential);
        } catch {
          fail("服务账号 JSON 文件无效");
        }
        if (
          account?.type !== "service_account" ||
          typeof account.project_id !== "string" ||
          !/^[a-z0-9][a-z0-9-]{3,100}$/.test(account.project_id) ||
          typeof account.client_email !== "string" ||
          !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(
            account.client_email,
          ) ||
          typeof account.private_key !== "string"
        )
          fail(
            "请上传 Firebase 管理员服务账号 JSON，不是 google-services.json",
          );
        try {
          if (createPrivateKey(account.private_key).asymmetricKeyType !== "rsa")
            throw Error();
        } catch {
          fail("Firebase 私钥无效，必须为 RSA 私钥");
        }
        // Only required fields are stored; endpoints always remain fixed in code.
        secret = vault.seal(
          JSON.stringify({
            type: "service_account",
            project_id: account.project_id,
            client_email: account.client_email,
            private_key: account.private_key,
          }),
          "push:" + id,
        );
        config = {
          projectId: account.project_id,
          clientEmail: account.client_email,
        };
      } else config = previous ? JSON.parse(previous.config) : {};
    } else {
      const c = b.config;
      if (b.enabled === false && (!c || (!c.keyId && !c.teamId && !c.topic)))
        config = previous ? JSON.parse(previous.config) : {};
      else {
        if (
          !c ||
          typeof c !== "object" ||
          typeof c.keyId !== "string" ||
          typeof c.teamId !== "string" ||
          !/^[A-Z0-9]{10}$/.test(c.keyId || "") ||
          !/^[A-Z0-9]{10}$/.test(c.teamId || "") ||
          typeof c.topic !== "string" ||
          c.topic.length > 200 ||
          !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(c.topic)
        )
          fail("请填写有效的 Key ID、Team ID 和 APP Bundle ID");
        config = { keyId: c.keyId, teamId: c.teamId, topic: c.topic };
      }
      if (b.credential !== undefined && b.credential !== "") {
        if (typeof b.credential !== "string" || b.credential.length > 16384)
          fail("APNs 私钥文件无效");
        try {
          const key = createPrivateKey(b.credential);
          if (
            key.asymmetricKeyType !== "ec" ||
            key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
          )
            throw Error();
        } catch {
          fail("请上传 Apple APNs 的 P-256 私钥（.p8 文件）");
        }
        secret = vault.seal(b.credential, "push:" + id);
      }
    }
    if (b.enabled && !secret) fail("首次配置请上传凭据文件");
    secret ||= "";
    transaction(() => {
      const revision = db
        .prepare(
          "UPDATE push_config_clock SET revision=revision+1 WHERE id=1 RETURNING revision",
        )
        .get().revision;
      db.prepare(
        "INSERT INTO push_settings VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(channel) DO UPDATE SET config=excluded.config,secret=excluded.secret,enabled=excluded.enabled,revision=excluded.revision,updated=excluded.updated,test=NULL",
      ).run(
        id,
        JSON.stringify(config),
        secret,
        b.enabled ? 1 : 0,
        revision,
        new Date(clock()).toISOString(),
      );
      audit(id, actor, "push.config.save");
      db.prepare("DELETE FROM push_config_tests WHERE channel=?").run(id);
    });
    cache.delete(id);
    return state(id);
  }
  function audit(id, actor, action) {
    db.prepare(
      "INSERT INTO audit_logs(id,actor_id,action,target_id,details,created) VALUES(lower(hex(randomblob(16))),?,?,?,'{}',?)",
    ).run(actor.id, action, id, new Date(clock()).toISOString());
  }
  async function test(id, actor) {
    const before = row(id),
      revision = before?.revision || 0;
    let result;
    try {
      const transport = effective(id);
      if (!transport.configured)
        throw new HttpError(409, "通道尚未启用或配置不完整");
      const response = await transport.send(
        {
          token:
            id === "user_fcm"
              ? "support_connection_probe_not_a_device_token"
              : "0".repeat(64),
          environment: "production",
        },
        {
          aps: {
            alert: { title: "Connection probe", body: "Connection probe" },
            badge: 0,
          },
          type: "support.reply",
          conversationId: "probe",
          messageId: "probe",
        },
        { validateOnly: true },
      );
      const reachable =
        response.status === 200 ||
        [
          "BadDeviceToken",
          "Unregistered",
          "INVALID_ARGUMENT",
          "UNREGISTERED",
        ].includes(response.reason);
      result = {
        state: reachable ? "reachable" : "failed",
        checked: new Date(clock()).toISOString(),
        revision,
        code: reachable
          ? "PROVIDER_REACHED"
          : [
                "InvalidProviderToken",
                "ExpiredProviderToken",
                "TopicDisallowed",
                "PERMISSION_DENIED",
                "UNAUTHENTICATED",
              ].includes(response.reason)
            ? response.reason
            : "PROVIDER_REJECTED",
        deliveryVerified: false,
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      result = {
        state: "failed",
        checked: new Date(clock()).toISOString(),
        revision,
        code: "CONNECTION_FAILED",
        deliveryVerified: false,
      };
    }
    // A result for an old configuration must never mark a replacement as tested.
    if ((row(id)?.revision || 0) !== revision)
      throw new HttpError(409, "测试期间配置已变化，请重新测试");
    transaction(() => {
      if (before)
        db.prepare(
          "UPDATE push_settings SET test=? WHERE channel=? AND revision=?",
        ).run(JSON.stringify(result), id, revision);
      db.prepare(
        "INSERT INTO push_config_tests VALUES(?,?,?) ON CONFLICT(channel) DO UPDATE SET revision=excluded.revision,result=excluded.result",
      ).run(id, revision, JSON.stringify(result));
      audit(id, actor, "push.config.test");
    });
    return result;
  }
  async function handle({ req, res, url, u, body, send, currentUser }) {
    if (!url.pathname.startsWith("/api/push-config")) return false;
    const authorize = () => {
      const actor = currentUser ? currentUser() : u;
      if (actor?.role !== "admin")
        throw new HttpError(403, "仅管理员可配置推送");
      return actor;
    };
    authorize();
    if (url.pathname === "/api/push-config" && req.method === "GET") {
      send(res, 200, { channels: names.map(state) });
      return true;
    }
    const match = url.pathname.match(
      /^\/api\/push-config\/(staff_apns|user_apns|user_fcm)(\/test)?$/,
    );
    if (!match) throw new HttpError(404, "推送配置接口不存在");
    const id = match[1];
    if (req.method === "PUT" && !match[2]) {
      const b = await body(req);
      send(res, 200, save(id, b, authorize()));
      return true;
    }
    if (req.method === "POST" && match[2]) {
      await body(req);
      const actor = authorize();
      limit("test:" + actor.id, 5);
      if (testing.has(id)) throw new HttpError(409, "该通道正在测试，请稍候");
      testing.add(id);
      try {
        const result = await test(id, actor);
        authorize();
        send(res, 200, result);
      } finally {
        testing.delete(id);
      }
      return true;
    }
    if (req.method === "DELETE" && !match[2]) {
      const b = await body(req),
        actor = authorize();
      if (b.expectedRevision !== (row(id)?.revision || 0))
        throw new HttpError(409, "推送配置已更新，请刷新后重试");
      transaction(() => {
        db.prepare("DELETE FROM push_settings WHERE channel=?").run(id);
        db.prepare("DELETE FROM push_config_tests WHERE channel=?").run(id);
        audit(id, actor, "push.config.reset");
      });
      cache.delete(id);
      send(res, 200, state(id));
      return true;
    }
    throw new HttpError(405, "请求方法无效");
  }
  return {
    handle,
    state,
    save,
    test,
    transport(id) {
      return {
        get configured() {
          try {
            return effective(id).configured;
          } catch {
            return false;
          }
        },
        send(...args) {
          return effective(id).send(...args);
        },
      };
    },
  };
}
