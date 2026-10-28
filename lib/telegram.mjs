import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createVault } from "./vault.mjs";
import { HttpError, insertStaffMessage, canAccess } from "./management.mjs";
import { storeAttachment, MAX_UPLOAD } from "./media.mjs";
export function migrateTelegram(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_config(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT,token_cipher TEXT,secret_cipher TEXT,revision INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS telegram_topics(binding TEXT,conversation_id TEXT REFERENCES conversations(id),thread_id INTEGER,state TEXT,created TEXT,last_seq INTEGER DEFAULT 0,PRIMARY KEY(binding,conversation_id),UNIQUE(binding,thread_id));
CREATE TABLE IF NOT EXISTS telegram_deliveries(id TEXT PRIMARY KEY,binding TEXT,conversation_id TEXT,kind TEXT,message_id TEXT,part INTEGER,text TEXT,status TEXT,attempts INTEGER DEFAULT 0,available INTEGER,error TEXT,remote_id INTEGER,created TEXT,UNIQUE(binding,conversation_id,kind,message_id,part));
CREATE TABLE IF NOT EXISTS telegram_updates(binding TEXT,update_id INTEGER,payload TEXT,status TEXT,attempts INTEGER DEFAULT 0,available INTEGER,error TEXT,created TEXT,PRIMARY KEY(binding,update_id));
CREATE TABLE IF NOT EXISTS telegram_poll_offsets(binding TEXT PRIMARY KEY,offset INTEGER NOT NULL);`);
  if (
    !db
      .prepare("PRAGMA table_info(telegram_topics)")
      .all()
      .some((c) => c.name === "last_seq")
  )
    db.exec(
      "ALTER TABLE telegram_topics ADD COLUMN last_seq INTEGER DEFAULT 0",
    );
  db.prepare("INSERT OR IGNORE INTO telegram_config VALUES(1,?,?,?,0)").run(
    JSON.stringify({
      enabled: false,
      chatId: "",
      tokenEnv: "",
      publicBaseUrl: "",
      operators: [],
      contextMessages: 10,
      binding: randomUUID(),
      botId: null,
    }),
    "",
    "",
  );
  db.prepare(
    "UPDATE telegram_deliveries SET status='uncertain',error='服务重启，发送结果不确定，请核对话题后重试' WHERE status='sending'",
  ).run();
  db.prepare(
    "UPDATE telegram_updates SET status='queued' WHERE status='processing'",
  ).run();
}
export function createTelegram({
  db,
  keyPath,
  broadcast = () => {},
  fetcher = fetch,
  apiBase = process.env.TELEGRAM_API_BASE || "https://api.telegram.org",
  autostart = true,
  polling = process.env.TELEGRAM_POLLING === "1",
  clock = () => Date.now(),
}) {
  const vault = createVault(keyPath),
    now = () => new Date(clock()).toISOString();
  let busy = false,
    closed = false,
    timer,
    pollTimer,
    pollingBusy = false;
  const settings = () => {
    const r = db.prepare("SELECT * FROM telegram_config WHERE id=1").get();
    return {
      ...JSON.parse(r.value),
      tokenCipher: r.token_cipher,
      secretCipher: r.secret_cipher,
      revision: r.revision,
    };
  };
  const token = (c) =>
    c.tokenEnv
      ? process.env[c.tokenEnv] || ""
      : c.tokenCipher
        ? vault.unseal(c.tokenCipher, "telegram:token")
        : "";
  const publicConfig = () => {
    const { tokenCipher, secretCipher, ...v } = settings();
    return {
      ...v,
      tokenConfigured: !!(
        tokenCipher ||
        (v.tokenEnv && process.env[v.tokenEnv])
      ),
      webhookConfigured: !!secretCipher,
      pollingEnabled: polling && !v.publicBaseUrl,
      webhookPath: "/api/telegram/webhook",
    };
  };
  async function call(method, payload, c = settings(), file) {
    const secret = token(c);
    if (!secret) throw new HttpError(503, "Telegram Bot Token 尚未配置");
    let body, headers;
    if (file) {
      body = new FormData();
      for (const [k, v] of Object.entries(payload)) body.append(k, String(v));
      body.append("document", new Blob([file.data]), file.filename);
    } else {
      body = JSON.stringify(payload);
      headers = { "Content-Type": "application/json" };
    }
    let response, data;
    try {
      response = await fetcher(
        apiBase.replace(/\/$/, "") + "/bot" + secret + "/" + method,
        {
          method: "POST",
          redirect: "error",
          headers,
          body,
          signal: AbortSignal.timeout(15000),
        },
      );
      const text = await response.text();
      if (text.length > 1048576) throw Error("large");
      data = JSON.parse(text);
    } catch {
      throw Object.assign(Error("Telegram 网络请求结果不确定"), {
        uncertain: true,
      });
    }
    if (!response.ok || !data.ok) {
      const retry = data.parameters?.retry_after;
      throw Object.assign(
        Error(
          (
            "Telegram " +
            method +
            " 失败 (" +
            (data.error_code || response.status) +
            ")：" +
            String(data.description || "请求被拒绝").replaceAll(
              secret,
              "[hidden]",
            )
          ).slice(0, 350),
        ),
        {
          retryAfter: Number.isFinite(retry)
            ? Math.min(3600, Math.max(1, retry))
            : null,
          uncertain: response.status >= 500,
        },
      );
    }
    return data.result;
  }
  async function verify(c = settings()) {
    const bot = await call("getMe", {}, c),
      chat = await call("getChat", { chat_id: c.chatId }, c),
      member = await call(
        "getChatMember",
        { chat_id: c.chatId, user_id: bot.id },
        c,
      );
    if (chat.type !== "supergroup" || !chat.is_forum)
      throw new HttpError(400, "目标必须是启用话题的超级群组");
    if (
      !["administrator", "creator"].includes(member.status) ||
      (member.status !== "creator" && !member.can_manage_topics)
    )
      throw new HttpError(400, "机器人必须是群管理员，并具有管理话题权限");
    return {
      botId: bot.id,
      botName: bot.username || bot.first_name,
      chatName: chat.title || c.chatId,
    };
  }
  async function save(b, currentUser) {
    const old = settings();
    if (b.expectedRevision !== old.revision)
      throw new HttpError(409, "Telegram 配置已变化");
    if (
      typeof b.enabled !== "boolean" ||
      !/^-[1-9][0-9]{4,19}$/.test(String(b.chatId || "")) ||
      !Array.isArray(b.operators) ||
      b.operators.length > 100 ||
      !Number.isInteger(b.contextMessages) ||
      b.contextMessages < 0 ||
      b.contextMessages > 30
    )
      throw new HttpError(400, "群 ID、客服映射或上下文数量无效");
    const operators = b.operators.map((o) => {
      if (
        !/^[1-9][0-9]{0,15}$/.test(String(o.telegramId)) ||
        !db
          .prepare("SELECT id FROM users WHERE id=? AND active=1")
          .get(o.userId)
      )
        throw new HttpError(400, "Telegram 用户 ID 或工作台客服无效");
      return { telegramId: String(o.telegramId), userId: o.userId };
    });
    if (new Set(operators.map((o) => o.telegramId)).size !== operators.length)
      throw new HttpError(400, "Telegram 用户 ID 不能重复");
    if (b.enabled && !operators.length)
      throw new HttpError(400, "请至少绑定一位客服");
    if (b.tokenEnv && !/^FC_SECRET_[A-Z0-9_]{1,80}$/.test(b.tokenEnv))
      throw new HttpError(400, "密钥环境变量须使用 FC_SECRET_ 前缀");
    if (
      b.botToken !== undefined &&
      (typeof b.botToken !== "string" ||
        !/^\d{5,20}:[A-Za-z0-9_-]{20,150}$/.test(b.botToken))
    )
      throw new HttpError(400, "Bot Token 格式无效");
    let publicBaseUrl = String(b.publicBaseUrl || "").replace(/\/$/, "");
    if (publicBaseUrl) {
      let u;
      try {
        u = new URL(publicBaseUrl);
      } catch {
        throw new HttpError(400, "公网服务地址无效");
      }
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== "/"
      )
        throw new HttpError(400, "公网地址须为 HTTPS origin，不带路径");
    }
    const changed =
      !!b.botToken ||
      String(b.tokenEnv || "") !== old.tokenEnv ||
      String(b.chatId) !== old.chatId;
    const c = {
      enabled: b.enabled,
      chatId: String(b.chatId),
      tokenEnv: b.tokenEnv || "",
      publicBaseUrl,
      operators,
      contextMessages: b.contextMessages,
      binding: changed ? randomUUID() : old.binding,
      botId: old.botId,
      tokenCipher: b.botToken
        ? vault.seal(b.botToken, "telegram:token")
        : old.tokenCipher,
      secretCipher:
        (!changed && old.secretCipher) ||
        vault.seal(randomBytes(24).toString("hex"), "telegram:webhook"),
    };
    if (c.enabled) c.botId = (await verify(c)).botId;
    if (currentUser()?.role !== "admin")
      throw new HttpError(403, "管理员权限已变化");
    if (settings().revision !== old.revision)
      throw new HttpError(409, "配置已变化，请重试");
    const { tokenCipher, secretCipher, ...value } = c;
    db.exec("SAVEPOINT telegram_save");
    try {
      db.prepare(
        "UPDATE telegram_config SET value=?,token_cipher=?,secret_cipher=?,revision=revision+1 WHERE id=1",
      ).run(JSON.stringify(value), tokenCipher, secretCipher);
      if (changed)
        db.prepare(
          "UPDATE telegram_deliveries SET status='cancelled',error='机器人或目标群已变化' WHERE binding!=? AND status IN ('queued','sending')",
        ).run(c.binding);
      db.exec("RELEASE telegram_save");
    } catch (e) {
      db.exec("ROLLBACK TO telegram_save");
      db.exec("RELEASE telegram_save");
      throw e;
    }
    if (c.enabled)
      for (const row of db
        .prepare(
          "SELECT id FROM conversations WHERE handoff_reason!='' AND status!='closed'",
        )
        .all())
        observe(row.id);
    return publicConfig();
  }
  function queue(c, conversationId, kind, messageId = "", part = 0, text = "") {
    db.prepare(
      "INSERT OR IGNORE INTO telegram_deliveries VALUES(?,?,?,?,?,?,?,'queued',0,?,'',null,?)",
    ).run(
      randomUUID(),
      c.binding,
      conversationId,
      kind,
      messageId,
      part,
      text,
      clock(),
      now(),
    );
  }
  function observe(id) {
    if (!id || closed) return;
    const c = settings();
    if (!c.enabled) return;
    const conversation = db
      .prepare("SELECT * FROM conversations WHERE id=?")
      .get(id);
    if (
      !conversation ||
      !conversation.handoff_reason ||
      conversation.status === "closed"
    )
      return;
    const existing = db
      .prepare(
        "SELECT * FROM telegram_topics WHERE binding=? AND conversation_id=?",
      )
      .get(c.binding, id);
    if (!existing) {
      db.prepare(
        "INSERT INTO telegram_topics(binding,conversation_id,thread_id,state,created) VALUES(?,?,null,'pending',?)",
      ).run(c.binding, id, now());
      queue(c, id, "open");
    }
    const history = existing
      ? db
          .prepare(
            "SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq",
          )
          .all(id, existing.last_seq)
      : db
          .prepare(
            "SELECT * FROM messages WHERE conversation_id=? AND role!='note' AND source NOT IN ('telegram','system') ORDER BY seq DESC LIMIT ?",
          )
          .all(id, Math.max(1, c.contextMessages))
          .reverse();
    for (const m of history) {
      if (m.role === "note" || ["telegram", "system"].includes(m.source))
        continue;
      if (m.attachment_id) queue(c, id, "attachment", m.id);
      else {
        const label =
          m.role === "visitor"
            ? "客户"
            : m.source === "ai"
              ? "AI 助手"
              : "工作台客服";
        const chars = Array.from(m.body);
        for (let part = 0; part * 3400 < chars.length; part++)
          queue(
            c,
            id,
            "message",
            m.id,
            part,
            label + "：" + chars.slice(part * 3400, (part + 1) * 3400).join(""),
          );
      }
    }
    db.prepare(
      "UPDATE telegram_topics SET last_seq=? WHERE binding=? AND conversation_id=?",
    ).run(
      db
        .prepare(
          "SELECT coalesce(max(seq),0) n FROM messages WHERE conversation_id=?",
        )
        .get(id).n,
      c.binding,
      id,
    );
    wake();
  }
  async function delivery(job, c) {
    if (job.binding !== c.binding) {
      db.prepare(
        "UPDATE telegram_deliveries SET status='cancelled',error='接入绑定已变化' WHERE id=?",
      ).run(job.id);
      return;
    }
    const conv = db
      .prepare(
        "SELECT c.*,v.name FROM conversations c JOIN visitors v ON v.id=c.visitor_id WHERE c.id=?",
      )
      .get(job.conversation_id);
    if (!conv || conv.status === "closed") {
      db.prepare(
        "UPDATE telegram_deliveries SET status='cancelled',error='会话已结束' WHERE id=?",
      ).run(job.id);
      return;
    }
    const topic = db
      .prepare(
        "SELECT * FROM telegram_topics WHERE binding=? AND conversation_id=?",
      )
      .get(c.binding, conv.id);
    if (job.kind !== "open" && !topic?.thread_id) return;
    db.prepare(
      "UPDATE telegram_deliveries SET status='sending',attempts=attempts+1 WHERE id=?",
    ).run(job.id);
    try {
      let result;
      if (job.kind === "open") {
        if (topic.thread_id) {
          result = { message_thread_id: topic.thread_id };
        } else
          result = await call(
            "createForumTopic",
            {
              chat_id: c.chatId,
              name: ("[FC " + conv.id + "] " + conv.name).slice(0, 128),
            },
            c,
          );
        if (settings().binding !== c.binding) throw Error("接入绑定已变化");
        if (!Number.isSafeInteger(result.message_thread_id))
          throw Error("话题返回无效");
        db.prepare(
          "UPDATE telegram_topics SET thread_id=?,state='ready' WHERE binding=? AND conversation_id=?",
        ).run(result.message_thread_id, c.binding, conv.id);
      } else if (job.kind === "attachment") {
        const file = db
          .prepare(
            "SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.id=? AND m.role!='note'",
          )
          .get(job.message_id);
        if (!file) throw Error("附件不存在");
        result = await call(
          "sendDocument",
          {
            chat_id: c.chatId,
            message_thread_id: topic.thread_id,
            caption: "会话附件：" + file.filename,
          },
          c,
          file,
        );
      } else
        result = await call(
          "sendMessage",
          {
            chat_id: c.chatId,
            message_thread_id: topic.thread_id,
            text: job.text,
            link_preview_options: { is_disabled: true },
          },
          c,
        );
      db.prepare(
        "UPDATE telegram_deliveries SET status='sent',remote_id=?,error='' WHERE id=?",
      ).run(result.message_id || result.message_thread_id || null, job.id);
    } catch (error) {
      const again = !!error.retryAfter && job.attempts < 4;
      db.prepare(
        "UPDATE telegram_deliveries SET status=?,available=?,error=? WHERE id=?",
      ).run(
        error.uncertain ? "uncertain" : again ? "queued" : "failed",
        clock() + (error.retryAfter || 1) * 1000,
        error.message,
        job.id,
      );
    }
  }
  async function download(fileId, c) {
    const info = await call("getFile", { file_id: fileId }, c);
    if (
      info.file_size > MAX_UPLOAD ||
      typeof info.file_path !== "string" ||
      !/^[-A-Za-z0-9_./]+$/.test(info.file_path) ||
      info.file_path.split("/").includes("..") ||
      info.file_path.startsWith("/")
    )
      throw Error("Telegram 附件路径或大小无效");
    let response;
    try {
      response = await fetcher(
        apiBase.replace(/\/$/, "") +
          "/file/bot" +
          token(c) +
          "/" +
          info.file_path,
        { redirect: "error", signal: AbortSignal.timeout(15000) },
      );
    } catch {
      throw Error("Telegram 附件下载失败");
    }
    if (
      !response.ok ||
      Number(response.headers.get("content-length")) > MAX_UPLOAD
    )
      throw Error("Telegram 附件下载失败或超过 8 MB");
    let size = 0,
      chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw Error("Telegram 附件超过 8 MB");
      chunks.push(chunk);
    }
    if (!size) throw Error("Telegram 附件为空");
    return Buffer.concat(chunks);
  }
  async function incoming(row, c) {
    const update = JSON.parse(row.payload),
      m = update.message,
      operator = c.operators.find((o) => o.telegramId === String(m.from?.id)),
      user =
        operator &&
        db
          .prepare("SELECT id,name,role FROM users WHERE id=? AND active=1")
          .get(operator.userId),
      topic = db
        .prepare(
          "SELECT * FROM telegram_topics WHERE binding=? AND thread_id=?",
        )
        .get(c.binding, m.message_thread_id);
    const conv =
      topic &&
      db
        .prepare("SELECT * FROM conversations WHERE id=?")
        .get(topic.conversation_id);
    if (!user || !conv || conv.status === "closed" || !canAccess(user, conv)) {
      db.prepare(
        "UPDATE telegram_updates SET status='ignored',error='客服权限、话题或会话状态不允许回复' WHERE binding=? AND update_id=?",
      ).run(row.binding, row.update_id);
      return;
    }
    const clientId = "tg_" + c.binding.replaceAll("-", "") + "_" + m.message_id;
    try {
      let file;
      const f = m.document || m.photo?.at(-1) || m.voice || m.video;
      if (f) {
        if (f.file_size > MAX_UPLOAD) throw Error("附件超过 8 MB");
        file = {
          data: await download(f.file_id, c),
          filename: (
            m.document?.file_name ||
            (m.photo
              ? "telegram-photo.jpg"
              : m.voice
                ? "telegram-voice.ogg"
                : "telegram-video.mp4")
          )
            .replace(/[\\/\x00-\x1f]/g, "_")
            .slice(0, 200),
        };
      }
      if (
        settings().binding !== c.binding ||
        !settings().enabled ||
        !settings().operators.some(
          (o) => o.telegramId === String(m.from?.id) && o.userId === user.id,
        )
      )
        throw Error("接入配置已变化");
      const currentUser = db
          .prepare("SELECT id,name,role FROM users WHERE id=? AND active=1")
          .get(user.id),
        currentConv = db
          .prepare("SELECT * FROM conversations WHERE id=?")
          .get(conv.id);
      if (
        !currentUser ||
        !currentConv ||
        currentConv.status === "closed" ||
        !canAccess(currentUser, currentConv)
      )
        throw Error("客服权限或会话状态已变化");
      db.exec("SAVEPOINT telegram_reply");
      try {
        const ids = [];
        if (file)
          ids.push(
            storeAttachment(db, {
              conversationId: conv.id,
              user: currentUser,
              ...file,
              clientId: clientId + "_file",
            }).id,
          );
        const text = m.text || m.caption;
        if (text)
          ids.push(
            insertStaffMessage(db, currentUser, conv.id, {
              body: text,
              clientId: clientId + "_text",
            }).id,
          );
        if (!ids.length) throw Error("仅支持文本、图片和文件类消息");
        for (const id of ids)
          db.prepare("UPDATE messages SET source='telegram' WHERE id=?").run(
            id,
          );
        db.prepare(
          "UPDATE telegram_updates SET status='done',error='' WHERE binding=? AND update_id=?",
        ).run(row.binding, row.update_id);
        db.exec("RELEASE telegram_reply");
      } catch (e) {
        db.exec("ROLLBACK TO telegram_reply");
        db.exec("RELEASE telegram_reply");
        throw e;
      }
      broadcast(conv.id);
    } catch (error) {
      db.prepare(
        "UPDATE telegram_updates SET status='failed',attempts=attempts+1,error=? WHERE binding=? AND update_id=?",
      ).run(error.message, row.binding, row.update_id);
    }
  }
  async function webhook({ req, res, body, send }) {
    const c = settings();
    if (!c.secretCipher) throw new HttpError(403, "回调未配置");
    const actual = String(req.headers["x-telegram-bot-api-secret-token"] || ""),
      expected = vault.unseal(c.secretCipher, "telegram:webhook");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      throw new HttpError(403, "回调凭据无效");
    const accepted = enqueue(await body(req), c);
    send(res, 200, { ok: true, ...(accepted ? {} : { ignored: true }) });
    if (accepted) wake();
  }
  function enqueue(u, c) {
    const m = u.message;
    if (!Number.isSafeInteger(u.update_id) || u.update_id < 0)
      throw new HttpError(400, "Update ID 无效");
    if (
      !c.enabled ||
      !m ||
      String(m.chat?.id) !== c.chatId ||
      !m.message_thread_id ||
      m.from?.is_bot ||
      m.sender_chat ||
      !c.operators.some((o) => o.telegramId === String(m.from?.id))
    )
      return false;
    if (
      !Number.isSafeInteger(m.message_id) ||
      !db
        .prepare(
          "SELECT thread_id FROM telegram_topics WHERE binding=? AND thread_id=?",
        )
        .get(c.binding, m.message_thread_id)
    )
      return false;
    if (
      db
        .prepare(
          "SELECT count(*) n FROM telegram_updates WHERE status IN ('queued','processing')",
        )
        .get().n >= 1000
    )
      throw new HttpError(503, "回调队列已满");
    db.prepare(
      "INSERT OR IGNORE INTO telegram_updates VALUES(?,?,?,'queued',0,?,'',?)",
    ).run(c.binding, u.update_id, JSON.stringify(u), clock(), now());
    return true;
  }
  async function poll() {
    if (!polling || pollingBusy || closed) return;
    const c = settings();
    if (!c.enabled || c.publicBaseUrl) return;
    pollingBusy = true;
    try {
      const offset =
        db
          .prepare("SELECT offset FROM telegram_poll_offsets WHERE binding=?")
          .get(c.binding)?.offset || 0;
      const updates = await call(
        "getUpdates",
        { offset, limit: 100, timeout: 0, allowed_updates: ["message"] },
        c,
      );
      if (!Array.isArray(updates)) throw Error("Telegram 更新格式无效");
      for (const update of updates) {
        if (
          settings().binding !== c.binding ||
          !settings().enabled ||
          settings().publicBaseUrl
        )
          break;
        db.exec("SAVEPOINT telegram_poll");
        try {
          enqueue(update, c);
          db.prepare(
            "INSERT INTO telegram_poll_offsets(binding,offset) VALUES(?,?) ON CONFLICT(binding) DO UPDATE SET offset=max(offset,excluded.offset)",
          ).run(c.binding, update.update_id + 1);
          db.exec("RELEASE telegram_poll");
        } catch (error) {
          db.exec("ROLLBACK TO telegram_poll");
          db.exec("RELEASE telegram_poll");
          throw error;
        }
      }
      wake();
    } finally {
      pollingBusy = false;
    }
  }
  async function tick() {
    if (busy || closed) return;
    busy = true;
    try {
      const c = settings();
      if (!c.enabled) return;
      const update = db
        .prepare(
          "SELECT * FROM telegram_updates WHERE binding=? AND status='queued' AND available<=? ORDER BY update_id LIMIT 1",
        )
        .get(c.binding, clock());
      if (update) {
        db.prepare(
          "UPDATE telegram_updates SET status='processing' WHERE binding=? AND update_id=?",
        ).run(c.binding, update.update_id);
        try {
          await incoming(update, c);
        } catch {
          db.prepare(
            "UPDATE telegram_updates SET status='failed',error='处理回复失败' WHERE binding=? AND update_id=?",
          ).run(c.binding, update.update_id);
        }
      }
      const job = db
        .prepare(
          "SELECT d.* FROM telegram_deliveries d WHERE binding=? AND status='queued' AND available<=? AND (kind='open' OR EXISTS(SELECT 1 FROM telegram_topics t WHERE t.binding=d.binding AND t.conversation_id=d.conversation_id AND t.thread_id IS NOT NULL)) ORDER BY created,d.rowid LIMIT 1",
        )
        .get(c.binding, clock());
      if (job) await delivery(job, c);
    } finally {
      busy = false;
    }
  }
  function wake() {
    if (autostart && !closed) setTimeout(() => tick().catch(() => {}), 0);
  }
  if (autostart) {
    timer = setInterval(() => tick().catch(() => {}), 1000);
    timer.unref();
    if (polling) {
      pollTimer = setInterval(() => poll().catch(() => {}), 3000);
      pollTimer.unref();
      poll().catch(() => {});
    }
  }
  async function handle({ req, res, url, u, body, send, currentUser }) {
    const p = url.pathname;
    if (p === "/api/access/telegram" && req.method === "GET") {
      send(res, 200, publicConfig());
      return true;
    }
    if (p === "/api/access/telegram" && req.method === "PUT") {
      send(res, 200, await save(await body(req), currentUser));
      return true;
    }
    if (p === "/api/access/telegram/test" && req.method === "POST") {
      send(res, 200, await verify());
      return true;
    }
    if (p === "/api/access/telegram/webhook" && req.method === "POST") {
      const c = settings();
      if (!c.publicBaseUrl || !c.secretCipher)
        throw new HttpError(400, "请先保存公网 HTTPS 地址与 Bot 配置");
      send(res, 200, {
        ok: await call(
          "setWebhook",
          {
            url: c.publicBaseUrl + "/api/telegram/webhook",
            secret_token: vault.unseal(c.secretCipher, "telegram:webhook"),
            allowed_updates: ["message"],
            drop_pending_updates: false,
          },
          c,
        ),
      });
      return true;
    }
    if (p === "/api/access/telegram/status" && req.method === "GET") {
      const c = settings();
      send(res, 200, {
        topics: db
          .prepare(
            "SELECT t.*,v.name,c.status conversation_status FROM telegram_topics t JOIN conversations c ON c.id=t.conversation_id JOIN visitors v ON v.id=c.visitor_id WHERE binding=? ORDER BY created DESC LIMIT 100",
          )
          .all(c.binding),
        deliveries: db
          .prepare(
            "SELECT id,conversation_id,kind,status,attempts,error,created FROM telegram_deliveries WHERE binding=? ORDER BY created DESC,rowid DESC LIMIT 100",
          )
          .all(c.binding),
        updates: db
          .prepare(
            "SELECT update_id,status,error,created FROM telegram_updates WHERE binding=? ORDER BY update_id DESC LIMIT 100",
          )
          .all(c.binding),
      });
      return true;
    }
    const retry = p.match(
      /^\/api\/access\/telegram\/deliveries\/([^/]+)\/retry$/,
    );
    if (retry && req.method === "POST") {
      db.prepare(
        "UPDATE telegram_deliveries SET status='queued',available=?,error='' WHERE id=? AND binding=? AND status IN ('failed','uncertain')",
      ).run(clock(), retry[1], settings().binding);
      send(res, 200, { ok: true });
      wake();
      return true;
    }
    const updateRetry = p.match(
      /^\/api\/access\/telegram\/updates\/([0-9]+)\/retry$/,
    );
    if (updateRetry && req.method === "POST") {
      db.prepare(
        "UPDATE telegram_updates SET status='queued',available=?,error='' WHERE update_id=? AND binding=? AND status='failed'",
      ).run(clock(), Number(updateRetry[1]), settings().binding);
      send(res, 200, { ok: true });
      wake();
      return true;
    }
    const bind = p.match(/^\/api\/access\/telegram\/topics\/([^/]+)$/);
    if (bind && req.method === "PUT") {
      const b = await body(req);
      if (currentUser()?.role !== "admin")
        throw new HttpError(403, "管理员权限已变化");
      if (!Number.isSafeInteger(b.threadId) || b.threadId < 1)
        throw new HttpError(400, "话题 ID 无效");
      const c = settings();
      if (
        !db
          .prepare(
            "SELECT conversation_id FROM telegram_topics WHERE binding=? AND conversation_id=?",
          )
          .get(c.binding, bind[1])
      )
        throw new HttpError(404, "会话话题不存在");
      db.prepare(
        "UPDATE telegram_topics SET thread_id=?,state='ready' WHERE binding=? AND conversation_id=?",
      ).run(b.threadId, c.binding, bind[1]);
      db.prepare(
        "UPDATE telegram_deliveries SET status='sent',error='管理员绑定已有话题' WHERE binding=? AND conversation_id=? AND kind='open'",
      ).run(c.binding, bind[1]);
      send(res, 200, { ok: true });
      wake();
      return true;
    }
    return false;
  }
  return {
    handle,
    webhook,
    observe,
    tick,
    poll,
    settings: publicConfig,
    close() {
      closed = true;
      clearInterval(timer);
      clearInterval(pollTimer);
    },
  };
}
