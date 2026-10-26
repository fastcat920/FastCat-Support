import { randomUUID, randomBytes, createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { HttpError } from "./management.mjs";
import { validateArguments } from "./integrations.mjs";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const object = (properties) => ({
  type: "object",
  properties,
  additionalProperties: false,
  required: Object.keys(properties),
});
export const deviceSchemas = {
  screenshot: object({}),
  click: object({
    x: { type: "integer", minimum: 0, maximum: 20000 },
    y: { type: "integer", minimum: 0, maximum: 20000 },
  }),
  typeText: object({ text: { type: "string", maxLength: 2000 } }),
  keyPress: object({
    key: {
      type: "string",
      enum: [
        "enter",
        "tab",
        "escape",
        "backspace",
        "up",
        "down",
        "left",
        "right",
      ],
    },
  }),
  scroll: object({
    pixels: { type: "integer", minimum: -2000, maximum: 2000 },
  }),
};
export function createDevices({ db, clock = () => Date.now() }) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT,os TEXT,capabilities TEXT,token_hash TEXT,enabled INTEGER,revision INTEGER,last_seen INTEGER,created TEXT);CREATE TABLE IF NOT EXISTS device_codes(hash TEXT PRIMARY KEY,expires INTEGER);CREATE TABLE IF NOT EXISTS device_tasks(id TEXT PRIMARY KEY,device_id TEXT,command TEXT,args TEXT,status TEXT,result TEXT,error TEXT,created INTEGER,finished INTEGER);UPDATE device_tasks SET status='unknown',args='{}',result='{}',error='服务重启，未重试',finished=unixepoch()*1000 WHERE status IN ('queued','running')",
  );
  const row = (r) => {
    const { token_hash, ...safe } = r;
    return {
      ...safe,
      capabilities: JSON.parse(r.capabilities),
      enabled: !!r.enabled,
      status: r.enabled && clock() - r.last_seen < 30000 ? "online" : "offline",
    };
  };
  const list = () =>
    db.prepare("SELECT * FROM devices ORDER BY created DESC").all().map(row);
  function get(id) {
    const r = db.prepare("SELECT * FROM devices WHERE id=?").get(id);
    if (!r) throw new HttpError(404, "设备不存在");
    return row(r);
  }
  const auth = (req) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const r =
      token &&
      db
        .prepare("SELECT * FROM devices WHERE token_hash=? AND enabled=1")
        .get(hash(token));
    if (!r) throw new HttpError(401, "设备凭据无效");
    return r;
  };
  return {
    list,
    get,
    stamp: (id) => {
      const d = get(id);
      return d.revision + ":" + d.enabled;
    },
    async call(id, command, args, { signal, check = () => {} } = {}) {
      const d = get(id);
      if (d.status !== "online" || !d.capabilities.includes(command))
        throw Error("设备离线或未授权此操作");
      validateArguments(deviceSchemas[command], args);
      const uid = randomUUID();
      db.prepare(
        "INSERT INTO device_tasks VALUES(?,?,?,?,'queued','{}','',?,NULL)",
      ).run(uid, id, command, JSON.stringify(args), clock());
      const bounded = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
        : AbortSignal.timeout(45000);
      try {
        for (;;) {
          check();
          bounded.throwIfAborted();
          if (get(id).status !== "online") throw Error("设备已断开");
          const task = db
            .prepare("SELECT * FROM device_tasks WHERE id=?")
            .get(uid);
          if (task.status === "succeeded") return JSON.parse(task.result);
          if (["failed", "unknown", "cancelled"].includes(task.status))
            throw Error(task.error || "设备操作失败");
          await wait(100, undefined, { signal: bounded });
        }
      } finally {
        db.prepare(
          "UPDATE device_tasks SET status=CASE WHEN status='queued' THEN 'cancelled' WHEN status='running' THEN 'unknown' ELSE status END,args='{}',result='{}',finished=? WHERE id=?",
        ).run(clock(), uid);
      }
    },
    async publicHandle({ req, res, url, body, send }) {
      const p = url.pathname;
      if (!p.startsWith("/api/device-agent/")) return false;
      if (req.method !== "POST") throw new HttpError(405, "只允许 POST");
      const b = await body(req);
      if (p === "/api/device-agent/register") {
        if (
          typeof b.code !== "string" ||
          typeof b.name !== "string" ||
          !b.name.trim() ||
          b.name.length > 100 ||
          typeof b.os !== "string" ||
          b.os.length > 100 ||
          !Array.isArray(b.capabilities) ||
          !b.capabilities.length ||
          b.capabilities.some((c) => !Object.hasOwn(deviceSchemas, c))
        )
          throw new HttpError(400, "设备注册无效");
        const code = db
          .prepare("SELECT * FROM device_codes WHERE hash=? AND expires>?")
          .get(hash(b.code), clock());
        if (!code) throw new HttpError(401, "绑定码无效或已过期");
        db.prepare("DELETE FROM device_codes WHERE hash=?").run(hash(b.code));
        const id = randomUUID(),
          token = randomBytes(32).toString("hex");
        db.prepare("INSERT INTO devices VALUES(?,?,?,?,?,1,0,?,?)").run(
          id,
          b.name,
          b.os,
          JSON.stringify([...new Set(b.capabilities)]),
          hash(token),
          clock(),
          new Date(clock()).toISOString(),
        );
        send(res, 201, { id, token });
        return true;
      }
      const d = auth(req);
      db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(
        clock(),
        d.id,
      );
      if (p === "/api/device-agent/heartbeat") {
        send(res, 200, { ok: true });
        return true;
      }
      if (p === "/api/device-agent/poll") {
        db.prepare(
          "UPDATE device_tasks SET status='unknown',args='{}',result='{}',error='设备执行超时，未重试',finished=? WHERE device_id=? AND status IN ('queued','running') AND created<?",
        ).run(clock(), d.id, clock() - 45000);
        const t = db
          .prepare(
            "SELECT id,command,args FROM device_tasks WHERE device_id=? AND status='queued' ORDER BY created LIMIT 1",
          )
          .get(d.id);
        if (t)
          db.prepare(
            "UPDATE device_tasks SET status='running' WHERE id=? AND status='queued'",
          ).run(t.id);
        send(res, 200, { task: t ? { ...t, args: JSON.parse(t.args) } : null });
        return true;
      }
      if (p === "/api/device-agent/result") {
        const task = db
          .prepare(
            "SELECT id FROM device_tasks WHERE id=? AND device_id=? AND status='running'",
          )
          .get(b.id, d.id);
        if (!task) throw new HttpError(409, "任务已结束或不属于此设备");
        const result = JSON.stringify(b.result ?? {});
        if (result.length > 700000) throw new HttpError(400, "结果过大");
        db.prepare(
          "UPDATE device_tasks SET status=?,result=?,error=?,args='{}',finished=? WHERE id=?",
        ).run(
          b.ok === true ? "succeeded" : "failed",
          result,
          b.ok === true ? "" : String(b.error || "设备操作失败").slice(0, 300),
          clock(),
          task.id,
        );
        send(res, 200, { ok: true });
        return true;
      }
      throw new HttpError(404, "设备接口不存在");
    },
    async handle({ req, res, url, body, send, currentUser }) {
      const p = url.pathname;
      if (p === "/api/devices" && req.method === "GET") {
        send(res, 200, list());
        return true;
      }
      if (p === "/api/devices/bind-code" && req.method === "POST") {
        await body(req);
        if (currentUser()?.role !== "admin")
          throw new HttpError(403, "仅管理员可绑定");
        const code = randomBytes(8).toString("hex");
        db.prepare("DELETE FROM device_codes WHERE expires<?").run(clock());
        db.prepare("INSERT INTO device_codes VALUES(?,?)").run(
          hash(code),
          clock() + 300000,
        );
        send(res, 201, {
          code,
          expires: new Date(clock() + 300000).toISOString(),
        });
        return true;
      }
      const m = p.match(/^\/api\/devices\/([^/]+)$/);
      if (m && req.method === "PUT") {
        const b = await body(req);
        if (currentUser()?.role !== "admin")
          throw new HttpError(403, "仅管理员可管理设备");
        const d = get(m[1]);
        if (b.expectedRevision !== d.revision)
          throw new HttpError(409, "设备已变化");
        if (
          typeof b.name !== "string" ||
          !b.name.trim() ||
          b.name.length > 100 ||
          typeof b.enabled !== "boolean"
        )
          throw new HttpError(400, "设备配置无效");
        db.prepare(
          "UPDATE devices SET name=?,enabled=?,revision=revision+1 WHERE id=?",
        ).run(b.name, b.enabled ? 1 : 0, d.id);
        if (!b.enabled)
          db.prepare(
            "UPDATE device_tasks SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'unknown' END,args='{}',result='{}',error='设备已停用',finished=? WHERE device_id=? AND status IN ('queued','running')",
          ).run(clock(), d.id);
        send(res, 200, get(d.id));
        return true;
      }
      return false;
    },
  };
}
