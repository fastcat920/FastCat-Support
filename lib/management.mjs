import { createHash, randomBytes, randomUUID } from "node:crypto";
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
export function migrateManagement(db) {
  const add = (table, name, definition) => {
    if (
      !db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === name)
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  add("users", "role", "TEXT NOT NULL DEFAULT 'admin'");
  add("users", "active", "INTEGER NOT NULL DEFAULT 1");
  add("users", "created", "TEXT");
  add("messages", "sender_id", "TEXT");
  add("messages", "client_id", "TEXT");
  add("conversations", "priority", "TEXT NOT NULL DEFAULT 'normal'");
  add("conversations", "revision", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,email TEXT NOT NULL,role TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created_by TEXT,created TEXT,expires INTEGER,accepted TEXT,revoked INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS tags(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,color TEXT NOT NULL DEFAULT 'violet');
 CREATE TABLE IF NOT EXISTS conversation_tags(conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE,PRIMARY KEY(conversation_id,tag_id));
 CREATE TABLE IF NOT EXISTS quick_replies(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,category TEXT NOT NULL DEFAULT '通用',created TEXT,updated TEXT);
 CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY,actor_id TEXT,action TEXT,target_id TEXT,details TEXT,created TEXT);
 CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created);
 CREATE INDEX IF NOT EXISTS conversation_assignee_idx ON conversations(assignee,status);
 CREATE INDEX IF NOT EXISTS messages_conversation_time_idx ON messages(conversation_id,created);
 CREATE UNIQUE INDEX IF NOT EXISTS message_client_idx ON messages(conversation_id,sender_id,client_id);`);
}
export const canAccess = (u, c) =>
  u.role === "admin" || !c.assignee || c.assignee === u.id;
export function authorize(u, url, method) {
  if (u.role === "admin") return;
  const p = url.pathname;
  if (
    p === "/api/me" ||
    [
      "/api/preferences",
      "/api/profile",
      "/api/profile/avatar",
      "/api/notifications",
    ].includes(p) ||
    p === "/api/events" ||
    p === "/api/logout" ||
    p === "/api/search" ||
    p === "/api/global-search" ||
    p === "/api/visitors" ||
    (method === "GET" && p.startsWith("/api/visitors/")) ||
    p === "/api/conversations" ||
    p.startsWith("/api/conversations/") ||
    p === "/api/ai/status" ||
    p === "/api/ai/draft" ||
    (p === "/api/knowledge/retrieval/search" && method === "POST") ||
    (method === "GET" &&
      /^\/api\/knowledge\/retrieval\/collections\/[^/]+$/.test(p)) ||
    p === "/api/metrics" ||
    p === "/api/presence" ||
    (method === "GET" && p.startsWith("/api/attachments/")) ||
    (method === "GET" && p.startsWith("/api/knowledge/files/"))
  )
    return;
  if (
    method === "GET" &&
    [
      "/api/members",
      "/api/teams",
      "/api/quick-replies",
      "/api/knowledge/collections",
    ].includes(p)
  )
    return;
  if (
    method === "GET" &&
    p === "/api/resources" &&
    ["knowledge", "agent"].includes(url.searchParams.get("kind"))
  )
    return;
  fail(403, "仅管理员可以管理此项配置");
}
export function assertConversationAccess(u, c) {
  if (!canAccess(u, c)) fail(403, "此会话已分配给其他客服");
}
function transaction(db, fn) {
  db.exec("SAVEPOINT management");
  try {
    const result = fn();
    db.exec("RELEASE management");
    return result;
  } catch (e) {
    db.exec("ROLLBACK TO management");
    db.exec("RELEASE management");
    throw e;
  }
}
function audit(db, u, action, target, details = {}) {
  db.prepare("INSERT INTO audit_logs VALUES(?,?,?,?,?,?)").run(
    randomUUID(),
    u.id,
    action,
    target,
    JSON.stringify(details),
    new Date().toISOString(),
  );
}
export function validateEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email))
    fail(400, "请输入有效邮箱");
  return email;
}
function activeAssignee(db, id) {
  if (
    id !== "" &&
    !db.prepare("SELECT id FROM users WHERE id=? AND active=1").get(id)
  )
    fail(400, "请选择有效且启用的客服");
}
function cleanChanges(db, b) {
  const out = {};
  for (const key of ["status", "assignee", "priority", "notes", "subject"])
    if (Object.hasOwn(b, key)) out[key] = b[key];
  if (out.status && !["open", "pending", "closed"].includes(out.status))
    fail(400, "无效状态");
  if (Object.hasOwn(out, "status") && !out.status) fail(400, "无效状态");
  if (
    Object.hasOwn(out, "priority") &&
    !["low", "normal", "high", "urgent"].includes(out.priority)
  )
    fail(400, "无效优先级");
  if (Object.hasOwn(out, "assignee")) {
    if (typeof out.assignee !== "string") fail(400, "客服 ID 无效");
    activeAssignee(db, out.assignee);
  }
  if (out.subject !== undefined) {
    out.subject = String(out.subject).trim();
    if (!out.subject || out.subject.length > 200)
      fail(400, "主题须为 1–200 字符");
  }
  if (out.notes !== undefined) {
    out.notes = String(out.notes);
    if (out.notes.length > 10000) fail(400, "备注最多 10,000 字符");
  }
  return out;
}
export function updateConversation(db, u, id, changes, expectedRevision) {
  const c = db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
  if (!c) fail(404, "会话不存在");
  assertConversationAccess(u, c);
  if (
    expectedRevision !== undefined &&
    (!Number.isInteger(expectedRevision) || expectedRevision !== c.revision)
  )
    fail(409, "会话已被更新，请刷新后重试");
  const b = cleanChanges(db, changes);
  if (!Object.keys(b).length) fail(400, "没有可更新的内容");
  return transaction(db, () => {
    db.prepare(
      "UPDATE conversations SET status=?,assignee=?,priority=?,subject=?,revision=revision+1,updated=? WHERE id=?",
    ).run(
      b.status ?? c.status,
      b.assignee ?? c.assignee,
      b.priority ?? c.priority,
      b.subject ?? c.subject,
      new Date().toISOString(),
      id,
    );
    if (
      Object.hasOwn(c, "handoff_pending") &&
      (Object.hasOwn(b, "assignee") || b.status === "closed")
    )
      db.prepare("UPDATE conversations SET handoff_pending=0 WHERE id=?").run(
        id,
      );
    if (b.notes !== undefined)
      db.prepare("UPDATE visitors SET notes=? WHERE id=?").run(
        b.notes,
        c.visitor_id,
      );
    const details = {};
    for (const key of ["status", "assignee", "priority"])
      if (b[key] !== undefined && b[key] !== c[key])
        details[key] = { from: c[key], to: b[key] };
    if (b.notes !== undefined) details.notesUpdated = true;
    if (b.subject !== undefined) details.subjectUpdated = true;
    audit(db, u, "conversation.update", id, details);
    return { ok: true, revision: c.revision + 1 };
  });
}
function filters(u, params, { ignoreStatus = false } = {}) {
  const where = [],
    args = [];
  if (u.role !== "admin") {
    where.push("(c.assignee='' OR c.assignee=?)");
    args.push(u.id);
  }
  if (params.get("visitorId")) {
    where.push("c.visitor_id=?");
    args.push(params.get("visitorId"));
  }
  const status = params.get("status");
  if (!ignoreStatus && status && status !== "all") {
    if (!["open", "pending", "closed"].includes(status))
      fail(400, "无效状态筛选");
    where.push("c.status=?");
    args.push(status);
  }
  const assignee = params.get("assignee");
  if (assignee === "mine") {
    where.push("c.assignee=?");
    args.push(u.id);
  } else if (assignee === "unassigned") where.push("c.assignee=''");
  else if (assignee && assignee !== "all") {
    where.push("c.assignee=?");
    args.push(assignee);
  }
  const priority = params.get("priority");
  if (priority && priority !== "all") {
    where.push("c.priority=?");
    args.push(priority);
  }
  if (params.get("unread") === "1")
    where.push(
      "EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role='visitor' AND m.read_at IS NULL)",
    );
  const q = (params.get("q") || "").trim();
  if (q) {
    const term = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    where.push(
      "(v.name LIKE ? ESCAPE '\\' OR v.email LIKE ? ESCAPE '\\' OR c.subject LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.body LIKE ? ESCAPE '\\'))",
    );
    args.push(term, term, term, term);
  }
  return { sql: where.length ? " WHERE " + where.join(" AND ") : "", args };
}
export function listConversations(db, u, params) {
  const f = filters(u, params),
    base = " FROM conversations c JOIN visitors v ON v.id=c.visitor_id",
    total = db
      .prepare("SELECT COUNT(*) count" + base + f.sql)
      .get(...f.args).count;
  let limitSql = "",
    paging = {};
  if (params.get("paged") === "1") {
    const limit = Math.min(100, Math.max(1, Number(params.get("limit")) || 40)),
      offset = Math.max(0, Number(params.get("offset")) || 0);
    paging = { limit, offset };
    limitSql = " LIMIT " + Math.floor(limit) + " OFFSET " + Math.floor(offset);
  }
  const items = db
    .prepare(
      `SELECT c.*,v.name,v.email,u.name assigneeName,(SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND role='visitor' AND read_at IS NULL) unreadCount,(SELECT body FROM messages WHERE conversation_id=c.id ORDER BY created DESC,rowid DESC LIMIT 1) preview ${base} LEFT JOIN users u ON u.id=c.assignee ${f.sql} ORDER BY CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,c.updated DESC${limitSql}`,
    )
    .all(...f.args);
  if (params.get("paged") !== "1") return items;
  const f2 = filters(u, params, { ignoreStatus: true });
  const counts = { all: 0, open: 0, pending: 0, closed: 0 };
  for (const r of db
    .prepare(
      "SELECT c.status,COUNT(*) count" + base + f2.sql + " GROUP BY c.status",
    )
    .all(...f2.args)) {
    counts[r.status] = r.count;
    counts.all += r.count;
  }
  return { items, total, counts, ...paging };
}
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function csv(rows) {
  return "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
const tokenHash = (t) => createHash("sha256").update(t).digest("hex");
export async function handleInvite({
  req,
  res,
  url,
  db,
  body,
  send,
  hash,
  uid,
  now,
}) {
  const m = url.pathname.match(/^\/api\/invites\/([a-f0-9]{64})(\/accept)?$/);
  if (!m) return false;
  const inv = db
    .prepare(
      "SELECT * FROM invitations WHERE token_hash=? AND revoked=0 AND accepted IS NULL AND expires>?",
    )
    .get(tokenHash(m[1]), Date.now());
  if (!inv) {
    send(res, 410, { error: "邀请已失效、已使用或已撤销" });
    return true;
  }
  if (req.method === "GET" && !m[2]) {
    send(res, 200, { email: inv.email, role: inv.role, expires: inv.expires });
    return true;
  }
  if (req.method === "POST" && m[2]) {
    const b = await body(req);
    if (
      !String(b.name || "").trim() ||
      typeof b.password !== "string" ||
      b.password.length < 10 ||
      b.password.length > 256
    )
      fail(400, "填写姓名及 10–256 位密码");
    if (db.prepare("SELECT id FROM users WHERE lower(email)=?").get(inv.email))
      fail(409, "该邮箱已注册");
    transaction(db, () => {
      if (
        !db
          .prepare(
            "SELECT id FROM invitations WHERE id=? AND revoked=0 AND accepted IS NULL AND expires>?",
          )
          .get(inv.id, Date.now())
      )
        fail(410, "邀请已失效、已使用或已撤销");
      db.prepare(
        "INSERT INTO users(id,name,email,password,role,active,created) VALUES(?,?,?,?,?,1,?)",
      ).run(
        uid(),
        String(b.name).trim().slice(0, 100),
        inv.email,
        hash(b.password),
        inv.role,
        now(),
      );
      db.prepare("UPDATE invitations SET accepted=? WHERE id=?").run(
        now(),
        inv.id,
      );
    });
    send(res, 201, { ok: true });
    return true;
  }
  send(res, 405, { error: "不支持的操作" });
  return true;
}
export async function handleManagement(ctx) {
  const {
      req,
      res,
      url,
      u,
      db,
      body,
      send,
      uid,
      now,
      broadcast,
      revokeSessions,
    } = ctx,
    p = url.pathname,
    method = req.method;
  if (p === "/api/members" && method === "GET") {
    const rows = db
      .prepare(
        "SELECT u.id,u.name,u.role,u.active,u.availability,u.capacity,(SELECT COUNT(*) FROM conversations c WHERE c.assignee=u.id AND c.status!='closed') workload FROM users u ORDER BY u.active DESC,u.name",
      )
      .all();
    if (u.role === "admin") {
      const full = db.prepare("SELECT id,email,created FROM users").all();
      rows.forEach((r) =>
        Object.assign(
          r,
          full.find((v) => v.id === r.id),
        ),
      );
    }
    send(res, 200, rows);
    return true;
  }
  const member = p.match(/^\/api\/members\/([^/]+)$/);
  if (member && method === "PATCH") {
    if (u.role !== "admin") fail(403, "仅管理员可以管理成员");
    const b = await body(req);
    const old = db.prepare("SELECT * FROM users WHERE id=?").get(member[1]);
    if (!old) fail(404, "成员不存在");
    const role = b.role ?? old.role,
      active = b.active === undefined ? old.active : b.active;
    if (!["admin", "agent"].includes(role) || ![0, 1].includes(active))
      fail(400, "角色或状态无效");
    if (old.id === u.id && active === 0) fail(400, "不能停用当前账号");
    if (
      old.role === "admin" &&
      old.active &&
      (role !== "admin" || !active) &&
      db
        .prepare(
          "SELECT COUNT(*) count FROM users WHERE role='admin' AND active=1 AND id!=?",
        )
        .get(old.id).count === 0
    )
      fail(409, "必须保留至少一位启用的管理员");
    const name = String(b.name ?? old.name).trim(),
      email = validateEmail(b.email ?? old.email);
    if (!name || name.length > 100) fail(400, "姓名须为 1–100 字符");
    if (
      db
        .prepare("SELECT id FROM users WHERE lower(email)=? AND id!=?")
        .get(email, old.id)
    )
      fail(409, "邮箱已被使用");
    const capacity = b.capacity ?? old.capacity,
      availability = b.availability ?? old.availability;
    if (
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > 100 ||
      !["available", "away", "offline"].includes(availability)
    )
      fail(400, "容量或在线状态无效");
    const released = [];
    transaction(db, () => {
      db.prepare(
        "UPDATE users SET name=?,email=?,role=?,active=?,capacity=?,availability=? WHERE id=?",
      ).run(name, email, role, active, capacity, availability, old.id);
      if (!active) {
        released.push(
          ...db
            .prepare(
              "SELECT id FROM conversations WHERE assignee=? AND status!='closed'",
            )
            .all(old.id),
        );
        db.prepare(
          "UPDATE conversations SET assignee='',revision=revision+1,updated=? WHERE assignee=? AND status!='closed'",
        ).run(now(), old.id);
      }
      if (!active || role !== old.role)
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(old.id);
      audit(db, u, "member.update", old.id, {
        role,
        active,
        availability,
        capacity,
      });
    });
    if (!active || role !== old.role) revokeSessions(old.id);
    released.forEach((c) => broadcast(c.id));
    broadcast();
    send(res, 200, { ok: true, released: released.length });
    return true;
  }
  if (p === "/api/invitations" && method === "GET") {
    send(
      res,
      200,
      db
        .prepare(
          "SELECT id,email,role,created,expires,accepted,revoked FROM invitations ORDER BY created DESC",
        )
        .all(),
    );
    return true;
  }
  if (p === "/api/invitations" && method === "POST") {
    const b = await body(req),
      email = validateEmail(b.email),
      role = b.role || "agent";
    if (!["admin", "agent"].includes(role)) fail(400, "角色无效");
    if (db.prepare("SELECT id FROM users WHERE lower(email)=?").get(email))
      fail(409, "该邮箱已注册");
    const token = randomBytes(32).toString("hex"),
      id = uid();
    transaction(db, () => {
      db.prepare(
        "UPDATE invitations SET revoked=1 WHERE email=? AND accepted IS NULL",
      ).run(email);
      db.prepare(
        "INSERT INTO invitations(id,email,role,token_hash,created_by,created,expires) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        email,
        role,
        tokenHash(token),
        u.id,
        now(),
        Date.now() + 7 * 86400000,
      );
      audit(db, u, "invitation.create", id, { role });
    });
    send(res, 201, { id, path: "/?invite=" + token });
    return true;
  }
  const invitation = p.match(/^\/api\/invitations\/([^/]+)$/);
  if (invitation && method === "DELETE") {
    const result = db
      .prepare(
        "UPDATE invitations SET revoked=1 WHERE id=? AND accepted IS NULL",
      )
      .run(invitation[1]);
    if (!result.changes) fail(404, "有效邀请不存在");
    audit(db, u, "invitation.revoke", invitation[1]);
    send(res, 200, { ok: true });
    return true;
  }
  if (p === "/api/quick-replies" && method === "GET") {
    send(
      res,
      200,
      db.prepare("SELECT * FROM quick_replies ORDER BY category,title").all(),
    );
    return true;
  }
  const qr = p.match(/^\/api\/quick-replies\/([^/]+)$/);
  if (
    (p === "/api/quick-replies" && method === "POST") ||
    (qr && method === "PATCH")
  ) {
    const b = await body(req),
      title = String(b.title || "").trim(),
      content = String(b.body || "").trim(),
      category = String(b.category || "通用").trim();
    if (
      !title ||
      title.length > 100 ||
      !content ||
      content.length > 5000 ||
      !category ||
      category.length > 50
    )
      fail(400, "填写标题、分类和回复内容（最多 5000 字符）");
    if (qr && !db.prepare("SELECT id FROM quick_replies WHERE id=?").get(qr[1]))
      fail(404, "快捷回复不存在");
    const id = qr ? qr[1] : uid();
    if (qr)
      db.prepare(
        "UPDATE quick_replies SET title=?,body=?,category=?,updated=? WHERE id=?",
      ).run(title, content, category, now(), id);
    else
      db.prepare("INSERT INTO quick_replies VALUES(?,?,?,?,?,?)").run(
        id,
        title,
        content,
        category,
        now(),
        now(),
      );
    audit(db, u, qr ? "quick_reply.update" : "quick_reply.create", id);
    send(res, qr ? 200 : 201, { id });
    return true;
  }
  if (qr && method === "DELETE") {
    db.prepare("DELETE FROM quick_replies WHERE id=?").run(qr[1]);
    audit(db, u, "quick_reply.delete", qr[1]);
    send(res, 200, { ok: true });
    return true;
  }
  if (p === "/api/conversations/bulk" && method === "POST") {
    const b = await body(req),
      ids = [...new Set(Array.isArray(b.ids) ? b.ids : [])];
    if (
      !ids.length ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string")
    )
      fail(400, "每次选择 1–100 个会话");
    if (b.changes?.notes !== undefined || b.changes?.subject !== undefined)
      fail(400, "批量操作不支持备注和主题");
    const results = transaction(db, () =>
      ids.map((id) =>
        updateConversation(db, u, id, b.changes || {}, b.versions?.[id]),
      ),
    );
    ids.forEach(broadcast);
    send(res, 200, { ok: true, count: results.length });
    return true;
  }
  if (p === "/api/conversations/export" && method === "GET") {
    const params = new URLSearchParams(url.searchParams);
    params.set("paged", "0");
    const all = listConversations(db, u, params),
      rows = all.slice(0, 10000);
    send(res, 200, {
      filename: "conversations-" + now().slice(0, 10) + ".csv",
      total: all.length,
      truncated: all.length > 10000,
      content: csv([
        [
          "会话ID",
          "访客",
          "邮箱",
          "主题",
          "状态",
          "客服",
          "优先级",
          "创建时间",
          "更新时间",
        ],
        ...rows.map((c) => [
          c.id,
          c.name,
          c.email,
          c.subject,
          c.status,
          c.assigneeName || "未分配",
          c.priority,
          c.created,
          c.updated,
        ]),
      ]),
    });
    return true;
  }
  if (p === "/api/global-search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2) {
      send(res, 200, { conversations: [], resources: [] });
      return true;
    }
    const params = new URLSearchParams({ q, paged: "1", limit: "8" });
    const conversations = listConversations(db, u, params).items;
    const allowed =
      u.role === "admin"
        ? ["agent", "knowledge", "workflow", "tool", "channel", "model"]
        : ["knowledge"];
    const resources = db
      .prepare(
        "SELECT id,kind,name FROM resources WHERE kind IN (" +
          allowed.map(() => "?").join(",") +
          ") AND (name LIKE ? OR description LIKE ?) ORDER BY created DESC LIMIT 12",
      )
      .all(...allowed, "%" + q + "%", "%" + q + "%");
    send(res, 200, { conversations, resources });
    return true;
  }
  if (p === "/api/audit" && method === "GET") {
    send(
      res,
      200,
      db
        .prepare(
          "SELECT a.*,u.name actorName FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created DESC,a.rowid DESC LIMIT 100",
        )
        .all()
        .map((r) => ({ ...r, details: JSON.parse(r.details) })),
    );
    return true;
  }
  const visitorHistory = p.match(/^\/api\/visitors\/([^/]+)\/conversations$/);
  if (visitorHistory && method === "GET") {
    const items = listConversations(
      db,
      u,
      new URLSearchParams({ visitorId: visitorHistory[1] }),
    );
    if (!items.length) fail(404, "没有可查看的访客会话");
    send(res, 200, items);
    return true;
  }
  if (
    p === "/api/metrics" ||
    p === "/api/presence" ||
    (method === "GET" && p.startsWith("/api/attachments/")) ||
    (method === "GET" &&
      p.startsWith("/api/knowledge/files/") &&
      method === "GET")
  ) {
    const rows = listConversations(db, u, new URLSearchParams());
    send(res, 200, {
      total: rows.length,
      open: rows.filter((c) => c.status === "open").length,
      pending: rows.filter((c) => c.status === "pending").length,
      closed: rows.filter((c) => c.status === "closed").length,
      mine: rows.filter((c) => c.assignee === u.id && c.status !== "closed")
        .length,
      unassigned: rows.filter((c) => !c.assignee && c.status !== "closed")
        .length,
      urgent: rows.filter(
        (c) => c.priority === "urgent" && c.status !== "closed",
      ).length,
    });
    return true;
  }
  return false;
}

export function insertStaffMessage(db, u, id, b) {
  return transaction(db, () => {
    const c = db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
    if (!c) fail(404, "会话不存在");
    assertConversationAccess(u, c);
    if (c.status === "closed") fail(409, "请先重新打开会话");
    const content = String(b.body || "").trim();
    if (!content || content.length > 10000) fail(400, "消息须为 1–10,000 字符");
    if (b.clientId !== undefined && !/^[a-zA-Z0-9_-]{10,100}$/.test(b.clientId))
      fail(400, "消息请求标识无效");
    if (b.clientId) {
      const old = db
        .prepare(
          "SELECT id,body,role FROM messages WHERE conversation_id=? AND sender_id=? AND client_id=?",
        )
        .get(id, u.id, b.clientId);
      if (old) {
        if (
          old.body !== content ||
          old.role !== (b.internal ? "note" : "agent")
        )
          fail(409, "相同请求标识不能用于不同消息");
        return { ok: true, id: old.id, duplicate: true };
      }
    }
    const messageId = randomUUID(),
      time = new Date().toISOString();
    db.prepare(
      "INSERT INTO messages(id,conversation_id,role,body,created,sender_id,client_id) VALUES(?,?,?,?,?,?,?)",
    ).run(
      messageId,
      id,
      b.internal ? "note" : "agent",
      content,
      time,
      u.id,
      b.clientId || null,
    );
    db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(time, id);
    if (!b.internal && !c.assignee) {
      db.prepare(
        "UPDATE conversations SET assignee=?,revision=revision+1 WHERE id=?",
      ).run(u.id, id);
      audit(db, u, "conversation.claim", id, { assignee: u.id });
    }
    return { ok: true, id: messageId, duplicate: false };
  });
}
