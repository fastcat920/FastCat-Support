import { sniffMime } from "./media.mjs";
import { HttpError, canAccess } from "./management.mjs";
export const preferenceDefaults = {
  theme: "system",
  notificationEnabled: true,
  notificationSound: true,
  notifyOnBackground: true,
  notifyOnOtherConversation: true,
  notifyOnNewVisitor: true,
  notificationPreview: false,
};
export function createPreferences({ db }) {
  if (
    !db
      .prepare("PRAGMA table_info(users)")
      .all()
      .some((c) => c.name === "avatar")
  )
    db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
  db.exec(
    "CREATE TABLE IF NOT EXISTS user_preferences(user_id TEXT PRIMARY KEY,value TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0)",
  );
  const get = (u) => {
    const r = db
      .prepare("SELECT * FROM user_preferences WHERE user_id=?")
      .get(u.id);
    return {
      ...preferenceDefaults,
      ...JSON.parse(r?.value || "{}"),
      revision: r?.revision || 0,
    };
  };
  return {
    async handle({ req, res, url, body, send, currentUser, u }) {
      const p = url.pathname;
      if (p === "/api/profile/avatar" && req.method === "GET") {
        if (!u.avatar) throw new HttpError(404, "尚未设置头像");
        const [, mime, data] = u.avatar.match(/^data:([^;]+);base64,(.+)$/);
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(Buffer.from(data, "base64"));
        return true;
      }
      if (p === "/api/preferences" && req.method === "GET") {
        send(res, 200, get(u));
        return true;
      }
      if (p === "/api/preferences" && req.method === "PUT") {
        const b = await body(req);
        if (!currentUser()) throw new HttpError(403, "账号已停用");
        const old = get(u);
        if (b.expectedRevision !== old.revision)
          throw new HttpError(409, "设置已更新，请刷新后重试");
        const value = {};
        for (const k of Object.keys(preferenceDefaults)) {
          value[k] = b[k] ?? old[k];
          if (
            k === "theme"
              ? !["system", "light", "dark"].includes(value[k])
              : typeof value[k] !== "boolean"
          )
            throw new HttpError(400, "设置值无效");
        }
        db.prepare(
          "INSERT INTO user_preferences VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value,revision=revision+1",
        ).run(u.id, JSON.stringify(value));
        send(res, 200, get(u));
        return true;
      }
      if (p === "/api/profile" && req.method === "PUT") {
        const b = await body(req);
        if (!currentUser()) throw new HttpError(403, "账号已停用");
        if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 100)
          throw new HttpError(400, "姓名须为 1–100 字符");
        let avatar = u.avatar || "";
        if (b.avatar !== undefined) {
          if (typeof b.avatar !== "string" || b.avatar.length > 180000)
            throw new HttpError(400, "头像超过大小限制");
          avatar = b.avatar;
          if (avatar) {
            const match = avatar.match(
              /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/,
            );
            if (
              !match ||
              sniffMime(Buffer.from(match[2], "base64")) !== match[1]
            )
              throw new HttpError(400, "头像须为 PNG、JPEG 或 WebP 图片");
          }
        }
        db.prepare("UPDATE users SET name=?,avatar=? WHERE id=?").run(
          b.name.trim(),
          avatar,
          u.id,
        );
        send(res, 200, { ...u, name: b.name.trim(), avatar });
        return true;
      }
      if (p === "/api/notifications" && req.method === "GET") {
        const latest = db
          .prepare("SELECT coalesce(max(rowid),0) cursor FROM messages")
          .get().cursor;
        if (!url.searchParams.has("after")) {
          send(res, 200, { cursor: latest, items: [] });
          return true;
        }
        const after = Number(url.searchParams.get("after"));
        if (!Number.isSafeInteger(after) || after < 0)
          throw new HttpError(400, "通知游标无效");
        const rows = db
          .prepare(
            "SELECT m.rowid cursor,m.id,m.conversation_id conversationId,m.body,m.created,v.name,c.assignee,NOT EXISTS(SELECT 1 FROM messages old WHERE old.conversation_id=m.conversation_id AND old.role='visitor' AND old.rowid<m.rowid) newVisitor FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN visitors v ON v.id=c.visitor_id WHERE m.rowid>? ORDER BY m.rowid LIMIT 200",
          )
          .all(after);
        const allowed = rows
          .filter(
            (r) =>
              canAccess(u, r) &&
              db.prepare("SELECT role FROM messages WHERE id=?").get(r.id)
                ?.role === "visitor",
          )
          .map(({ assignee, ...r }) => r);
        send(res, 200, {
          cursor: rows.at(-1)?.cursor ?? Math.max(after, latest),
          items: allowed,
          hasMore: rows.length === 200,
        });
        return true;
      }
      return false;
    },
  };
}
