// The trigger persists the notification event in the same SQLite transaction as
// the message. A crash between saving a message and broadcasting cannot lose it.
export function pushEvents(db, prefix, role) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${prefix}_events(message_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL);`,
  );
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS ${prefix}_capture AFTER INSERT ON messages WHEN NEW.role='${role}' BEGIN INSERT OR IGNORE INTO ${prefix}_events VALUES(NEW.id,NEW.conversation_id); END;`,
  );
  return {
    transaction(fn) {
      db.exec(`SAVEPOINT ${prefix}_enqueue`);
      try {
        fn();
        db.exec(`RELEASE ${prefix}_enqueue`);
      } catch (e) {
        db.exec(`ROLLBACK TO ${prefix}_enqueue; RELEASE ${prefix}_enqueue`);
        throw e;
      }
    },
    reconcile(observe) {
      for (const row of db
        .prepare(
          `SELECT DISTINCT conversation_id FROM ${prefix}_events LIMIT 100`,
        )
        .all())
        observe(row.conversation_id);
    },
    complete(id) {
      db.prepare(`DELETE FROM ${prefix}_events WHERE conversation_id=?`).run(
        id,
      );
    },
  };
}
