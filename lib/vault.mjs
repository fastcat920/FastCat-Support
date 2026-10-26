import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { HttpError } from "./management.mjs";
export function createVault(keyPath) {
  let master;
  function key() {
    if (master) return master;
    if (process.env.FC_MASTER_KEY) {
      master = Buffer.from(process.env.FC_MASTER_KEY, "base64");
      if (master.length !== 32)
        throw new HttpError(503, "FC_MASTER_KEY 必须为 32 字节 Base64");
      return master;
    }
    if (!keyPath) throw new HttpError(503, "未配置密钥存储");
    try {
      master = readFileSync(keyPath);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      try {
        master = randomBytes(32);
        writeFileSync(keyPath, master, { mode: 0o600, flag: "wx" });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        master = readFileSync(keyPath);
      }
    }
    if (master.length !== 32) throw new HttpError(503, "主密钥文件无效");
    chmodSync(keyPath, 0o600);
    return master;
  }
  return {
    seal(value, id) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", key(), iv);
      c.setAAD(Buffer.from(id));
      return JSON.stringify({
        iv: iv.toString("base64"),
        data: Buffer.concat([c.update(value, "utf8"), c.final()]).toString(
          "base64",
        ),
        tag: c.getAuthTag().toString("base64"),
      });
    },
    unseal(value, id) {
      try {
        const x = JSON.parse(value),
          c = createDecipheriv(
            "aes-256-gcm",
            key(),
            Buffer.from(x.iv, "base64"),
          );
        c.setAAD(Buffer.from(id));
        c.setAuthTag(Buffer.from(x.tag, "base64"));
        return Buffer.concat([
          c.update(Buffer.from(x.data, "base64")),
          c.final(),
        ]).toString();
      } catch {
        throw new HttpError(503, "密钥无法解密，请检查主密钥");
      }
    },
  };
}
