import { spawnSync } from "node:child_process";
import {
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";

export function command(exe, args, cwd, { capture = false } = {}) {
  const result = spawnSync(exe, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error || result.status !== 0)
    throw Error(
      `${exe} 执行失败${capture ? ": " + (result.stderr || "").trim() : ""}`,
    );
  return result.stdout?.trim() || "";
}
export async function healthy(port) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const ok = await new Promise((resolve) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/setup", timeout: 2000 },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error("重启后的服务检查未通过，请查看宝塔项目日志；不会自动回退数据库");
}
export async function update(
  root,
  {
    run = command,
    checkHealth = healthy,
    python = "/www/server/panel/pyenv/bin/python3",
  } = {},
) {
  const configFile = resolve(root, ".fastcat-update.json");
  const config = existsSync(configFile)
    ? JSON.parse(readFileSync(configFile, "utf8"))
    : {};
  const name =
    process.env.UPDATE_BT_PROJECT || config.projectName || "fastcat-support";
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(name)) throw Error("宝塔项目名无效");
  const bt = resolve(root, "scripts/baota-project.py");
  const metadata = JSON.parse(
    run(python, [bt, "check", name, root], root, { capture: true }),
  );
  const port = Number(process.env.UPDATE_PORT || config.port || metadata.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("服务端口无效");
  if (
    run("git", ["status", "--porcelain", "--untracked-files=normal"], root, {
      capture: true,
    })
  )
    throw Error("仓库有本地修改或未跟踪文件，请先处理；更新不会覆盖它们");
  if (
    run("git", ["branch", "--show-current"], root, { capture: true }) !== "main"
  )
    throw Error("请切换到 main 分支后更新");
  const before = run("git", ["rev-parse", "HEAD"], root, { capture: true });
  run("git", ["pull", "--ff-only", "origin", "main"], root);
  const changed = run(
    "git",
    [
      "diff",
      "--name-only",
      before,
      "HEAD",
      "--",
      "package.json",
      "package-lock.json",
    ],
    root,
    { capture: true },
  );
  if (changed || !existsSync(resolve(root, "node_modules"))) {
    console.log("安装生产依赖…");
    const npm = process.env.npm_execpath;
    if (!npm) throw Error("请通过 npm run update 执行");
    run(process.execPath, [npm, "ci", "--omit=dev"], root);
  }
  run(python, [bt, "restart", name, root], root);
  await checkHealth(port);
  console.log("更新完成，服务检查通过");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const lock = resolve(root, ".fastcat-update.lock");
  let owned = false;
  try {
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8"));
      let active = true;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (e) {
          if (e.code === "ESRCH") active = false;
        }
      }
      if (active) throw Error("已有更新任务运行，请稍后再试");
      unlinkSync(lock);
    }
    const fd = openSync(lock, "wx", 0o600);
    owned = true;
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    await update(root);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (owned) unlinkSync(lock);
  }
}
