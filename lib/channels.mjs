import { randomUUID, randomBytes } from "node:crypto";
import { HttpError } from "./management.mjs";
export const defaultWidget = {
  themeColor: "#5b4ee8",
  language: "auto",
  theme: "auto",
  followHostColor: true,
  position: "bottom-right",
  welcomeMessage: "",
  logoUrl: "",
};
export function migrateChannels(db) {
  if (
    !db
      .prepare("PRAGMA table_info(conversations)")
      .all()
      .some((c) => c.name === "channel_id")
  )
    db.exec(
      "ALTER TABLE conversations ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''",
    );
  db.exec(
    "CREATE TABLE IF NOT EXISTS access_channels(id TEXT PRIMARY KEY,type TEXT,name TEXT,public_key TEXT UNIQUE,enabled INTEGER,origins TEXT,title TEXT,revision INTEGER DEFAULT 0)",
  );
  for (const [name, definition] of [
    ["widget", "TEXT NOT NULL DEFAULT '{}'"],
    ["ai_mode", "TEXT NOT NULL DEFAULT 'inherit'"],
    ["agent_id", "TEXT NOT NULL DEFAULT ''"],
    ["fallback_timeout", "INTEGER NOT NULL DEFAULT 0"],
    ["is_default", "INTEGER NOT NULL DEFAULT 0"],
    ["archived", "INTEGER NOT NULL DEFAULT 0"],
  ])
    if (
      !db
        .prepare("PRAGMA table_info(access_channels)")
        .all()
        .some((c) => c.name === name)
    )
      db.exec(`ALTER TABLE access_channels ADD COLUMN ${name} ${definition}`);
  db.exec(
    "UPDATE access_channels SET archived=0,enabled=0,revision=revision+1 WHERE archived=1",
  );
  for (const [type, name] of [
    ["web", "网页端"],
    ["sdk", "Flutter / Dart SDK"],
  ]) {
    if (!db.prepare("SELECT id FROM access_channels WHERE type=?").get(type))
      db.prepare(
        "INSERT INTO access_channels(id,type,name,public_key,enabled,origins,title) VALUES(?,?,?,?,1,?,?)",
      ).run(
        randomUUID(),
        type,
        name,
        randomBytes(18).toString("hex"),
        "[]",
        "你好，有什么可以帮你？",
      );
    if (
      !db
        .prepare("SELECT id FROM access_channels WHERE type=? AND is_default=1")
        .get(type)
    )
      db.prepare(
        "UPDATE access_channels SET is_default=1 WHERE id=(SELECT id FROM access_channels WHERE type=? ORDER BY rowid LIMIT 1)",
      ).run(type);
  }
}
export function createChannels(db, { onChange = () => {} } = {}) {
  const row = (r) => ({
    ...r,
    enabled: !!r.enabled,
    archived: !!r.archived,
    is_default: !!r.is_default,
    origins: JSON.parse(r.origins),
    widget: { ...defaultWidget, ...JSON.parse(r.widget) },
  });
  const find = (id) =>
    db.prepare("SELECT * FROM access_channels WHERE id=?").get(id);
  const list = (archived = false) =>
    db
      .prepare(
        "SELECT * FROM access_channels WHERE archived=? ORDER BY type DESC,is_default DESC,rowid",
      )
      .all(archived ? 1 : 0)
      .map(row);
  function resolve(key) {
    const r = key
      ? db.prepare("SELECT * FROM access_channels WHERE public_key=?").get(key)
      : db
          .prepare(
            "SELECT * FROM access_channels WHERE type='web' AND is_default=1",
          )
          .get();
    if (!r || !r.enabled || r.archived)
      throw new HttpError(403, "接入平台未启用或标识无效");
    return row(r);
  }
  function policy(id) {
    const r = id && find(id);
    return r ? row(r) : null;
  }
  function authorize(req, url, conversation) {
    const requested = url.searchParams.get("appKey"),
      c = conversation?.channel_id ? find(conversation.channel_id) : null;
    if (conversation?.channel_id && !c)
      throw new HttpError(403, "接入平台不存在");
    const channel = c ? row(c) : resolve(requested);
    if (
      !channel.enabled ||
      channel.archived ||
      (requested && requested !== channel.public_key)
    )
      throw new HttpError(403, "接入平台已停用或不匹配");
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== `http://${req.headers.host}` &&
      origin !== `https://${req.headers.host}` &&
      !channel.origins.includes(origin)
    )
      throw new HttpError(403, "该网站不在平台允许来源中");
    return channel;
  }
  function cors(req, res, url) {
    if (!url.pathname.startsWith("/api/widget")) return false;
    const origin = req.headers.origin;
    if (!origin) return false;
    const channel = resolve(url.searchParams.get("appKey"));
    const own =
      origin === `http://${req.headers.host}` ||
      origin === `https://${req.headers.host}`;
    if (!own && !channel.origins.includes(origin))
      throw new HttpError(403, "来源无效");
    if (!own) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization,Content-Type,X-Filename,X-Client-Id",
      );
      res.setHeader("Access-Control-Max-Age", "600");
    }
    return true;
  }
  function validate(b, old = {}) {
    if (
      typeof b.name !== "string" ||
      !b.name.trim() ||
      b.name.length > 100 ||
      typeof b.title !== "string" ||
      b.title.length > 150 ||
      !Array.isArray(b.origins) ||
      b.origins.length > 30 ||
      typeof b.enabled !== "boolean"
    )
      throw new HttpError(400, "平台配置无效");
    const origins = [
      ...new Set(
        b.origins.map((value) => {
          let u;
          try {
            u = new URL(value);
          } catch {
            throw new HttpError(400, "来源地址无效");
          }
          if (
            !["http:", "https:"].includes(u.protocol) ||
            u.username ||
            u.password ||
            u.origin !== value
          )
            throw new HttpError(
              400,
              "来源须为完整 origin，例如 https://example.com，不带路径",
            );
          return u.origin;
        }),
      ),
    ];
    let widget =
      b.widget === undefined
        ? { ...defaultWidget, ...JSON.parse(old.widget || "{}") }
        : b.widget;
    if (widget && typeof widget === "object" && !Array.isArray(widget))
      widget = { ...defaultWidget, ...widget };
    if (
      !widget ||
      typeof widget !== "object" ||
      Array.isArray(widget) ||
      !["auto", "zh-CN", "en"].includes(widget.language) ||
      !["auto", "light", "dark"].includes(widget.theme) ||
      typeof widget.followHostColor !== "boolean" ||
      !/^#[0-9a-f]{6}$/i.test(widget.themeColor) ||
      !["bottom-right", "bottom-left", "top-right", "top-left"].includes(
        widget.position,
      ) ||
      typeof widget.welcomeMessage !== "string" ||
      widget.welcomeMessage.length > 3000 ||
      typeof widget.logoUrl !== "string" ||
      widget.logoUrl.length > 1000
    )
      throw new HttpError(400, "组件外观配置无效");
    if (widget.logoUrl) {
      let u;
      try {
        u = new URL(widget.logoUrl);
      } catch {
        throw new HttpError(400, "Logo 地址无效");
      }
      if (u.protocol !== "https:" || u.username || u.password)
        throw new HttpError(400, "Logo 须为 HTTPS 地址");
    }
    const mode = b.ai_mode ?? old.ai_mode ?? "inherit",
      agentId = b.agent_id ?? old.agent_id ?? "",
      timeout = b.fallback_timeout ?? old.fallback_timeout ?? 0;
    if (
      !["inherit", "auto", "assist", "off"].includes(mode) ||
      typeof agentId !== "string" ||
      !Number.isInteger(timeout) ||
      timeout < 0 ||
      timeout > 86400
    )
      throw new HttpError(400, "AI 模式或超时无效");
    if (
      agentId &&
      !db
        .prepare("SELECT id FROM resources WHERE kind='agent' AND id=?")
        .get(agentId)
    )
      throw new HttpError(400, "所选智能体不存在");
    return {
      name: b.name.trim(),
      title: b.title,
      origins,
      enabled: b.enabled,
      widget: {
        themeColor: widget.themeColor,
        language: widget.language,
        theme: widget.theme,
        followHostColor: widget.followHostColor,
        position: widget.position,
        welcomeMessage: widget.welcomeMessage,
        logoUrl: widget.logoUrl,
      },
      ai_mode: mode,
      agent_id: agentId,
      fallback_timeout: timeout,
    };
  }
  const assertAdmin = (currentUser) => {
    if (currentUser()?.role !== "admin")
      throw new HttpError(403, "管理员权限已变化");
  };
  async function handle({ req, res, url, body, send, currentUser }) {
    const p = url.pathname;
    if (p === "/api/access/channels" && req.method === "GET") {
      send(res, 200, list());
      return true;
    }
    if (p === "/api/access/channels" && req.method === "POST") {
      const b = await body(req);
      assertAdmin(currentUser);
      if (!["web", "sdk"].includes(b.type))
        throw new HttpError(400, "仅支持网页或 Flutter/Dart 平台实例");
      if (
        db
          .prepare("SELECT count(*) n FROM access_channels WHERE archived=0")
          .get().n >= 100
      )
        throw new HttpError(409, "最多支持 100 个启用或停用平台实例");
      const c = validate({
          ...b,
          title: b.title ?? "你好，有什么可以帮你？",
          origins: b.origins ?? [],
          enabled: b.enabled ?? false,
        }),
        id = randomUUID();
      db.prepare(
        "INSERT INTO access_channels(id,type,name,public_key,enabled,origins,title,widget,ai_mode,agent_id,fallback_timeout) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        b.type,
        c.name,
        randomBytes(18).toString("hex"),
        c.enabled ? 1 : 0,
        JSON.stringify(c.origins),
        c.title,
        JSON.stringify(c.widget),
        c.ai_mode,
        c.agent_id,
        c.fallback_timeout,
      );
      send(res, 201, row(find(id)));
      return true;
    }
    const m = p.match(/^\/api\/access\/channels\/([^/]+)(?:\/(rotate))?$/);
    if (!m || !["PUT", "POST"].includes(req.method)) return false;
    const b = await body(req);
    assertAdmin(currentUser);
    const old = find(m[1]);
    if (!old) throw new HttpError(404, "平台不存在");
    if (b.expectedRevision !== old.revision)
      throw new HttpError(409, "平台配置已变化");
    if (m[2] === "rotate" && req.method === "POST") {
      db.prepare(
        "UPDATE access_channels SET public_key=?,revision=revision+1 WHERE id=?",
      ).run(randomBytes(18).toString("hex"), old.id);
    } else if (!m[2] && req.method === "PUT") {
      const c = validate(b, old);
      db.prepare(
        "UPDATE access_channels SET name=?,enabled=?,origins=?,title=?,widget=?,ai_mode=?,agent_id=?,fallback_timeout=?,revision=revision+1 WHERE id=?",
      ).run(
        c.name,
        c.enabled ? 1 : 0,
        JSON.stringify(c.origins),
        c.title,
        JSON.stringify(c.widget),
        c.ai_mode,
        c.agent_id,
        c.fallback_timeout,
        old.id,
      );
    } else return false;
    const updated = find(old.id);
    if (
      ["enabled", "archived", "ai_mode", "agent_id", "fallback_timeout"].some(
        (k) => old[k] !== updated[k],
      )
    )
      onChange(old.id);
    send(res, 200, row(find(old.id)));
    return true;
  }
  return { resolve, authorize, cors, handle, list, policy };
}
