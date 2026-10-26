import { HttpError } from "./management.mjs";
export function migrateReceipts(db) {
  if (
    !db
      .prepare("PRAGMA table_info(messages)")
      .all()
      .some((c) => c.name === "seq")
  )
    db.exec("ALTER TABLE messages ADD COLUMN seq INTEGER");
  db.exec(`UPDATE messages SET seq=rowid WHERE seq IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS message_seq_idx ON messages(seq);
CREATE TABLE IF NOT EXISTS message_clock(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
INSERT OR IGNORE INTO message_clock VALUES(1,0);
UPDATE message_clock SET value=max(value,coalesce((SELECT max(seq) FROM messages),0)) WHERE id=1;
CREATE TRIGGER IF NOT EXISTS message_sequence AFTER INSERT ON messages BEGIN UPDATE message_clock SET value=value+1 WHERE id=1; UPDATE messages SET seq=(SELECT value FROM message_clock WHERE id=1) WHERE id=NEW.id; END;
CREATE TABLE IF NOT EXISTS message_receipts(conversation_id TEXT REFERENCES conversations(id),actor TEXT,delivered_seq INTEGER DEFAULT 0,read_seq INTEGER DEFAULT 0,updated TEXT,PRIMARY KEY(conversation_id,actor));`);
}
export function receiptState(db, id, visitor) {
  const own = visitor ? "visitor" : "staff";
  const peer = visitor ? "actor LIKE 'staff:%'" : "actor='visitor'";
  const p = db
    .prepare(
      `SELECT coalesce(max(delivered_seq),0) deliveredSeq,coalesce(max(read_seq),0) readSeq FROM message_receipts WHERE conversation_id=? AND ${peer}`,
    )
    .get(id);
  const last = db
    .prepare(
      `SELECT coalesce(max(seq),0) lastSeq FROM messages WHERE conversation_id=? ${visitor ? "AND role!='note'" : ""}`,
    )
    .get(id);
  if (visitor) {
    for (const key of ["deliveredSeq", "readSeq"])
      p[key] = db
        .prepare(
          "SELECT coalesce(max(seq),0) n FROM messages WHERE conversation_id=? AND role!='note' AND seq<=?",
        )
        .get(id, p[key]).n;
  }
  return { ...p, ...last };
}
export function acknowledge(db, id, actor, b, visitor) {
  const delivered = b.deliveredSeq,
    read = b.readSeq;
  if (
    !Number.isSafeInteger(delivered) ||
    !Number.isSafeInteger(read) ||
    read < 0 ||
    delivered < read
  )
    throw new HttpError(400, "消息游标无效");
  const valid = (n) =>
    n === 0 ||
    db
      .prepare(
        `SELECT id FROM messages WHERE conversation_id=? AND seq=? ${visitor ? "AND role!='note'" : ""}`,
      )
      .get(id, n);
  if (!valid(delivered) || !valid(read))
    throw new HttpError(400, "游标不属于可访问的会话消息");
  const now = new Date().toISOString();
  db.exec("SAVEPOINT acknowledge_messages");
  try {
    db.prepare(
      "INSERT INTO message_receipts VALUES(?,?,?,?,?) ON CONFLICT(conversation_id,actor) DO UPDATE SET delivered_seq=max(delivered_seq,excluded.delivered_seq),read_seq=max(read_seq,excluded.read_seq),updated=excluded.updated",
    ).run(id, actor, delivered, read, now);
    db.prepare(
      "UPDATE messages SET read_at=? WHERE conversation_id=? AND seq<=? AND role=? AND read_at IS NULL",
    ).run(now, id, read, visitor ? "agent" : "visitor");
    db.exec("RELEASE acknowledge_messages");
  } catch (error) {
    db.exec("ROLLBACK TO acknowledge_messages");
    db.exec("RELEASE acknowledge_messages");
    throw error;
  }
  return receiptState(db, id, visitor);
}
