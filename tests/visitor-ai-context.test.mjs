import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { visitorAIContext } from "../lib/visitor-ai-context.mjs";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE visitors(id TEXT PRIMARY KEY,profile TEXT,name TEXT DEFAULT '',email TEXT DEFAULT '');CREATE TABLE conversations(id TEXT,visitor_id TEXT);",
  );
  const add = (id, profile) => {
    db.prepare("INSERT INTO visitors(id,profile) VALUES(?,?)").run(
      id,
      JSON.stringify(profile),
    );
    db.prepare("INSERT INTO conversations VALUES(?,?)").run(id, id);
  };
  add("mac", {
    custom: {
      os: "macos",
      client_version: "3.6.2+8",
      wallet_balance: "private",
      token: "secret",
    },
    phone: "private-phone",
    externalId: "user-secret",
  });
  add("android", {
    os: "Android",
    appVersion: "1.0",
    custom: { client_version: "old" },
  });
  return db;
}
test("AI receives current conversation business and device metadata but excludes credentials", () => {
  const db = setup();
  try {
    db.prepare("UPDATE visitors SET name=?,email=? WHERE id=?").run(
      "测试用户",
      "user@example.test",
      "mac",
    );
    const mac = visitorAIContext(db, "automatic:mac");
    assert.match(mac, /user@example.test/);
    assert.match(mac, /测试用户/);
    assert.match(mac, /"os":"macos"/);
    assert.match(mac, /"appVersion":"3.6.2\+8"/);
    assert.match(mac, /不要重复询问/);
    assert.match(mac, /用户同意/);
    assert.match(mac, /"wallet_balance":"private"/);
    assert.match(mac, /"externalId":"user-secret"/);
    assert.doesNotMatch(mac, /"token"|"secret"|Android/);
    const android = visitorAIContext(db, "conversation:android");
    assert.match(android, /"os":"Android"/);
    assert.match(android, /"appVersion":"1.0"/);
    assert.doesNotMatch(android, /macos|3.6.2|old/);
    db.prepare("UPDATE visitors SET profile=? WHERE id=?").run(
      JSON.stringify({ custom: { os: "macos", client_version: "3.7" } }),
      "mac",
    );
    assert.match(visitorAIContext(db, "automatic:mac"), /"appVersion":"3.7"/);
    assert.equal(visitorAIContext(db, "debug"), null);
    assert.equal(visitorAIContext(db, "conversation:missing"), null);
  } finally {
    db.close();
  }
});
test("malformed and absent profile data never breaks AI or becomes invented device information", () => {
  const db = setup();
  try {
    for (const profile of ["{", "null", "[]", "{}"]) {
      db.prepare("UPDATE visitors SET profile=? WHERE id=?").run(
        profile,
        "mac",
      );
      assert.equal(visitorAIContext(db, "conversation:mac"), null);
    }
  } finally {
    db.close();
  }
});

test("business-only profile fields enter the prompt while subscription secrets stay excluded", () => {
  const db = setup();
  try {
    db.prepare("UPDATE visitors SET profile=? WHERE id=?").run(
      JSON.stringify({
        custom: {
          plan_name: "高级套餐",
          plan_expired_at: "2026-12-01",
          traffic_used: "2 GB",
          traffic_total: "100 GB",
          access_token: "credential-value",
          subscription_url: "https://secret.example/subscribe?token=private",
        },
      }),
      "mac",
    );
    const context = visitorAIContext(db, "automatic:mac");
    assert.match(context, /高级套餐/);
    assert.match(context, /100 GB/);
    assert.match(context, /2026-12-01/);
    assert.doesNotMatch(
      context,
      /credential-value|secret.example|subscription_url/,
    );
    assert.doesNotMatch(visitorAIContext(db, "automatic:android"), /高级套餐/);
  } finally {
    db.close();
  }
});
