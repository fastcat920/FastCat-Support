import { verifyBackup } from "../lib/backups.mjs";
import {
  existsSync,
  copyFileSync,
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
// Restore into a NEW directory only. Never overwrite the running database.
const [source, target] = process.argv.slice(2);
try {
  if (!source || !target)
    throw Error(
      "用法：node scripts/restore-backup.mjs <备份目录> <新的恢复目录>",
    );
  const src = resolve(source),
    dest = resolve(target),
    manifest = verifyBackup(src);
  if (existsSync(dest))
    throw Error("恢复目录已存在，请使用全新目录；不会覆盖运行中的数据库");
  mkdirSync(dirname(dest), { recursive: true });
  mkdirSync(dest, { mode: 0o700 });
  for (const f of manifest.files) {
    const name = f.name === "database.key" ? "support.db.key" : f.name;
    copyFileSync(join(src, f.name), join(dest, name));
    chmodSync(join(dest, name), 0o600);
  }
  writeFileSync(
    join(dest, "RESTORE.txt"),
    "先停止服务，将 DB_PATH 指向本目录 support.db。恢复对应密钥／推送凭据环境配置，再启动并检查就绪状态。master-key.txt 对应 FC_MASTER_KEY，identity-key.txt 对应 VISITOR_IDENTITY_SECRET。请将备份同步至异机安全存储。\n",
    { mode: 0o600 },
  );
  console.log("备份校验并恢复完成；尚未切换运行中的服务。");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
