import { backup, DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
  copyFileSync,
  chmodSync,
  renameSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
function checksum(path) {
  const hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(1048576),
    fd = openSync(path, "r");
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
export function verifyBackup(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (
    manifest.format !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.some((f) => f.name === "support.db")
  )
    throw Error("备份清单无效");
  for (const f of manifest.files) {
    if (
      !/^[a-zA-Z0-9_.-]+$/.test(f.name) ||
      lstatSync(join(dir, f.name)).isSymbolicLink() ||
      checksum(join(dir, f.name)) !== f.sha256
    )
      throw Error("备份文件校验失败");
  }
  const db = new DatabaseSync(join(dir, "support.db"), { readOnly: true });
  try {
    if (
      db.prepare("PRAGMA quick_check").get().quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw Error("数据库完整性校验失败");
    for (const table of ["users", "conversations", "messages"])
      db.prepare(`SELECT count(*) FROM ${table}`).get();
  } finally {
    db.close();
  }
  return manifest;
}
export function createBackups({
  db,
  dbPath,
  directory = process.env.BACKUP_DIR || resolve(dbPath, "..", "backups"),
  clock = Date.now,
  env = process.env,
  onResult = () => {},
}) {
  let busy = false;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  function list() {
    return readdirSync(directory)
      .filter((n) => /^backup-[\w-]+$/.test(n))
      .flatMap((id) => {
        try {
          const m = JSON.parse(
            readFileSync(join(directory, id, "manifest.json"), "utf8"),
          );
          return [
            {
              id,
              created: m.created,
              verified: m.verified,
              credentials: m.files.filter((f) => f.name !== "support.db")
                .length,
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.created.localeCompare(a.created));
  }
  return {
    list,
    get busy() {
      return busy;
    },
    verify(id) {
      if (!/^backup-[\w-]+$/.test(id)) throw Error("备份标识无效");
      return verifyBackup(join(directory, id));
    },
    async run() {
      if (busy) throw Object.assign(Error("备份任务正在执行"), { status: 409 });
      busy = true;
      const id = "backup-" + clock() + "-" + randomUUID(),
        temp = join(directory, ".pending-" + id),
        dest = join(directory, id);
      try {
        mkdirSync(temp, { mode: 0o700 });
        await backup(db, join(temp, "support.db"));
        chmodSync(join(temp, "support.db"), 0o600);
        if (existsSync(dbPath + ".key")) {
          copyFileSync(dbPath + ".key", join(temp, "database.key"));
          chmodSync(join(temp, "database.key"), 0o600);
        }
        if (env.FC_MASTER_KEY)
          writeFileSync(join(temp, "master-key.txt"), env.FC_MASTER_KEY, {
            mode: 0o600,
          });
        const secrets = [
          "APNS_KEY_FILE",
          "USER_APNS_KEY_FILE",
          "USER_FCM_SERVICE_ACCOUNT_FILE",
        ];
        for (const key of secrets)
          if (env[key]) {
            copyFileSync(env[key], join(temp, key + ".secret"));
            chmodSync(join(temp, key + ".secret"), 0o600);
          }
        if (env.VISITOR_IDENTITY_SECRET)
          writeFileSync(
            join(temp, "identity-key.txt"),
            env.VISITOR_IDENTITY_SECRET,
            { mode: 0o600 },
          );
        const manifest = {
          format: 1,
          created: new Date(clock()).toISOString(),
          verified: null,
          files: readdirSync(temp).map((name) => ({
            name,
            sha256: checksum(join(temp, name)),
          })),
        };
        writeFileSync(join(temp, "manifest.json"), JSON.stringify(manifest), {
          mode: 0o600,
        });
        verifyBackup(temp);
        manifest.verified = new Date(clock()).toISOString();
        writeFileSync(join(temp, "manifest.json"), JSON.stringify(manifest), {
          mode: 0o600,
        });
        renameSync(temp, dest);
        for (const row of list().slice(
          Math.max(1, Number(env.BACKUP_KEEP) || 7),
        ))
          rmSync(join(directory, row.id), { recursive: true, force: true });
        onResult({ ok: true, id });
        return { id, created: manifest.created, verified: manifest.verified };
      } catch (e) {
        rmSync(temp, { recursive: true, force: true });
        onResult({ ok: false });
        throw e;
      } finally {
        busy = false;
      }
    },
  };
}
