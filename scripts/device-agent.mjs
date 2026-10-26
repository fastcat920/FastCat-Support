import { readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { hostname, platform } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
const args = process.argv.slice(2),
  value = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined),
  has = (k) => args.includes(k);
const server = value("--server"),
  config = resolve(value("--config") || ".fastcat-device.json");
if (!server || !/^https?:\/\//.test(server)) {
  console.error(
    "Usage: node scripts/device-agent.mjs --server http://127.0.0.1:4310 --code CODE [--config PATH] [--allow-control] [--driver FILE]",
  );
  process.exit(1);
}
const url = new URL(server);
if (
  url.protocol !== "https:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
)
  throw Error("远程服务必须使用 HTTPS");
const driver = await import(
  has("--driver")
    ? pathToFileURL(resolve(value("--driver"))).href
    : new URL("./mac-device-driver.mjs", import.meta.url)
);
const capabilities = Object.keys(driver.commands).filter(
  (k) => has("--allow-control") || k === "screenshot",
);
let identity;
async function post(path, data, token) {
  const r = await fetch(new URL("/api/device-agent/" + path, url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error("设备接口 " + r.status);
  return r.json();
}
if (has("--code")) {
  identity = {
    ...(await post("register", {
      code: value("--code"),
      name: hostname(),
      os: platform(),
      capabilities,
    })),
    server: url.origin,
  };
  await writeFile(config, JSON.stringify(identity), { mode: 0o600 });
  await chmod(config, 0o600);
  console.log("设备已绑定，凭据保存在指定配置文件。");
} else {
  identity = JSON.parse(await readFile(config, "utf8"));
  if (identity.server !== url.origin) throw Error("配置文件服务器不匹配");
}
let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));
console.log("设备代理运行中；请在后台将设备绑定到智能体。");
while (!stopping) {
  try {
    const { task } = await post("poll", {}, identity.token);
    if (task) {
      let result = {},
        ok = false,
        error = "";
      try {
        if (!capabilities.includes(task.command))
          throw Error("本地未授权此操作");
        const heartbeat = setInterval(
          () => post("heartbeat", {}, identity.token).catch(() => {}),
          8000,
        );
        try {
          result = await driver.commands[task.command](task.args);
        } finally {
          clearInterval(heartbeat);
        }
        ok = true;
      } catch (e) {
        error = "本地操作失败，请检查设备权限和驱动状态";
      }
      await post("result", { id: task.id, ok, result, error }, identity.token);
    } else await wait(1000);
  } catch (e) {
    console.error(e.message);
    await wait(3000);
  }
}
