import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import {
  createLimiter,
  clientAddress,
  createPresence,
  createVisitorSessions,
} from "../lib/runtime-guards.mjs";
const secret = "a".repeat(32);
const token = (claims) => {
  const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url"),
    payload = Buffer.from(JSON.stringify(claims)).toString("base64url"),
    body = header + "." + payload;
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
};
test("identity validates signatures, expiry, app and installation; isolates user/device pairs", () => {
  const db = new DatabaseSync(":memory:");
  let now = 100000;
  const sessions = createVisitorSessions(db, { secret, clock: () => now }),
    channel = { id: "web", public_key: "public" };
  const claims = {
    sub: "one",
    appKey: "public",
    deviceId: "installation_0001",
    iat: 100,
    exp: 300,
  };
  const input = {
    email: "a@example.com",
    deviceId: claims.deviceId,
    identityToken: token(claims),
  };
  const first = sessions.binding(input, channel);
  assert.equal(first, sessions.binding(input, channel));
  assert.notEqual(
    first,
    sessions.binding(
      { ...input, identityToken: token({ ...claims, sub: "two" }) },
      channel,
    ),
  );
  assert.notEqual(
    first,
    sessions.binding(
      {
        ...input,
        deviceId: "installation_0002",
        identityToken: token({ ...claims, deviceId: "installation_0002" }),
      },
      channel,
    ),
  );
  assert.throws(() =>
    sessions.binding({ ...input, deviceId: "installation_0003" }, channel),
  );
  assert.throws(() =>
    sessions.binding(input, { ...channel, public_key: "other" }),
  );
  assert.throws(() =>
    sessions.binding(
      { ...input, identityToken: token({ ...claims, exp: 90 }) },
      channel,
    ),
  );
  assert.equal(sessions.binding({ email: "a@example.com" }, channel), null);
  db.close();
});
test("presence expires and logout invalidates a lease even before purge", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT,expires INTEGER);INSERT INTO sessions VALUES('s','u',999999);",
  );
  let now = 1000;
  const p = createPresence(db, { clock: () => now, ttl: 100 });
  p.touch("u", "s");
  assert.equal(p.online("u"), true);
  now = 1101;
  assert.equal(p.online("u"), false);
  p.touch("u", "s");
  assert.equal(p.online("u"), true);
  db.exec("DELETE FROM sessions");
  assert.equal(p.online("u"), false);
  p.purge();
  db.close();
});
test("rate limits reset with bounded key storage", () => {
  let now = 0;
  const limit = createLimiter({ clock: () => now, maxKeys: 2 });
  limit("a", 1, 100);
  assert.throws(
    () => limit("a", 1, 100),
    (e) => e.status === 429 && e.retryAfter === 1,
  );
  limit("b", 1, 100);
  assert.throws(() => limit("c", 1, 100));
  now = 101;
  limit("c", 1, 100);
});

test("proxy IP headers require an explicitly trusted loopback connection", () => {
  assert.equal(
    clientAddress(
      {
        socket: { remoteAddress: "203.0.113.9" },
        headers: { "x-forwarded-for": "1.1.1.1" },
      },
      "loopback",
    ),
    "203.0.113.9",
  );
  assert.equal(
    clientAddress(
      {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-forwarded-for": "spoofed, 203.0.113.9" },
      },
      "loopback",
    ),
    "203.0.113.9",
  );
  assert.equal(
    clientAddress(
      {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-forwarded-for": "203.0.113.9" },
      },
      "off",
    ),
    "127.0.0.1",
  );
});
