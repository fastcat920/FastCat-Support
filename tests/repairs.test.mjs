import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAssistance } from "../lib/assistance.mjs";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE conversations(id TEXT,status TEXT,assignee TEXT);INSERT INTO conversations VALUES('c','open',''),('other','open','')",
  );
  let now = 10000000;
  const a = createAssistance({ db, clock: () => now });
  const deviceId = "device_12345678901234";
  a.visitor("c", "POST", {
    action: "register",
    deviceId,
    capabilities: [],
    repairCapabilities: [
      "reconnect",
      "restart_core",
      "reapply_proxy",
      "restore_settings",
    ],
    repairProtocol: 2,
  });
  return { db, a, deviceId, advance: (n) => (now += n) };
}
const key = "execution_key_12345678901234567890123456789012345";
const result = {
  outcome: "succeeded",
  summary: "Reconnected and verified",
  verified: true,
  snapshotAvailable: true,
  rollback: "not_needed",
};
test("repair has distinct consent, device binding and execution proof, immutable results and explicit restore target", () => {
  const { db, a, deviceId } = setup();
  try {
    const r = a.requestRepair("c", "reconnect", "reconnect", "staff");
    const args = { requestId: r.id, deviceId, executionKey: key };
    assert.throws(
      () =>
        a.visitor("c", "POST", { ...args, action: "repair_result", result }),
      /凭据/,
    );
    assert.throws(
      () => a.visitor("other", "POST", { ...args, action: "repair_accept" }),
      /不匹配/,
    );
    a.visitor("c", "POST", { ...args, action: "repair_accept" });
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          ...args,
          executionKey: key + "x",
          action: "repair_accept",
        }),
      /已处理/,
    );
    assert.throws(
      () => a.requestRepair("c", "restart_core", "again"),
      /已有修复/,
    );
    a.visitor("c", "POST", { ...args, action: "repair_result", result });
    a.visitor("c", "POST", {
      ...args,
      action: "repair_result",
      result: { ...result, summary: "override" },
    });
    assert.equal(a.state("c").repairs[0].result.summary, result.summary);
    assert.throws(
      () =>
        a.requestRepair(
          "c",
          "restore_settings",
          "restore",
          null,
          "other-request",
        ),
      /没有可恢复/,
    );
    assert.equal(
      a.requestRepair("c", "restore_settings", "restore", null, r.id).status,
      "pending",
    );
    const state = a.state("c");
    assert.ok(state.repairs.every((r) => !("execution_hash" in r)));
  } finally {
    db.close();
  }
});
test("disconnect expiry and server restart keep uncertain repair locked but allow late verified results even after close", () => {
  const { db, a, deviceId, advance } = setup();
  try {
    const r = a.requestRepair("c", "reapply_proxy", "proxy");
    const args = { requestId: r.id, deviceId, executionKey: key };
    a.visitor("c", "POST", { ...args, action: "repair_accept" });
    createAssistance({ db, clock: () => 10000001 });
    assert.equal(a.state("c").repairs[0].status, "unknown");
    advance(181000);
    assert.equal(a.state("c").repairs[0].status, "unknown");
    assert.throws(
      () => a.requestRepair("c", "reconnect", "retry"),
      /离线|已有修复/,
    );
    db.exec("UPDATE conversations SET status='closed' WHERE id='c'");
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          ...args,
          action: "repair_result",
          result: { ...result, verified: false },
        }),
      /未复查/,
    );
    a.visitor("c", "POST", {
      ...args,
      action: "repair_result",
      result: {
        ...result,
        outcome: "rolled_back",
        verified: false,
        rollback: "succeeded",
      },
    });
    assert.equal(a.state("c").repairs[0].status, "rolled_back");
  } finally {
    db.close();
  }
});
test("diagnostic consent cannot execute repairs and pending repairs expire without effects", () => {
  const { db, a, deviceId, advance } = setup();
  try {
    const r = a.requestRepair("c", "reconnect", "test");
    assert.throws(
      () =>
        a.visitor("c", "POST", { action: "accept", deviceId, requestId: r.id }),
      /不匹配/,
    );
    advance(301000);
    assert.equal(a.state("c").repairs[0].status, "expired");
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          action: "repair_accept",
          deviceId,
          requestId: r.id,
          executionKey: key,
        }),
      /已处理/,
    );
  } finally {
    db.close();
  }
});

test("route switch requires protocol 3, an offered target and restoration of the original route", () => {
  const { db, a, deviceId } = setup();
  try {
    const registration = {
      action: "register",
      deviceId,
      capabilities: ["routes"],
      repairCapabilities: ["switch_route"],
      routeOptions: [{ id: "alt_1", label: "备用线路一" }],
    };
    assert.throws(
      () => a.visitor("c", "POST", { ...registration, repairProtocol: 2 }),
      /协议3/,
    );
    a.visitor("c", "POST", { ...registration, repairProtocol: 3 });
    assert.throws(
      () =>
        a.requestRepair("c", "switch_route", "test", null, null, "unoffered"),
      /请选择/,
    );
    const r = a.requestRepair("c", "switch_route", "test", null, null, "alt_1");
    assert.equal(a.state("c").repairs[0].target_route_label, "备用线路一");
    const args = { requestId: r.id, deviceId, executionKey: key };
    a.visitor("c", "POST", { ...args, action: "repair_accept" });
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          ...args,
          action: "repair_result",
          result: { ...result, originalRouteRestored: false },
        }),
      /未恢复/,
    );
    a.visitor("c", "POST", {
      ...args,
      action: "repair_result",
      result: { ...result, originalRouteRestored: true },
    });
    assert.equal(a.state("c").repairs[0].result.originalRouteRestored, true);
  } finally {
    db.close();
  }
});
test("route comparison is bounded to at most three tested routes", () => {
  const { db, a, deviceId } = setup();
  try {
    a.visitor("c", "POST", {
      action: "register",
      deviceId,
      capabilities: ["routes"],
    });
    const r = a.request("c", "routes", "compare");
    const args = { requestId: r.id, deviceId };
    a.visitor("c", "POST", { ...args, action: "accept" });
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          ...args,
          action: "result",
          report: { checks: [{}, {}, {}, {}] },
        }),
      /1至3/,
    );
    a.visitor("c", "POST", {
      ...args,
      action: "result",
      report: {
        checks: [
          { routeId: "current", outcome: "failed" },
          { routeId: "alt_1", outcome: "passed" },
        ],
      },
    });
    assert.equal(a.state("c").requests[0].report.checks.length, 2);
  } finally {
    db.close();
  }
});
