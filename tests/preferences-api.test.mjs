import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "fc-prefs-api-")),
  base = "http://127.0.0.1:14420/api";
let child, cookie, staffCookie, adminId;
async function call(path, method = "GET", data, auth = cookie, extra = {}) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Cookie: auth || "",
      "Content-Type": "application/json",
      ...extra,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: r.status, data: await r.json(), headers: r.headers };
}
before(async () => {
  child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: "14420", DB_PATH: join(dir, "test.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error("server failed");
    }),
  ]);
  const setup = await call(
    "/setup",
    "POST",
    {
      name: "管理员",
      email: "prefs@local.test",
      password: "preferences-test-password",
    },
    "",
  );
  cookie = setup.headers.get("set-cookie").split(";")[0];
  adminId = (await call("/me")).data.id;
  const invite = (
    await call("/invitations", "POST", {
      email: "staff-prefs@local.test",
      role: "agent",
    })
  ).data;
  const token = invite.path.split("invite=")[1];
  await call(
    "/invites/" + token + "/accept",
    "POST",
    { name: "客服", password: "preferences-test-password" },
    "",
  );
  staffCookie = (
    await call(
      "/login",
      "POST",
      {
        email: "staff-prefs@local.test",
        password: "preferences-test-password",
      },
      "",
    )
  ).headers
    .get("set-cookie")
    .split(";")[0];
});
after(async () => {
  child.kill();
  await once(child, "exit");
  rmSync(dir, { recursive: true, force: true });
});
test("preferences are per-account, revision guarded, and profile edits cannot change role or another account", async () => {
  const p = (await call("/preferences")).data;
  assert.equal(p.theme, "system");
  const save = await call("/preferences", "PUT", {
    ...p,
    theme: "dark",
    notificationEnabled: false,
    expectedRevision: p.revision,
  });
  assert.equal(save.status, 200);
  assert.equal(
    (await call("/preferences", "GET", undefined, staffCookie)).data.theme,
    "system",
  );
  assert.equal(
    (
      await call("/preferences", "PUT", {
        theme: "light",
        expectedRevision: p.revision,
      })
    ).status,
    409,
  );
  const profile = await call(
    "/profile",
    "PUT",
    { name: "新客服姓名", role: "admin", id: adminId },
    staffCookie,
  );
  assert.equal(profile.status, 200);
  assert.equal(profile.data.role, "agent");
  assert.equal((await call("/me")).data.name, "管理员");
  assert.equal((await call("/preferences", "GET", undefined, "")).status, 401);
});
test("avatar upload persists for its owner and rejects executable or oversized content", async () => {
  const avatar =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==";
  const saved = await call(
    "/profile",
    "PUT",
    { name: "头像客服", avatar },
    staffCookie,
  );
  assert.equal(saved.status, 200);
  assert.equal(
    (await call("/me", "GET", undefined, staffCookie)).data.avatar,
    avatar,
  );
  assert.equal((await call("/me")).data.avatar, "");
  const image = await fetch(base + "/profile/avatar", {
    headers: { Cookie: staffCookie },
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(
    Buffer.from(await image.arrayBuffer()).toString("base64"),
    avatar.split(",")[1],
  );
  assert.equal(
    (await call("/profile/avatar", "GET", undefined, "")).status,
    401,
  );
  assert.equal((await call("/profile/avatar")).status, 404);
  for (const bad of [
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,PHNjcmlwdD4=",
    "x".repeat(180001),
  ]) {
    assert.equal(
      (
        await call(
          "/profile",
          "PUT",
          { name: "头像客服", avatar: bad },
          staffCookie,
        )
      ).status,
      400,
    );
  }
  await call("/profile", "PUT", { name: "保留头像" }, staffCookie);
  assert.equal(
    (await call("/me", "GET", undefined, staffCookie)).data.avatar,
    avatar,
  );
});
test("notification feed excludes staff/system messages and conversations outside current access scope", async () => {
  const baseline = (await call("/notifications")).data.cursor;
  const v = (
    await call("/widget/start", "POST", { email: "notification@example.test" })
  ).data;
  const send = (body, key) =>
    call("/widget/messages", "POST", { id: v.id, body, clientId: key }, "", {
      Authorization: "Bearer " + v.token,
    });
  assert.equal(
    (await send("第一条咨询", "notification_first_001")).status,
    201,
  );
  await send("第二条咨询", "notification_second_002");
  const detail = (await call("/conversations/" + v.id)).data;
  await call("/conversations/" + v.id, "PATCH", {
    changes: { assignee: adminId },
    expectedRevision: detail.conversation.revision,
  });
  await call("/conversations/" + v.id + "/messages", "POST", {
    body: "客服答复",
    clientId: "notification_staff_001",
  });
  const response = await call("/notifications?after=" + baseline);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const events = response.data;
  assert.equal(events.items.length, 2);
  assert.equal(events.items[0].newVisitor, 1);
  assert.equal(events.items[1].newVisitor, 0);
  assert.ok(events.items.every((e) => e.conversationId === v.id));
  assert.equal(
    (
      await call(
        "/notifications?after=" + baseline,
        "GET",
        undefined,
        staffCookie,
      )
    ).data.items.length,
    0,
  );
  assert.equal((await call("/notifications?after=-1")).status, 400);
});
test("extension management rejects agents and device protocol does not accept staff sessions as device credentials", async () => {
  for (const path of ["/skills", "/devices"])
    assert.equal((await call(path, "GET", undefined, staffCookie)).status, 403);
  assert.equal((await call("/device-agent/poll", "POST", {})).status, 401);
  const s = await call("/skills", "POST", {
    name: "api-skill",
    description: "操作指引",
    instructions: "先确认订单",
    enabled: true,
    files: { "references/info.md": "说明" },
  });
  assert.equal(s.status, 201);
  assert.equal(
    (
      await call("/skills/" + s.data.id, "PUT", {
        ...s.data,
        enabled: false,
        expectedRevision: 99,
      })
    ).status,
    409,
  );
  assert.equal(
    (await call("/devices/bind-code", "POST", {}, staffCookie)).status,
    403,
  );
});

test("language and accent preferences persist with validation and isolation", async () => {
  const p = (await call("/preferences")).data;
  const saved = await call("/preferences", "PUT", {
    ...p,
    language: "en",
    themeColor: "#114466",
    expectedRevision: p.revision,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.language, "en");
  assert.equal(saved.data.themeColor, "#114466");
  assert.equal(
    (await call("/preferences", "GET", undefined, staffCookie)).data.language,
    "zh-CN",
  );
  for (const changes of [
    { language: "invalid" },
    { themeColor: "red" },
    { themeColor: "url(x)" },
  ])
    assert.equal(
      (
        await call("/preferences", "PUT", {
          ...saved.data,
          ...changes,
          expectedRevision: saved.data.revision,
        })
      ).status,
      400,
    );
});
