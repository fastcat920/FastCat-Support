import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPushSettings } from "../lib/push-settings.mjs";
const ec = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  }).privateKey.export({ type: "pkcs8", format: "pem" }),
  rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
const config = {
  keyId: "ABC1234567",
  teamId: "TEAM123456",
  topic: "com.fastcat.app",
};
const account = {
  type: "service_account",
  project_id: "sample-project",
  client_email: "firebase@sample-project.iam.gserviceaccount.com",
  private_key: rsa,
};
const admin = { id: "admin", role: "admin" };
function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "push-config-")),
    db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE audit_logs(id TEXT,actor_id TEXT,action TEXT,target_id TEXT,details TEXT,created TEXT)",
  );
  const sent = [];
  let release;
  const apnsFactory = (env) => ({
    configured: !!(env.APNS_PRIVATE_KEY || env.APNS_KEY_FILE),
    send: async (d, p) => {
      sent.push({ env, d, p });
      return { status: 400, reason: "BadDeviceToken" };
    },
  });
  const fcmFactory = (env) => ({
    configured: !!env.USER_FCM_SERVICE_ACCOUNT,
    send: async (d, p, o) => {
      sent.push({ env, d, p, o });
      return { status: 503, reason: "INVALID_ARGUMENT" };
    },
  });
  const service = createPushSettings({
    db,
    keyPath: join(dir, "master.key"),
    env: {},
    apnsFactory,
    fcmFactory,
    ...options,
  });
  return {
    db,
    service,
    sent,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("APNs credentials are encrypted, never returned, update live and can be disabled/reset", async () => {
  const x = setup();
  try {
    const transport = x.service.transport("staff_apns");
    assert.equal(transport.configured, false);
    let state = x.service.save(
      "staff_apns",
      { expectedRevision: 0, enabled: true, config, credential: ec },
      admin,
    );
    assert.equal(state.configured, true);
    assert.ok(!JSON.stringify(state).includes("PRIVATE KEY"));
    assert.ok(
      !x.db
        .prepare("SELECT secret FROM push_settings")
        .get()
        .secret.includes(ec),
    );
    assert.equal(transport.configured, true);
    await transport.send({}, {});
    assert.equal(x.sent[0].env.APNS_PRIVATE_KEY, ec);
    state = x.service.save(
      "staff_apns",
      { expectedRevision: state.revision, enabled: false, config },
      admin,
    );
    assert.equal(transport.configured, false);
    assert.equal(state.hasCredential, true);
    assert.throws(
      () =>
        x.service.save(
          "staff_apns",
          { expectedRevision: 0, enabled: true, config },
          admin,
        ),
      (e) => e.status === 409,
    );
    const clear = await handle(
      x.service,
      "DELETE",
      "/api/push-config/staff_apns",
      { expectedRevision: state.revision },
    );
    assert.equal(clear.body.source, "environment");
    assert.equal(transport.configured, false);
  } finally {
    x.close();
  }
});
async function handle(service, method, path, b = {}, u = admin, currentUser) {
  let response;
  await service.handle({
    req: { method },
    res: {},
    url: new URL("http://localhost" + path),
    u,
    currentUser,
    body: async () => b,
    send: (_, status, body) => (response = { status, body }),
  });
  return response;
}
test("FCM only stores required service account data and tests with validate_only", async () => {
  const x = setup();
  try {
    const state = x.service.save(
      "user_fcm",
      {
        expectedRevision: 0,
        enabled: true,
        credential: JSON.stringify({
          ...account,
          token_uri: "https://evil.invalid",
        }),
      },
      admin,
    );
    assert.deepEqual(state.config, {
      projectId: account.project_id,
      clientEmail: account.client_email,
    });
    assert.ok(!JSON.stringify(state).includes(rsa));
    const result = await x.service.test("user_fcm", admin);
    assert.equal(result.state, "reachable");
    assert.equal(result.deliveryVerified, false);
    assert.equal(x.sent[0].o.validateOnly, true);
    assert.equal(x.sent[0].env.USER_FCM_SERVICE_ACCOUNT.token_uri, undefined);
    assert.equal(x.service.state("user_fcm").test.state, "reachable");
  } finally {
    x.close();
  }
});
test("invalid credentials, stale writes and non-admin operations are rejected", async () => {
  const x = setup();
  try {
    for (const b of [
      { enabled: true, config, credential: rsa },
      {
        enabled: true,
        config: { ...config, topic: "https://bad" },
        credential: ec,
      },
    ])
      assert.throws(
        () =>
          x.service.save("staff_apns", { expectedRevision: 0, ...b }, admin),
        (e) => e.status === 400,
      );
    assert.throws(
      () =>
        x.service.save(
          "user_fcm",
          {
            expectedRevision: 0,
            enabled: true,
            credential: JSON.stringify({ project_info: {} }),
          },
          admin,
        ),
      (e) => e.status === 400,
    );
    for (const [method, path] of [
      ["GET", "/api/push-config"],
      ["PUT", "/api/push-config/user_fcm"],
      ["POST", "/api/push-config/user_fcm/test"],
      ["DELETE", "/api/push-config/user_fcm"],
    ])
      await assert.rejects(
        handle(x.service, method, path, {}, { id: "staff", role: "agent" }),
        (e) => e.status === 403,
      );
    await assert.rejects(
      handle(x.service, "PUT", "/api/push-config/user_fcm", {}, admin, () => ({
        role: "agent",
      })),
      (e) => e.status === 403,
    );
    const disabled = x.service.save(
      "user_fcm",
      { expectedRevision: 0, enabled: false },
      admin,
    );
    assert.equal(disabled.configured, false);
  } finally {
    x.close();
  }
});
test("clearing and recreating a channel never reuses a stale revision", async () => {
  const x = setup();
  try {
    let s = x.service.save(
      "staff_apns",
      { expectedRevision: 0, enabled: true, config, credential: ec },
      admin,
    );
    await handle(x.service, "DELETE", "/api/push-config/staff_apns", {
      expectedRevision: s.revision,
    });
    const replacement = x.service.save(
      "staff_apns",
      { expectedRevision: 0, enabled: true, config, credential: ec },
      admin,
    );
    assert.ok(replacement.revision > s.revision);
  } finally {
    x.close();
  }
});

test("failed audit rolls back configuration changes and retains the active transport", async () => {
  const x = setup();
  try {
    const state = x.service.save(
      "staff_apns",
      { expectedRevision: 0, enabled: true, config, credential: ec },
      admin,
    );
    x.db.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;",
    );
    assert.throws(() =>
      x.service.save(
        "staff_apns",
        { expectedRevision: state.revision, enabled: false, config },
        admin,
      ),
    );
    assert.equal(x.service.state("staff_apns").revision, state.revision);
    assert.equal(x.service.transport("staff_apns").configured, true);
  } finally {
    x.close();
  }
});

test("a delayed connection test cannot mark a replacement configuration as tested", async () => {
  let finish;
  const x = setup({
    apnsFactory: () => ({
      configured: true,
      send: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    }),
  });
  try {
    const original = x.service.save(
      "staff_apns",
      { expectedRevision: 0, enabled: true, config, credential: ec },
      admin,
    );
    const pending = x.service.test("staff_apns", admin);
    x.service.save(
      "staff_apns",
      {
        expectedRevision: original.revision,
        enabled: true,
        config: { ...config, topic: "com.fastcat.replacement" },
      },
      admin,
    );
    finish({ status: 400, reason: "BadDeviceToken" });
    await assert.rejects(pending, (e) => e.status === 409);
    assert.equal(x.service.state("staff_apns").test, null);
  } finally {
    x.close();
  }
});
test("environment test status persists without returning credential paths", async () => {
  const x = setup({
    env: {
      APNS_KEY_FILE: "/private/do-not-expose.p8",
      APNS_KEY_ID: config.keyId,
      APNS_TEAM_ID: config.teamId,
      APNS_TOPIC: config.topic,
    },
  });
  try {
    assert.equal(x.service.state("staff_apns").configured, true);
    await x.service.test("staff_apns", admin);
    const state = x.service.state("staff_apns");
    assert.equal(state.test.state, "reachable");
    assert.ok(!JSON.stringify(state).includes("/private/"));
  } finally {
    x.close();
  }
});
