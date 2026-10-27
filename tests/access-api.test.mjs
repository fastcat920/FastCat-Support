import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "fc-access-api-")),
  base = "http://127.0.0.1:14380";
let child, cookie;
async function call(path, method = "GET", data, headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Cookie: cookie || "",
      "Content-Type": "application/json",
      ...headers,
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const raw = await r.text();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  return { status: r.status, data: value, headers: r.headers };
}
before(async () => {
  child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: "14380", DB_PATH: join(dir, "test.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error("Server failed");
    }),
  ]);
  const r = await call("/api/setup", "POST", {
    name: "平台管理员",
    email: "platform@local.test",
    password: "platform-test-2026",
  });
  assert.equal(r.status, 200);
  cookie = r.headers.get("set-cookie").split(";")[0];
});
after(async () => {
  child.kill();
  await once(child, "exit");
  rmSync(dir, { recursive: true, force: true });
});
test("visitor API supports SDK origin CORS while staff APIs remain same-origin; sessions cannot cross platform keys", async () => {
  const channels = (await call("/api/access/channels")).data;
  assert.equal(channels.length, 2);
  const sdk = channels.find((c) => c.type === "sdk"),
    web = channels.find((c) => c.type === "web");
  const endpoint = "/api/access/channels/" + sdk.id;
  assert.equal(
    (
      await call(endpoint, "PUT", {
        ...sdk,
        origins: ["https://app.example.com"],
        expectedRevision: 0,
      })
    ).status,
    200,
  );
  const headers = { Origin: "https://app.example.com" };
  const preflight = await call(
    "/api/widget/start?appKey=" + sdk.public_key,
    "OPTIONS",
    undefined,
    headers,
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    headers.Origin,
  );
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  assert.equal(
    (
      await call(
        "/api/access/channels/" + web.id,
        "PUT",
        { ...web, expectedRevision: 0 },
        headers,
      )
    ).status,
    403,
  );
  const visitor = await call(
    "/api/widget/start?appKey=" + sdk.public_key,
    "POST",
    { email: "flutter@example.test" },
    headers,
  );
  assert.equal(visitor.status, 201);
  const auth = { ...headers, Authorization: "Bearer " + visitor.data.token };
  const sent = await call(
    "/api/widget/messages?appKey=" + sdk.public_key,
    "POST",
    {
      id: visitor.data.id,
      body: "Flutter 消息",
      clientId: "sdk_message_00001",
    },
    auth,
  );
  assert.equal(sent.status, 201);
  const page = await call(
    "/api/widget?id=" + visitor.data.id + "&after=0&appKey=" + sdk.public_key,
    "GET",
    undefined,
    auth,
  );
  assert.equal(page.data.messages.at(-1).body, "Flutter 消息");
  assert.equal(
    (
      await call(
        "/api/widget?id=" + visitor.data.id + "&appKey=" + web.public_key,
        "GET",
        undefined,
        { Authorization: auth.Authorization },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/widget/handoff?appKey=" + sdk.public_key,
        "POST",
        { id: visitor.data.id },
        auth,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(endpoint, "PUT", {
        ...sdk,
        enabled: false,
        origins: [],
        expectedRevision: 1,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/api/widget?id=" + visitor.data.id + "&appKey=" + sdk.public_key,
        "GET",
        undefined,
        { Authorization: auth.Authorization },
      )
    ).status,
    403,
  );
});
test("Telegram webhook cannot create sessions from private BOT contact or unauthenticated callbacks", async () => {
  const before = (await call("/api/conversations")).data.length;
  assert.equal(
    (
      await call("/api/telegram/webhook", "POST", {
        update_id: 1,
        message: { from: { id: 123 }, chat: { id: 123 }, text: "联系人工" },
      })
    ).status,
    403,
  );
  assert.equal((await call("/api/conversations")).data.length, before);
});
test("new site instances publish appearance, retain sessions across key rotation and disable without deleting history", async () => {
  const created = await call("/api/access/channels", "POST", {
    type: "web",
    name: "独立网站",
    title: "专属客服",
    enabled: true,
    origins: [],
    ai_mode: "off",
    widget: {
      themeColor: "#146355",
      position: "top-left",
      welcomeMessage: "欢迎来到独立网站",
      logoUrl: "https://assets.example.com/logo.png",
    },
  });
  assert.equal(created.status, 201);
  let p = created.data;
  const config = await call("/api/widget/config?appKey=" + p.public_key);
  assert.equal(config.data.widget.themeColor, "#146355");
  assert.equal(config.data.title, "专属客服");
  const visitor = (
    await call("/api/widget/start?appKey=" + p.public_key, "POST", {
      email: "site@example.test",
    })
  ).data;
  let page = await call(
    "/api/widget?id=" + visitor.id + "&appKey=" + p.public_key,
    "GET",
    undefined,
    { Authorization: "Bearer " + visitor.token },
  );
  assert.ok(page.data.messages.some((m) => m.body === "欢迎来到独立网站"));
  const frame = await call("/widget?appKey=" + p.public_key);
  assert.match(
    frame.headers.get("content-security-policy"),
    /img-src 'self' blob: https:/,
  );
  const oldKey = p.public_key;
  p = (
    await call("/api/access/channels/" + p.id + "/rotate", "POST", {
      expectedRevision: p.revision,
    })
  ).data;
  assert.equal((await call("/api/widget/config?appKey=" + oldKey)).status, 403);
  page = await call(
    "/api/widget?id=" + visitor.id + "&appKey=" + p.public_key,
    "GET",
    undefined,
    { Authorization: "Bearer " + visitor.token },
  );
  assert.equal(page.status, 200);
  assert.equal(
    (
      await call("/api/access/channels/" + p.id, "DELETE", {
        expectedRevision: p.revision,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call("/api/access/channels/" + p.id + "/restore", "POST", {
        expectedRevision: p.revision,
      })
    ).status,
    404,
  );
  p = (
    await call("/api/access/channels/" + p.id, "PUT", {
      ...p,
      enabled: false,
      expectedRevision: p.revision,
    })
  ).data;
  assert.equal(
    (await call("/api/widget/config?appKey=" + p.public_key)).status,
    403,
  );
  assert.ok(
    (await call("/api/conversations")).data.some((c) => c.id === visitor.id),
  );
  assert.ok(
    (await call("/api/access/channels")).data.some((c) => c.id === p.id),
  );
});

test("local file access is opt-in for web channels and custom icon URL is validated", async () => {
  const channels = (await call("/api/access/channels")).data;
  const web = channels.find((c) => c.type === "web");
  const configPath = "/api/widget/config?appKey=" + web.public_key;
  assert.equal(
    (await call(configPath, "GET", undefined, { Origin: "null" })).status,
    403,
  );
  assert.equal(
    (
      await call("/api/access/channels/" + web.id, "PUT", {
        ...web,
        widget: { ...web.widget, launcherIconUrl: "javascript:alert(1)" },
        expectedRevision: web.revision,
      })
    ).status,
    400,
  );
  const changed = await call("/api/access/channels/" + web.id, "PUT", {
    ...web,
    widget: {
      ...web.widget,
      allowLocalFilePreview: true,
      launcherIconUrl: "https://assets.example.com/support.png",
    },
    expectedRevision: web.revision,
  });
  assert.equal(changed.status, 200);
  const result = await call(configPath, "GET", undefined, { Origin: "null" });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("access-control-allow-origin"), "null");
  assert.equal(
    result.data.widget.launcherIconUrl,
    "https://assets.example.com/support.png",
  );
  const page = await fetch(base + "/widget?appKey=" + web.public_key);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors[^;]*file:/,
  );
  const script = await fetch(base + "/embed.js");
  assert.match(script.headers.get("content-type"), /charset=utf-8/i);
  assert.equal(script.headers.get("cache-control"), "no-cache");
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==";
  const invalid = await call("/api/access/channels/" + web.id, "PUT", {
    ...changed.data,
    widget: {
      ...changed.data.widget,
      launcherIconUrl: "data:image/png;base64,PHNjcmlwdD4=",
    },
    expectedRevision: changed.data.revision,
  });
  assert.equal(invalid.status, 400);
  const uploaded = await call("/api/access/channels/" + web.id, "PUT", {
    ...changed.data,
    widget: { ...changed.data.widget, launcherIconUrl: png },
    expectedRevision: changed.data.revision,
  });
  assert.equal(uploaded.status, 200);
  assert.equal(
    (await call(configPath, "GET", undefined, { Origin: "null" })).data.widget
      .launcherIconUrl,
    png,
  );
  const restored = await call("/api/access/channels/" + web.id, "PUT", {
    ...uploaded.data,
    widget: { ...uploaded.data.widget, allowLocalFilePreview: false },
    expectedRevision: uploaded.data.revision,
  });
  assert.equal(restored.status, 200);
  assert.equal(
    (await call(configPath, "GET", undefined, { Origin: "null" })).status,
    403,
  );
});

test("visitor email is required and supplied profile stays isolated by visitor token", async () => {
  const channel = (await call("/api/access/channels")).data.find(
    (c) => c.type === "web",
  );
  const start = "/api/widget/start?appKey=" + channel.public_key;
  assert.equal(
    (await call(start, "POST", { name: "missing email" })).status,
    400,
  );
  assert.equal(
    (await call(start, "POST", { email: "not-an-email" })).status,
    400,
  );
  const first = await call(start, "POST", {
    name: "ignored",
    email: "USER@Example.com",
    profile: { company: "Acme", platform: "Flutter", custom: { plan: "Pro" } },
  });
  assert.equal(first.status, 201);
  let detail = (await call("/api/conversations/" + first.data.id)).data
    .conversation;
  assert.equal(detail.name, "user@example.com");
  assert.equal(detail.email, "user@example.com");
  assert.equal(detail.profile.company, "Acme");
  assert.equal(detail.profile.custom.plan, "Pro");
  const second = await call(start, "POST", { email: "user@example.com" });
  assert.equal(second.status, 201);
  const path = "/api/widget/profile?appKey=" + channel.public_key;
  assert.equal(
    (
      await call(
        path,
        "POST",
        { id: second.data.id, profile: { phone: "123" } },
        { Authorization: "Bearer " + first.data.token },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        path,
        "POST",
        { id: first.data.id, profile: { phone: "123", device: "Phone" } },
        { Authorization: "Bearer " + first.data.token },
      )
    ).status,
    200,
  );
  detail = (await call("/api/conversations/" + first.data.id)).data
    .conversation;
  assert.equal(detail.profile.phone, "123");
  assert.equal(detail.profile.company, "Acme");
  assert.equal(
    (await call("/api/conversations/" + second.data.id)).data.conversation
      .profile.phone,
    undefined,
  );
  assert.equal(
    (
      await call(
        path,
        "POST",
        { id: first.data.id, profile: { company: "x".repeat(201) } },
        { Authorization: "Bearer " + first.data.token },
      )
    ).status,
    400,
  );
});
