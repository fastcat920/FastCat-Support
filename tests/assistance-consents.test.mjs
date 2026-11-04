import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAssistance } from "../lib/assistance.mjs";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE conversations(id TEXT,status TEXT,assignee TEXT);INSERT INTO conversations VALUES('c','open','')",
  );
  let now = 10000000;
  const a = createAssistance({ db, clock: () => now });
  const deviceId = "device_12345678901234",
    consentSessionId = "consent_session_123456789012345678901234567890";
  const reg = {
    action: "register",
    deviceId,
    consentProtocol: 1,
    consentSessionId,
    capabilities: ["basic", "status"],
    repairCapabilities: ["reconnect"],
    repairProtocol: 3,
  };
  a.visitor("c", "POST", reg);
  return { db, a, deviceId, consentSessionId, reg, advance: (n) => (now += n) };
}
test("query and operation grants are independent and repeated consent does not extend 30 minutes", () => {
  const { db, a, deviceId, consentSessionId, advance } = setup();
  try {
    const grant = (scope) =>
      a.visitor("c", "POST", {
        action: "scope_grant",
        scope,
        deviceId,
        consentSessionId,
      }).consents[scope];
    const query = grant("query");
    advance(1000);
    assert.equal(grant("query").expires, query.expires);
    const d = a.request("c", "basic", "x");
    a.visitor("c", "POST", {
      action: "accept",
      deviceId,
      requestId: d.id,
      grantId: query.id,
    });
    a.visitor("c", "POST", {
      action: "result",
      deviceId,
      requestId: d.id,
      report: { summary: "ok" },
    });
    const repair = a.requestRepair("c", "reconnect", "x");
    const args = {
      deviceId,
      requestId: repair.id,
      executionKey: "execution_key_12345678901234567890123456789012345",
    };
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          ...args,
          action: "repair_accept",
          grantId: query.id,
        }),
      /授权/,
    );
    const operation = grant("operation");
    a.visitor("c", "POST", {
      ...args,
      action: "repair_accept",
      grantId: operation.id,
    });
    a.visitor("c", "POST", {
      action: "scope_revoke",
      scope: "operation",
      deviceId,
      consentSessionId,
    });
    // Revoking new work must not prevent reporting/rolling back the repair that already started.
    a.visitor("c", "POST", {
      ...args,
      action: "repair_result",
      result: {
        outcome: "rolled_back",
        summary: "restored",
        verified: false,
        snapshotAvailable: false,
        rollback: "succeeded",
      },
    });
    assert.equal(a.state("c").repairs[0].status, "rolled_back");
    assert.ok(a.state("c").consents.query);
    advance(30 * 60000);
    assert.equal(a.state("c").consents.query, null);
  } finally {
    db.close();
  }
});
test("capability expansion, new assistance session and revocation cannot reuse an old query grant", () => {
  const { db, a, deviceId, consentSessionId, reg } = setup();
  try {
    const query = a.visitor("c", "POST", {
      action: "scope_grant",
      scope: "query",
      deviceId,
      consentSessionId,
    }).consents.query;
    a.visitor("c", "POST", {
      ...reg,
      capabilities: ["basic", "status", "logs"],
    });
    const logs = a.request("c", "logs", "x");
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          action: "accept",
          deviceId,
          requestId: logs.id,
          grantId: query.id,
        }),
      /授权/,
    );
    const basic = a.request("c", "basic", "x");
    a.visitor("c", "POST", {
      action: "accept",
      deviceId,
      requestId: basic.id,
      grantId: query.id,
    });
    a.visitor("c", "POST", {
      action: "scope_revoke",
      scope: "query",
      deviceId,
      consentSessionId,
    });
    assert.throws(
      () =>
        a.visitor("c", "POST", {
          action: "result",
          deviceId,
          requestId: basic.id,
          report: { summary: "late" },
        }),
      /授权/,
    );
    a.visitor("c", "POST", {
      action: "scope_grant",
      scope: "query",
      deviceId,
      consentSessionId,
    });
    a.visitor("c", "POST", {
      ...reg,
      consentSessionId: consentSessionId + "new",
    });
    assert.equal(a.state("c").consents.query, null);
  } finally {
    db.close();
  }
});

test("not now declines pending requests without revoking an existing scope grant", () => {
  const { db, a, deviceId, consentSessionId } = setup();
  try {
    const grant = a.visitor("c", "POST", {
      action: "scope_grant",
      scope: "query",
      deviceId,
      consentSessionId,
    }).consents.query;
    a.request("c", "basic", "x");
    const state = a.visitor("c", "POST", {
      action: "scope_decline",
      scope: "query",
      deviceId,
      consentSessionId,
    });
    assert.equal(state.requests[0].status, "declined");
    assert.equal(state.consents.query.id, grant.id);
  } finally {
    db.close();
  }
});
