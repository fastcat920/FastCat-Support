import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAssistance } from "../lib/assistance.mjs";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE conversations(id TEXT,status TEXT,assignee TEXT);INSERT INTO conversations VALUES('c','open',''),('other','open','');",
  );
  let now = 10000000;
  const a = createAssistance({ db, clock: () => now });
  a.visitor("c", "POST", {
    action: "register",
    deviceId: "device_12345678901234",
    capabilities: ["basic", "network"],
  });
  return { db, a, advance: (n) => (now += n) };
}
test("diagnostics require explicit single-use consent, device binding and an unexpired request", () => {
  const { db, a, advance } = setup();
  try {
    const r = a.request("c", "basic", "排查");
    const args = { deviceId: "device_12345678901234", requestId: r.id };
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          ...args,
          action: "result",
          report: { summary: "no consent" },
        }),
      /授权/,
    );
    assert.throws(
      () => a.visitor("other", "POST", { ...args, action: "accept" }),
      /不匹配/,
    );
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          ...args,
          deviceId: "wrong",
          action: "accept",
        }),
      /不匹配/,
    );
    a.visitor("c", "POST", { ...args, action: "accept" });
    assert.throws(
      () => a.visitor("c", "POST", { ...args, action: "accept" }),
      /已处理/,
    );
    a.visitor("c", "POST", {
      ...args,
      action: "result",
      report: {
        summary: "token=abc https://example.com/private",
        checks: [{ password: "secret", ok: true }],
      },
    });
    const report = a.state("c").requests[0].report;
    assert.ok(!JSON.stringify(report).includes("abc"));
    assert.ok(!JSON.stringify(report).includes("secret"));
    assert.ok(!JSON.stringify(report).includes("example.com"));
    a.visitor("c", "POST", {
      ...args,
      action: "result",
      report: { summary: "overwritten" },
    });
    assert.deepEqual(a.state("c").requests[0].report, report);
    advance(8 * 86400000);
    a.purge();
    assert.equal(a.state("c").requests[0].report, null);
  } finally {
    db.close();
  }
});
test("revoke, expiry, unsupported capabilities and closed conversations prevent collection", () => {
  const { db, a, advance } = setup();
  try {
    assert.throws(() => a.request("c", "screenshot", "x"), /未接入/);
    let r = a.request("c", "network", "排查");
    const args = { deviceId: "device_12345678901234", requestId: r.id };
    a.visitor("c", "POST", { ...args, action: "accept" });
    a.visitor("c", "POST", { ...args, action: "revoke" });
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          ...args,
          action: "result",
          report: { summary: "late" },
        }),
      /失效/,
    );
    r = a.request("c", "basic", "x");
    advance(301000);
    assert.throws(
      () =>
        a.visitor("c", "POST", { ...args, requestId: r.id, action: "accept" }),
      /过期/,
    );
    db.exec("UPDATE conversations SET status='closed'");
    assert.throws(() => a.request("c", "basic", "x"), /结束/);
  } finally {
    db.close();
  }
});

test("staff access is scoped to the conversation owner and reports reject arbitrary settings", async () => {
  const { db, a } = setup();
  try {
    db.exec("UPDATE conversations SET assignee='owner' WHERE id='c'");
    await assert.rejects(
      a.handle({
        req: { method: "GET" },
        url: new URL("http://localhost/api/conversations/c/assistance"),
        u: { id: "other", role: "agent" },
        body: async () => ({}),
        send: () => {},
      }),
      /无权/,
    );
    let value;
    await a.handle({
      req: { method: "GET" },
      url: new URL("http://localhost/api/conversations/c/assistance"),
      u: { id: "owner", role: "agent" },
      body: async () => ({}),
      send: (_, status, data) => (value = data),
    });
    assert.equal(value.device.online, true);
    const r = a.request("c", "basic", "x", "owner");
    const args = { requestId: r.id, deviceId: "device_12345678901234" };
    a.visitor("c", "POST", { ...args, action: "accept" });
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          ...args,
          action: "result",
          report: { fullConfiguration: "credentials" },
        }),
      /未允许/,
    );
    a.visitor("c", "POST", {
      action: "register",
      deviceId: "another_device_123456",
      capabilities: ["basic"],
    });
    assert.equal(a.state("c").requests[0].status, "revoked");
  } finally {
    db.close();
  }
});
