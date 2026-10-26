import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSkills, parseSkill } from "../lib/skills.mjs";
import { createDevices } from "../lib/devices.mjs";
import { createAgentExtensions } from "../lib/agent-extensions.mjs";
import { createAgentRunner, migrateAgentTeams } from "../lib/agent-teams.mjs";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE resources(id TEXT PRIMARY KEY,kind TEXT,name TEXT,description TEXT,config TEXT);CREATE TABLE users(id TEXT PRIMARY KEY,active INTEGER);",
  );
  migrateAgentTeams(db);
  const skills = createSkills({ db }),
    devices = createDevices({ db });
  return { db, skills, devices };
}
async function handle(service, path, data, token, publicRoute = false) {
  let result;
  await service[publicRoute ? "publicHandle" : "handle"]({
    req: {
      method: "POST",
      headers: { authorization: token ? "Bearer " + token : undefined },
    },
    res: {},
    url: new URL("http://localhost" + path),
    body: async () => data,
    currentUser: () => ({ role: "admin" }),
    send: (r, status, value) => (result = { status, data: value }),
  });
  return result;
}
async function pair(devices, caps = ["screenshot"]) {
  const code = await handle(devices, "/api/devices/bind-code", {});
  return (
    await handle(
      devices,
      "/api/device-agent/register",
      {
        code: code.data.code,
        name: "测试设备",
        os: "mock",
        capabilities: caps,
      },
      null,
      true,
    )
  ).data;
}
test("skills validate bundles and expose only enabled instructions and references", () => {
  const x = setup();
  try {
    const parsed = parseSkill(
      "---\nname: returns\ndescription: 售后\n---\n先核对订单",
    );
    const s = x.skills.save({
      ...parsed,
      files: { "references/policy.md": "七天" },
      enabled: true,
    });
    assert.equal(x.skills.read("returns").instructions, "先核对订单");
    assert.equal(
      x.skills.read("returns", "references/policy.md").content,
      "七天",
    );
    assert.throws(() => x.skills.read("returns", "../secret"), /不存在/);
    assert.throws(
      () =>
        x.skills.save({
          ...parsed,
          name: "bad",
          files: { "references/../secret": "x" },
        }),
      /文件无效/,
    );
    x.skills.save({ ...s, enabled: false, expectedRevision: s.revision }, s.id);
    assert.equal(x.skills.catalog().length, 0);
    assert.throws(() => x.skills.read("returns"), /已停用/);
  } finally {
    x.db.close();
  }
});
test("agent discovers skills, reads chosen instructions and continues its answer", async () => {
  const x = setup();
  try {
    x.skills.save({
      name: "returns",
      description: "退货",
      instructions: "七天可退",
      enabled: true,
    });
    x.db
      .prepare("INSERT INTO resources VALUES('a','agent','客服','服务指令',?)")
      .run(JSON.stringify({ skillsEnabled: true, maxToolRounds: 4 }));
    let round = 0;
    const providers = {
      async *complete(o) {
        if (round++ === 0) {
          assert.ok(o.tools.some((t) => t.name === "skills_list"));
          o.onToolCalls([{ id: "s1", name: "skills_list", arguments: {} }]);
        } else if (round === 2) {
          assert.match(o.messages.at(-1).content, /returns/);
          o.onToolCalls([
            { id: "s2", name: "skills_read", arguments: { name: "returns" } },
          ]);
        } else {
          assert.match(o.messages.at(-1).content, /七天可退/);
          yield "七天可退";
        }
      },
    };
    const runner = createAgentRunner({
      db: x.db,
      providers,
      extensions: createAgentExtensions(x),
      knowledge: () => [],
    });
    let answer = "";
    for await (const text of runner.stream({
      agentId: "a",
      messages: [{ role: "user", content: "退货" }],
    }))
      answer += text;
    assert.equal(answer, "七天可退");
    assert.equal(
      x.db.prepare("SELECT count(*) n FROM agent_tool_calls").get().n,
      2,
    );
  } finally {
    x.db.close();
  }
});
test("device pairing is one-time, scopes results to its device, clears transient data and never retries uncertain actions", async () => {
  const x = setup();
  try {
    const device = await pair(x.devices, ["screenshot", "click"]),
      other = await pair(x.devices);
    const pending = x.devices.call(device.id, "click", { x: 10, y: 20 });
    const poll = await handle(
      x.devices,
      "/api/device-agent/poll",
      {},
      device.token,
      true,
    );
    assert.equal(poll.data.task.command, "click");
    assert.deepEqual(poll.data.task.args, { x: 10, y: 20 });
    await assert.rejects(
      handle(
        x.devices,
        "/api/device-agent/result",
        { id: poll.data.task.id, ok: true, result: {} },
        other.token,
        true,
      ),
      /不属于/,
    );
    await handle(
      x.devices,
      "/api/device-agent/result",
      { id: poll.data.task.id, ok: true, result: { ok: true } },
      device.token,
      true,
    );
    assert.deepEqual(await pending, { ok: true });
    const task = x.db.prepare("SELECT * FROM device_tasks").get();
    assert.equal(task.args, "{}");
    assert.equal(task.result, "{}");
    await assert.rejects(
      x.devices.call(other.id, "click", { x: 1, y: 2 }),
      /未授权/,
    );
    await assert.rejects(x.devices.call(device.id, "click", { x: -1, y: 2 }));
    const unknown = x.devices.call(device.id, "click", { x: 1, y: 2 });
    await handle(x.devices, "/api/device-agent/poll", {}, device.token, true);
    createDevices({ db: x.db });
    await assert.rejects(unknown, /重启/);
    assert.equal(
      (
        await handle(
          x.devices,
          "/api/device-agent/poll",
          {},
          device.token,
          true,
        )
      ).data.task,
      null,
    );
  } finally {
    x.db.close();
  }
});
test("device screenshot enters model vision content without persisting image data in execution logs", async () => {
  const x = setup();
  try {
    const d = await pair(x.devices);
    x.db
      .prepare("INSERT INTO resources VALUES('a','agent','客服','查看截图',?)")
      .run(JSON.stringify({ boundDeviceId: d.id }));
    let round = 0;
    const providers = {
      async *complete(o) {
        if (round++ === 0)
          o.onToolCalls([
            { id: "screen", name: "device_screenshot", arguments: {} },
          ]);
        else {
          assert.equal(o.messages.at(-1).content[1].type, "image_url");
          yield "截图已读取";
        }
      },
    };
    const runner = createAgentRunner({
      db: x.db,
      providers,
      extensions: createAgentExtensions(x),
      knowledge: () => [],
    });
    const output = (async () => {
      let s = "";
      for await (const t of runner.stream({
        agentId: "a",
        messages: [{ role: "user", content: "查看" }],
      }))
        s += t;
      return s;
    })();
    const task = (
      await handle(x.devices, "/api/device-agent/poll", {}, d.token, true)
    ).data.task;
    assert.ok(task);
    await handle(
      x.devices,
      "/api/device-agent/result",
      {
        id: task.id,
        ok: true,
        result: {
          image: "data:image/jpeg;base64,YQ==",
          width: 100,
          height: 100,
        },
      },
      d.token,
      true,
    );
    assert.equal(await output, "截图已读取");
    assert.equal(
      x.db.prepare("SELECT result FROM device_tasks").get().result,
      "{}",
    );
    assert.ok(
      !JSON.stringify(
        x.db.prepare("SELECT * FROM agent_tool_calls").all(),
      ).includes("YQ=="),
    );
  } finally {
    x.db.close();
  }
});
