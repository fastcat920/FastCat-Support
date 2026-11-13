import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createUserPush } from "../lib/user-push.mjs";
function setup(transport) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE visitors(id TEXT,token TEXT);CREATE TABLE conversations(id TEXT,visitor_id TEXT);CREATE TABLE messages(id TEXT,conversation_id TEXT,role TEXT,source TEXT,seq INTEGER);CREATE TABLE message_receipts(conversation_id TEXT,actor TEXT,read_seq INTEGER);INSERT INTO visitors VALUES('v1','secret1'),('v2','secret2');INSERT INTO conversations VALUES('c1','v1'),('c2','v2');`,
  );
  let now = 100000;
  const push = createUserPush(db, {
    apns: transport,
    fcm: transport,
    clock: () => now,
  });
  const c1 = { id: "c1", visitor_id: "v1", token: "secret1" },
    c2 = { id: "c2", visitor_id: "v2", token: "secret2" };
  const bind = (c, deviceId = "installation_001", provider = "apns") =>
    push.handle(c, "PUT", {
      deviceId,
      provider,
      token:
        provider === "apns" ? "a".repeat(64) : "fcm_registration_token_123456",
      environment: "sandbox",
    });
  const message = (
    id,
    conv = "c1",
    role = "agent",
    source = "manual",
    seq = 1,
  ) =>
    db
      .prepare("INSERT INTO messages VALUES(?,?,?,?,?)")
      .run(id, conv, role, source, seq);
  return { db, push, c1, c2, bind, message, advance: () => (now += 70000) };
}
test("replies only notify the exact bound conversation, exclude internal/system and deduplicate", async () => {
  const calls = [];
  const x = setup({
    configured: true,
    send: async (d, p) => {
      calls.push({ d, p });
      return { status: 200 };
    },
  });
  x.bind(x.c1);
  x.message("reply");
  x.message("other", "c2");
  x.message("private", "c1", "note");
  x.message("system", "c1", "agent", "system");
  x.message("customer", "c1", "visitor");
  x.push.observe("c1");
  x.push.observe("c1");
  x.push.observe("c2");
  await x.push.drain();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p.type, "support.reply");
  assert.equal(calls[0].p.conversationId, "c1");
  assert.equal(calls[0].p.aps.badge, 1);
  assert.ok(!JSON.stringify(calls[0].p).includes("secret1"));
  x.db.close();
});
test("foreground/read suppression, account switch and stale credentials cancel pending jobs", async () => {
  let sent = 0;
  const x = setup({
    configured: true,
    send: async () => {
      sent++;
      return { status: 200 };
    },
  });
  x.bind(x.c1);
  x.push.handle(x.c1, "PATCH", {
    deviceId: "installation_001",
    foreground: true,
  });
  x.message("foreground");
  x.push.observe("c1");
  await x.push.drain();
  assert.equal(sent, 0);
  x.advance();
  x.message("switch");
  x.push.observe("c1");
  x.bind(x.c2);
  await x.push.drain();
  assert.equal(sent, 0);
  x.bind(x.c1);
  x.message("read", "c1", "agent", "ai", 3);
  x.push.observe("c1");
  x.db.exec("INSERT INTO message_receipts VALUES('c1','visitor',3)");
  await x.push.drain();
  assert.equal(sent, 0);
  x.message("rotated", "c1", "agent", "ai", 4);
  x.push.observe("c1");
  x.db.exec("UPDATE visitors SET token='new' WHERE id='v1'");
  await x.push.drain();
  assert.equal(sent, 0);
  x.db.close();
});
test("retry, invalid tokens, cross-conversation deletion and provider configuration", async () => {
  let calls = 0;
  const x = setup({
    configured: true,
    send: async () => ({ status: ++calls === 1 ? 503 : 410 }),
  });
  x.bind(x.c1, "installation_001", "fcm");
  x.push.handle(x.c2, "DELETE", { deviceId: "installation_001" });
  assert.equal(
    x.db.prepare("SELECT count(*) n FROM user_push_devices").get().n,
    1,
  );
  x.message("retry");
  x.push.observe("c1");
  await x.push.drain();
  assert.equal(calls, 1);
  x.advance();
  await x.push.drain();
  assert.equal(calls, 2);
  assert.equal(
    x.db.prepare("SELECT enabled FROM user_push_devices").get().enabled,
    0,
  );
  assert.deepEqual(x.push.handle(x.c1, "GET", {}).configured, {
    apns: true,
    fcm: true,
  });
  assert.throws(
    () =>
      x.push.handle(x.c1, "PUT", {
        deviceId: "installation_001",
        provider: "arbitrary",
        token: "abc",
      }),
    { status: 400 },
  );
  x.db.close();
});

test("FCM signs OAuth assertion, reuses access token and maps unregistered devices", async () => {
  const { createFCM } = await import("../lib/user-push.mjs");
  const { generateKeyPairSync, verify } = await import("node:crypto");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fcm-test-"));
  const file = join(dir, "account.json");
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(
    file,
    JSON.stringify({
      client_email: "test@example.test",
      project_id: "project",
      private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  let oauth = 0,
    sends = 0;
  try {
    const fcm = createFCM(
      { USER_FCM_SERVICE_ACCOUNT_FILE: file },
      async (url, options) => {
        if (url === "https://oauth2.googleapis.com/token") {
          oauth++;
          const assertion = options.body.get("assertion");
          const parts = assertion.split(".");
          assert.ok(
            verify(
              "RSA-SHA256",
              Buffer.from(parts[0] + "." + parts[1]),
              keys.publicKey,
              Buffer.from(parts[2], "base64url"),
            ),
          );
          assert.equal(JSON.parse(Buffer.from(parts[1], "base64url")).aud, url);
          return {
            ok: true,
            json: async () => ({
              access_token: "test-oauth",
              expires_in: 3600,
            }),
          };
        }
        sends++;
        assert.equal(options.headers.Authorization, "Bearer test-oauth");
        const b = JSON.parse(options.body);
        assert.equal(
          b.message.android.notification.channel_id,
          "fastcat_support",
        );
        assert.equal(b.message.data.conversationId, "c");
        return sends === 1
          ? { ok: true, json: async () => ({ name: "message" }) }
          : {
              ok: false,
              status: 404,
              json: async () => ({
                error: {
                  details: [
                    {
                      "@type":
                        "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                      errorCode: "UNREGISTERED",
                    },
                  ],
                },
              }),
            };
      },
    );
    const payload = {
      aps: { alert: { title: "Support", body: "New reply" }, badge: 1 },
      conversationId: "c",
      messageId: "m",
      type: "support.reply",
    };
    assert.equal((await fcm.send({ token: "test" }, payload)).status, 200);
    assert.equal((await fcm.send({ token: "test" }, payload)).status, 410);
    assert.equal(oauth, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unconfigured APNs cannot starve FCM and a restart reconciles durable events", async () => {
  const x = setup({ configured: false });
  let sent = 0;
  const push = createUserPush(x.db, {
    apns: { configured: false },
    fcm: {
      configured: true,
      send: async () => {
        sent++;
        return { status: 200 };
      },
    },
    clock: () => 100000,
  });
  for (let i = 0; i < 20; i++)
    push.handle(x.c1, "PUT", {
      deviceId: "installation_apns_" + i,
      provider: "apns",
      token: i.toString(16).padStart(64, "0"),
    });
  push.handle(x.c1, "PUT", {
    deviceId: "installation_fcm_01",
    provider: "fcm",
    token: "fcm_registration_token_123456",
  });
  x.message("durable"); // no observe/broadcast: simulate process exit immediately after insert
  const restarted = createUserPush(x.db, {
    apns: { configured: false },
    fcm: {
      configured: true,
      send: async () => {
        sent++;
        return { status: 200 };
      },
    },
    clock: () => 100000,
  });
  await restarted.drain();
  assert.equal(sent, 1);
  assert.equal(
    x.db
      .prepare("SELECT count(*) n FROM user_push_jobs WHERE state='pending'")
      .get().n,
    20,
  );
  await restarted.drain();
  assert.equal(sent, 1);
  x.db.close();
});
test("failed enqueue rolls back seen markers and retries durable event", async () => {
  const x = setup({ configured: true, send: async () => ({ status: 200 }) });
  x.bind(x.c1);
  x.message("recover");
  x.db.exec(
    "CREATE TRIGGER reject_job BEFORE INSERT ON user_push_jobs BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;",
  );
  assert.throws(() => x.push.observe("c1"));
  assert.equal(
    x.db.prepare("SELECT count(*) n FROM user_push_seen").get().n,
    0,
  );
  assert.equal(
    x.db.prepare("SELECT count(*) n FROM user_push_events").get().n,
    1,
  );
  x.db.exec("DROP TRIGGER reject_job");
  await x.push.drain();
  assert.equal(
    x.db.prepare("SELECT state FROM user_push_jobs").get().state,
    "sent",
  );
  x.db.close();
});
