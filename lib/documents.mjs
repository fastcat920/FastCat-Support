import { Worker } from "node:worker_threads";
import { HttpError } from "./management.mjs";
let running = 0;
export function parseDocument(filename, data, { timeout = 30000 } = {}) {
  if (running >= 2) throw new HttpError(429, "正在解析其他文档，请稍后重试");
  running++;
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker;
    try {
      worker = new Worker(new URL("./document-worker.mjs", import.meta.url), {
        workerData: { filename, data },
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
    } catch (error) {
      running--;
      reject(error);
      return;
    }
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      running--;
      clearTimeout(timer);
      worker.terminate();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(
      () => finish(new HttpError(408, "文档解析超时，请拆分后重试")),
      timeout,
    );
    worker.on("message", (result) =>
      finish(result.ok ? null : new HttpError(400, result.error), result),
    );
    worker.on("error", () =>
      finish(new HttpError(400, "文档解析失败，文件可能损坏或超过资源限制")),
    );
    worker.on("exit", (code) => {
      if (!settled) finish(new HttpError(400, "文档解析未完成"));
    });
  });
}
