import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("real HTTP diagnostic lifecycle preserves visitor auth, staff access and consent boundaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-assist-"));
  const base = "http://127.0.0.1:14487/api";
  const child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: "14487", DB_PATH: join(dir, "test.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let cookie = "";
  async function call(path, method = "GET", data, token) {
    const r = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : { Cookie: cookie }),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: r.status, data: await r.json(), headers: r.headers };
  }
  try {
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw Error("server failed");
      }),
    ]);
    const setup = await call("/setup", "POST", {
      name: "Admin",
      email: "assist@local.test",
      password: "assistance-test-password",
    });
    cookie = setup.headers.get("set-cookie").split(";")[0];
    const v = (
      await call("/widget/start", "POST", { email: "diagnostic@local.test" })
    ).data;
    const deviceId = "test_device_123456789";
    assert.equal(
      (
        await call(
          "/widget/assistance",
          "POST",
          { id: v.id, action: "register", deviceId, capabilities: ["basic"] },
          "wrong",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/widget/assistance",
          "POST",
          { id: v.id, action: "register", deviceId, capabilities: ["basic"] },
          v.token,
        )
      ).status,
      200,
    );
    const r = await call(`/conversations/${v.id}/assistance`, "POST", {
      capability: "basic",
      reason: "read version",
    });
    assert.equal(r.status, 201);
    const body = { id: v.id, requestId: r.data.id, deviceId };
    assert.equal(
      (
        await call(
          "/widget/assistance",
          "POST",
          { ...body, action: "result", report: { appVersion: "1" } },
          v.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          "/widget/assistance",
          "POST",
          { ...body, action: "accept" },
          v.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/widget/assistance",
          "POST",
          { ...body, action: "result", report: { appVersion: "1" } },
          v.token,
        )
      ).status,
      200,
    );
    const state = (await call(`/conversations/${v.id}/assistance`)).data;
    assert.equal(state.requests[0].report.appVersion, "1");
    assert.equal(state.requests[0].status, "succeeded");
    await call(
      "/widget/assistance",
      "POST",
      {
        id: v.id,
        action: "register",
        deviceId,
        capabilities: ["basic"],
        repairCapabilities: ["reconnect"],
        repairProtocol: 2,
      },
      v.token,
    );
    const repair = await call(`/conversations/${v.id}/assistance`, "POST", {
      kind: "repair",
      operation: "reconnect",
      reason: "reconnect for verification",
    });
    assert.equal(repair.status, 201);
    const repairArgs = {
      id: v.id,
      deviceId,
      requestId: repair.data.id,
      executionKey: "test_execution_key_123456789012345678901234567890",
    };
    const result = {
      outcome: "succeeded",
      summary: "verified",
      verified: true,
      snapshotAvailable: false,
      rollback: "not_needed",
    };
    assert.equal(
      (
        await call(
          "/widget/assistance",
          "POST",
          { ...repairArgs, action: "repair_result", result },
          v.token,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/widget/assistance",
          "POST",
          { ...repairArgs, action: "repair_accept" },
          v.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/widget/assistance",
          "POST",
          { ...repairArgs, action: "repair_result", result },
          v.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call(`/conversations/${v.id}/assistance`)).data.repairs[0].status,
      "succeeded",
    );
  } finally {
    child.kill();
    await once(child, "exit");
    rmSync(dir, { recursive: true, force: true });
  }
});
