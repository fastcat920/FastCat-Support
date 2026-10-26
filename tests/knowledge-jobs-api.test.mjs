import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
const base = "http://127.0.0.1:14360",
  dir = mkdtempSync(join(tmpdir(), "fc-crawl-api-"));
let remote, child, cookie;
async function call(path, method = "GET", body, auth = cookie) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Cookie: auth } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
before(async () => {
  remote = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      req.url === "/help"
        ? '<title>售后帮助</title><p>售后说明</p><a href="/help/returns">退货</a><a href="/outside">不采集</a>'
        : "<title>退货政策</title><p>七天内申请退货</p>",
    );
  });
  await new Promise((r) => remote.listen(14361, "127.0.0.1", r));
  child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: "14360",
      DB_PATH: join(dir, "test.db"),
      INTEGRATION_ALLOWED_ORIGINS: "http://127.0.0.1:14361",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error("server failed");
    }),
  ]);
  const setup = await call("/setup", "POST", {
    name: "管理员",
    email: "crawl@local.test",
    password: "test-password-2026",
  });
  assert.equal(setup.status, 200);
  cookie = setup.cookie;
});
after(async () => {
  child.kill();
  await once(child, "exit");
  await new Promise((r) => remote.close(r));
  rmSync(dir, { recursive: true, force: true });
});
test("website source API imports linked pages, protects managed documents and detaches while retaining content", async () => {
  const collection = await call("/knowledge/collections", "POST", {
    name: "采集知识库",
  });
  const r = await call("/knowledge/sources", "POST", {
    name: "售后帮助",
    url: "http://127.0.0.1:14361/help",
    collectionId: collection.data.id,
    maxPages: 5,
    depth: 1,
    enabled: false,
  });
  assert.equal(r.status, 201);
  const source = r.data;
  assert.equal(
    (await call("/knowledge/collections/" + collection.data.id, "DELETE"))
      .status,
    409,
  );
  assert.equal(
    (
      await call("/knowledge/sources/" + source.id, "PUT", {
        ...source,
        expectedRevision: 99,
      })
    ).status,
    409,
  );
  assert.equal(
    (await call("/knowledge/sources/" + source.id + "/run", "POST")).status,
    202,
  );
  let job;
  for (let i = 0; i < 100; i++) {
    job = (await call("/knowledge/jobs")).data.find(
      (j) => j.source_id === source.id,
    );
    if (job && ["succeeded", "failed", "partial"].includes(job.status)) break;
    await delay(10);
  }
  assert.equal(job.status, "succeeded");
  assert.equal(job.progress.imported, 2);
  const pages = (await call("/knowledge/sources/" + source.id + "/pages")).data;
  assert.equal(pages.length, 2);
  const resources = (await call("/resources?kind=knowledge")).data;
  const document = resources.find((d) => d.id === pages[0].resource_id);
  assert.equal(
    (
      await call("/resources/" + document.id, "PATCH", {
        ...document,
        name: "覆盖",
      })
    ).status,
    409,
  );
  assert.equal((await call("/resources/" + document.id, "DELETE")).status, 409);
  assert.equal(
    (await call("/knowledge/sources/" + source.id, "DELETE")).data
      .documentsRetained,
    true,
  );
  assert.equal((await call("/resources?kind=knowledge")).data.length, 2);
  assert.equal(
    (
      await call("/resources/" + document.id, "PATCH", {
        ...document,
        config: { ...document.config, sourceId: undefined },
        name: "可独立编辑",
      })
    ).status,
    200,
  );
});
test("crawl origins, page limits and administrator access are enforced", async () => {
  assert.equal(
    (
      await call("/knowledge/sources", "POST", {
        name: "外站",
        url: "https://unapproved.example/help",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/knowledge/sources", "POST", {
        name: "过量",
        url: "http://127.0.0.1:14361/help",
        maxPages: 99,
      })
    ).status,
    400,
  );
  const inv = await call("/invitations", "POST", {
    email: "reader@local.test",
    role: "agent",
  });
  const token = inv.data.path.split("invite=")[1];
  await call("/invites/" + token + "/accept", "POST", {
    name: "客服",
    password: "test-password-2026",
  });
  const login = await call("/login", "POST", {
    email: "reader@local.test",
    password: "test-password-2026",
  });
  for (const path of ["/knowledge/sources", "/knowledge/jobs"])
    assert.equal((await call(path, "GET", null, login.cookie)).status, 403);
});
