import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  migrateWorkingHours,
  workingHours,
  defaultHours,
  validateHours,
} from "../lib/working-hours.mjs";
test("legacy hours migrate once without restoring removed reception settings", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE service_settings(id INTEGER PRIMARY KEY,value TEXT,revision INTEGER)",
    );
    const hours = {
      ...defaultHours,
      enabled: true,
      start: "10:00",
      end: "20:00",
    };
    db.prepare("INSERT INTO service_settings VALUES(1,?,5)").run(
      JSON.stringify({ hours, enabled: true, rules: [{ name: "old" }] }),
    );
    migrateWorkingHours(db);
    assert.deepEqual(workingHours(db), { ...hours, revision: 0 });
    db.prepare("UPDATE team_working_hours SET value=?,revision=1").run(
      JSON.stringify({ ...hours, start: "11:00" }),
    );
    migrateWorkingHours(db);
    assert.equal(workingHours(db).start, "11:00");
    assert.equal(workingHours(db).revision, 1);
    assert.equal(workingHours(db).rules, undefined);
    assert.equal(
      JSON.parse(db.prepare("SELECT value FROM service_settings").get().value)
        .enabled,
      true,
    );
  } finally {
    db.close();
  }
});
test("hours reject invalid dates and only preserve supported fields", () => {
  for (const bad of [
    { timeZone: "not-a-zone" },
    { start: "24:01" },
    { end: "09:00" },
    { weekdays: [9] },
  ])
    assert.throws(() => validateHours({ ...defaultHours, ...bad }));
  const saved = validateHours({
    ...defaultHours,
    enabled: true,
    weekdays: [1, 1, 2],
    rules: [],
    ai: { enabled: true },
  });
  assert.deepEqual(saved.weekdays, [1, 2]);
  assert.equal(saved.ai, undefined);
  assert.equal(saved.rules, undefined);
});
