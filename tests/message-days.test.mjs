import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { withMessageDays } from "../public/message-days.js";
test("local calendar grouping matches display across zones and midnight", () => {
  for (const [zone, dates] of [
    ["Asia/Shanghai", ["November 7, 2026", "November 8, 2026"]],
    ["America/Los_Angeles", ["November 7, 2026"]],
  ]) {
    const code = `import {withMessageDays} from './public/message-days.js'; console.log(withMessageDays([{created:'2026-11-07T15:59:00Z'},{created:'2026-11-07T16:46:00Z'}],()=>'<p>message</p>','en-US'));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, TZ: zone },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      (r.stdout.match(/role="separator"/g) || []).length,
      dates.length,
    );
    for (const d of dates) assert.ok(r.stdout.includes(d));
  }
});
test("invalid dates do not reset groups or change message order", () => {
  const html = withMessageDays(
    [
      { id: 1, created: "2026-11-08T12:00:00Z" },
      { id: 2, created: "bad" },
      { id: 3, created: "2026-11-08T12:01:00Z" },
    ],
    (m) => `<p>${m.id}</p>`,
    "en-US",
  );
  assert.equal((html.match(/role="separator"/g) || []).length, 1);
  assert.match(html, /<p>1<\/p><p>2<\/p><p>3<\/p>/);
});
