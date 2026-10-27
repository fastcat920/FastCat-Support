import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  HttpError,
  assertConversationAccess,
  insertStaffMessage,
} from "./management.mjs";
export const MAX_UPLOAD = 8 * 1024 * 1024;
export function migrateMedia(db) {
  if (
    !db
      .prepare("PRAGMA table_info(messages)")
      .all()
      .some((c) => c.name === "attachment_id")
  )
    db.exec("ALTER TABLE messages ADD COLUMN attachment_id TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES conversations(id),message_id TEXT,filename TEXT,mime TEXT,size INTEGER,sha256 TEXT,data BLOB,created TEXT);
CREATE INDEX IF NOT EXISTS attachment_conversation_idx ON attachments(conversation_id);`);
}
export async function readBinary(req, limit = MAX_UPLOAD) {
  if (Number(req.headers["content-length"]) > limit)
    throw new HttpError(413, "文件超过大小限制");
  let size = 0,
    tooLarge = false,
    chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      tooLarge = true;
      chunks = [];
    } else if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, "文件超过大小限制");
  if (!size) throw new HttpError(400, "请选择非空文件");
  return Buffer.concat(chunks);
}
export function uploadFilename(req) {
  let raw;
  try {
    raw = decodeURIComponent(req.headers["x-filename"] || "");
  } catch {
    throw new HttpError(400, "文件名编码无效");
  }
  const filename = basename(raw.replaceAll("\\", "/"))
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  if (!filename || [".", ".."].includes(filename) || filename.length > 200)
    throw new HttpError(400, "文件名须为 1–200 字符");
  return filename;
}
export function sniffMime(data) {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString()))
    return "image/gif";
  if (
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (data.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  return "application/octet-stream";
}
export function attachmentMetadata(db, id) {
  return (
    db
      .prepare("SELECT id,filename,mime,size FROM attachments WHERE id=?")
      .get(id) || null
  );
}
export function decorateMessages(db, rows) {
  return rows.map((m) => ({
    ...m,
    attachment: m.attachment_id
      ? attachmentMetadata(db, m.attachment_id)
      : null,
  }));
}
export function storeAttachment(
  db,
  {
    conversationId,
    user,
    visitorId,
    filename,
    data,
    internal = false,
    clientId,
  },
) {
  const c = db
    .prepare("SELECT * FROM conversations WHERE id=?")
    .get(conversationId);
  if (!c) throw new HttpError(404, "会话不存在");
  if (user) assertConversationAccess(user, c);
  if (user && c.status === "closed") throw new HttpError(409, "会话已结束");
  if (clientId && !/^[a-zA-Z0-9_-]{10,100}$/.test(clientId))
    throw new HttpError(400, "文件请求标识无效");
  const actorId = user?.id || visitorId,
    digest = createHash("sha256").update(data).digest("hex"),
    mime = sniffMime(data);
  if (clientId) {
    const previous = db
      .prepare(
        "SELECT id,attachment_id FROM messages WHERE conversation_id=? AND sender_id=? AND client_id=?",
      )
      .get(conversationId, actorId, clientId);
    if (previous) {
      const a = db
        .prepare("SELECT * FROM attachments WHERE id=?")
        .get(previous.attachment_id);
      if (!a || a.sha256 !== digest || a.filename !== filename)
        throw new HttpError(409, "相同请求标识不能上传不同文件");
      return {
        id: previous.id,
        attachment: attachmentMetadata(db, a.id),
        duplicate: true,
      };
    }
  }
  const id = randomUUID(),
    time = new Date().toISOString();
  db.exec("SAVEPOINT save_attachment");
  try {
    let messageId;
    if (user)
      messageId = insertStaffMessage(db, user, conversationId, {
        body: "[附件] " + filename,
        internal,
        clientId,
      }).id;
    else {
      reopenVisitorConversation(db, c);
      messageId = randomUUID();
      db.prepare(
        "INSERT INTO messages(id,conversation_id,role,body,created,sender_id,client_id) VALUES(?,?,?,?,?,?,?)",
      ).run(
        messageId,
        conversationId,
        "visitor",
        "[附件] " + filename,
        time,
        actorId,
        clientId || null,
      );
      db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(
        time,
        conversationId,
      );
    }
    db.prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?)").run(
      id,
      conversationId,
      messageId,
      filename,
      mime,
      data.length,
      digest,
      data,
      time,
    );
    db.prepare("UPDATE messages SET attachment_id=? WHERE id=?").run(
      id,
      messageId,
    );
    db.exec("RELEASE save_attachment");
    return {
      id: messageId,
      attachment: attachmentMetadata(db, id),
      duplicate: false,
    };
  } catch (e) {
    db.exec("ROLLBACK TO save_attachment");
    db.exec("RELEASE save_attachment");
    throw e;
  }
}
export function streamAttachment(db, res, id, { user, conversationId } = {}) {
  const row = db
    .prepare(
      "SELECT a.*,m.role FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=?",
    )
    .get(id);
  if (!row) throw new HttpError(404, "附件不存在");
  const c = db
    .prepare("SELECT * FROM conversations WHERE id=?")
    .get(row.conversation_id);
  if (user) assertConversationAccess(user, c);
  else if (row.conversation_id !== conversationId || row.role === "note")
    throw new HttpError(404, "附件不存在");
  res.writeHead(200, {
    "Content-Type": row.mime,
    "Content-Length": row.size,
    "Content-Disposition": `${row.mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.filename).replaceAll("'", "%27")}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(row.data);
}
export function insertVisitorMessage(db, c, b) {
  const fresh = db.prepare("SELECT * FROM conversations WHERE id=?").get(c.id);
  if (!fresh) throw new HttpError(404, "会话不存在");

  const text = String(b.body || "").trim();
  if (!text || text.length > 10000)
    throw new HttpError(400, "消息须为 1–10,000 字符");
  if (b.clientId && !/^[a-zA-Z0-9_-]{10,100}$/.test(b.clientId))
    throw new HttpError(400, "消息请求标识无效");
  if (b.clientId) {
    const old = db
      .prepare(
        "SELECT id,body,attachment_id FROM messages WHERE conversation_id=? AND sender_id=? AND client_id=?",
      )
      .get(c.id, c.visitor_id, b.clientId);
    if (old) {
      if (old.body !== text || old.attachment_id)
        throw new HttpError(409, "相同请求标识不能用于不同消息");
      return { ok: true, id: old.id, duplicate: true };
    }
  }
  const id = randomUUID(),
    time = new Date().toISOString();
  db.exec("SAVEPOINT visitor_message");
  try {
    reopenVisitorConversation(db, fresh);
    db.prepare(
      "INSERT INTO messages(id,conversation_id,role,body,created,sender_id,client_id) VALUES(?,?,?,?,?,?,?)",
    ).run(id, c.id, "visitor", text, time, c.visitor_id, b.clientId || null);
    db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(time, c.id);
    db.exec("RELEASE visitor_message");
    return { ok: true, id, duplicate: false };
  } catch (error) {
    db.exec("ROLLBACK TO visitor_message");
    db.exec("RELEASE visitor_message");
    throw error;
  }
}

function reopenVisitorConversation(db, c) {
  if (c.status !== "closed") return;
  db.prepare(
    "UPDATE conversations SET status='open',assignee='',handoff_reason='',handoff_pending=0,automation_mode=CASE WHEN EXISTS(SELECT 1 FROM access_channels WHERE id=conversations.channel_id AND ai_mode IN ('auto','assist')) THEN 'ai' ELSE 'human' END,revision=revision+1 WHERE id=? AND status='closed'",
  ).run(c.id);
  db.prepare("DELETE FROM platform_ai_waits WHERE conversation_id=?").run(c.id);
}
