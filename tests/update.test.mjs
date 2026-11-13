import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { update } from "../scripts/update.mjs";
function fixture({ dirty = false, pullFails = false, changed = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "support-update-"));
  mkdirSync(join(root, "node_modules"));
  const calls = [];
  let health = 0;
  const run = (exe, args) => {
    calls.push([exe, args]);
    if (args[1] === "check") return '{"port":18763}';
    if (args[0] === "status") return dirty ? " M server.mjs" : "";
    if (args[0] === "branch") return "main";
    if (args[0] === "rev-parse") return "before";
    if (args[0] === "pull" && pullFails) throw Error("pull failed");
    if (args[0] === "diff") return changed ? "package-lock.json" : "";
    return "";
  };
  return {
    root,
    calls,
    options: {
      run,
      checkHealth: async (port) => {
        assert.equal(port, 18763);
        health++;
      },
    },
    health: () => health,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("updater uses repository cwd, pulls before restart and checks configured port", async () => {
  const x = fixture();
  try {
    await update(x.root, x.options);
    assert.equal(x.health(), 1);
    assert.ok(x.calls.find((c) => c[1][0] === "pull"));
    assert.equal(x.calls.at(-1)[1][1], "restart");
  } finally {
    x.close();
  }
});
test("local edits or failed pulls never restart the running project", async () => {
  for (const options of [{ dirty: true }, { pullFails: true }]) {
    const x = fixture(options);
    try {
      await assert.rejects(update(x.root, x.options));
      assert.ok(!x.calls.some((c) => c[1][1] === "restart"));
      assert.equal(x.health(), 0);
    } finally {
      x.close();
    }
  }
});
test("dependency changes install before restart", async () => {
  const x = fixture({ changed: true });
  const old = process.env.npm_execpath;
  process.env.npm_execpath = "/test/npm-cli.js";
  try {
    await update(x.root, x.options);
    const install = x.calls.findIndex((c) => c[1].includes("ci"));
    const restart = x.calls.findIndex((c) => c[1][1] === "restart");
    assert.ok(install >= 0 && install < restart);
  } finally {
    if (old === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = old;
    x.close();
  }
});

test("failed dependency install is retried even after the repository is up to date", async () => {
  const { writeFileSync } = await import("node:fs");
  const x = fixture();
  writeFileSync(join(x.root, "package.json"), "{}");
  writeFileSync(join(x.root, "package-lock.json"), "{}");
  const old = process.env.npm_execpath;
  process.env.npm_execpath = "/test/npm-cli.js";
  let installs = 0;
  const run = x.options.run;
  x.options.run = (exe, args, ...rest) => {
    if (args.includes("ci") && ++installs === 1) throw Error("install failed");
    return run(exe, args, ...rest);
  };
  try {
    await assert.rejects(update(x.root, x.options), /install failed/);
    assert.equal(x.health(), 0);
    await update(x.root, x.options);
    assert.equal(installs, 2);
    assert.equal(x.health(), 1);
    await update(x.root, x.options);
    assert.equal(installs, 2);
  } finally {
    if (old === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = old;
    x.close();
  }
});
