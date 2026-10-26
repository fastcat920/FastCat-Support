import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { HttpError } from "./management.mjs";
const validName = (s) =>
  typeof s === "string" && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(s);
const validFile = (s) =>
  typeof s === "string" &&
  /^(references|scripts)\/[a-zA-Z0-9_.\/-]{1,150}$/.test(s) &&
  !s.split("/").some((x) => x === ".." || x === "." || !x);
export function parseSkill(source) {
  if (typeof source !== "string" || source.length > 100000)
    throw new HttpError(400, "SKILL.md 内容过大");
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new HttpError(400, "需要包含 name、description 的 YAML 头部");
  let meta;
  try {
    meta = parse(m[1]);
  } catch {
    throw new HttpError(400, "技能 YAML 无效");
  }
  return { ...meta, instructions: m[2] };
}
export function createSkills({ db, fetcher = fetch }) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY,name TEXT UNIQUE,description TEXT,instructions TEXT,files TEXT,tags TEXT,enabled INTEGER,revision INTEGER DEFAULT 0,created TEXT)",
  );
  const row = (r) => ({
    ...r,
    files: JSON.parse(r.files),
    tags: JSON.parse(r.tags),
    enabled: !!r.enabled,
  });
  const list = () =>
    db.prepare("SELECT * FROM skills ORDER BY name").all().map(row);
  function save(b, id) {
    const old = id && db.prepare("SELECT * FROM skills WHERE id=?").get(id);
    if (id && !old) throw new HttpError(404, "技能不存在");
    if (old && b.expectedRevision !== old.revision)
      throw new HttpError(409, "技能已变化");
    const input = b.source ? { ...parseSkill(b.source), ...b } : b;
    if (old && old.name !== input.name)
      throw new HttpError(400, "技能名称不可更改，请创建新技能");
    if (
      !validName(input.name) ||
      typeof input.description !== "string" ||
      !input.description.trim() ||
      input.description.length > 1000 ||
      typeof input.instructions !== "string" ||
      !input.instructions.trim() ||
      input.instructions.length > 25000
    )
      throw new HttpError(400, "技能名称、描述或指令无效");
    const files = input.files || {};
    if (
      typeof files !== "object" ||
      Array.isArray(files) ||
      Object.keys(files).length > 30 ||
      Object.entries(files).some(
        ([k, v]) => !validFile(k) || typeof v !== "string" || v.length > 30000,
      ) ||
      JSON.stringify(files).length > 200000
    )
      throw new HttpError(400, "技能文件无效");
    const tags = input.tags || [];
    if (
      !Array.isArray(tags) ||
      tags.length > 20 ||
      tags.some((t) => typeof t !== "string" || t.length > 50)
    )
      throw new HttpError(400, "技能标签无效");
    const uid = id || randomUUID();
    try {
      db.prepare(
        "INSERT INTO skills VALUES(?,?,?,?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET description=excluded.description,instructions=excluded.instructions,files=excluded.files,tags=excluded.tags,enabled=excluded.enabled,revision=revision+1",
      ).run(
        uid,
        input.name,
        input.description,
        input.instructions,
        JSON.stringify(files),
        JSON.stringify(tags),
        input.enabled === false ? 0 : 1,
        new Date().toISOString(),
      );
    } catch (e) {
      if (String(e.message).includes("UNIQUE"))
        throw new HttpError(409, "技能名称已存在");
      throw e;
    }
    return row(db.prepare("SELECT * FROM skills WHERE id=?").get(uid));
  }
  const enabled = () => list().filter((s) => s.enabled);
  return {
    list,
    save,
    stamp: () =>
      db
        .prepare("SELECT id,revision FROM skills WHERE enabled=1 ORDER BY name")
        .all()
        .map((s) => s.id + ":" + s.revision)
        .join("|"),
    catalog: () =>
      db
        .prepare(
          "SELECT name,substr(description,1,200) description FROM skills WHERE enabled=1 ORDER BY name LIMIT 50",
        )
        .all(),
    read(name, file) {
      const found = db
        .prepare("SELECT * FROM skills WHERE name=? AND enabled=1")
        .get(name);
      const skill = found ? row(found) : null;
      if (!skill) throw Error("技能不存在或已停用");
      if (file) {
        if (!validFile(file) || !Object.hasOwn(skill.files, file))
          throw Error("技能文件不存在");
        return { name, file, content: skill.files[file] };
      }
      return {
        name,
        description: skill.description,
        instructions: skill.instructions,
        files: Object.keys(skill.files),
      };
    },
    async handle({ req, res, url, body, send, currentUser }) {
      const p = url.pathname,
        m = p.match(/^\/api\/skills\/([^/]+)$/);
      if (p === "/api/skills" && req.method === "GET") {
        send(res, 200, list());
        return true;
      }
      if (p === "/api/skills/import" && req.method === "POST") {
        const b = await body(req);
        if (currentUser()?.role !== "admin")
          throw new HttpError(403, "仅管理员可导入");
        let u;
        try {
          u = new URL(b.url);
        } catch {
          throw new HttpError(400, "GitHub 地址无效");
        }
        const parts = u.pathname.split("/").filter(Boolean);
        if (
          u.protocol !== "https:" ||
          u.hostname !== "github.com" ||
          !["tree", "blob"].includes(parts[2]) ||
          parts.length < 5 ||
          parts.some((x) => !x || x === "..") ||
          u.username ||
          u.password
        )
          throw new HttpError(400, "使用公开 GitHub 目录或 SKILL.md 链接");
        const path = parts.slice(4);
        if (path.at(-1) !== "SKILL.md") path.push("SKILL.md");
        const raw =
          "https://raw.githubusercontent.com/" +
          [parts[0], parts[1], parts[3], ...path]
            .map(encodeURIComponent)
            .join("/");
        const response = await fetcher(raw, {
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new HttpError(502, "无法读取公开技能文件");
        let content = "";
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          content += decoder.decode(chunk, { stream: true });
          if (content.length > 100000) throw new HttpError(400, "技能过大");
        }
        content += decoder.decode();
        if (currentUser()?.role !== "admin")
          throw new HttpError(403, "权限已变化");
        send(res, 201, save({ ...parseSkill(content), enabled: false }));
        return true;
      }
      if (
        (p === "/api/skills" && req.method === "POST") ||
        (m && req.method === "PUT")
      ) {
        const b = await body(req);
        if (currentUser()?.role !== "admin")
          throw new HttpError(403, "仅管理员可编辑");
        send(res, m ? 200 : 201, save(b, m?.[1]));
        return true;
      }
      return false;
    },
  };
}
