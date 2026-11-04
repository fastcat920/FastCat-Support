import { randomUUID, createHash } from "node:crypto";
import { HttpError } from "./management.mjs";
export const repairOperations = {
  switch_route: {
    label: "切换线路并验证",
    impact:
      "临时切换到确认的备用线路并检查实际链路，完成后恢复原线路。可能短暂断网，不会自动保留新线路。",
  },
  reconnect: {
    label: "重新连接",
    impact: "使用当前节点重新连接，可能短暂断网。",
  },
  restart_core: {
    label: "重启内核",
    impact: "重启客户端内核并恢复原连接状态，可能短暂断网。",
  },
  reapply_proxy: {
    label: "重新应用代理",
    impact:
      "修改 FastCat 管理的代理设置；客户端必须先保存快照，复查失败时在本地回滚。",
  },
  restore_settings: {
    label: "恢复修改前的设置",
    impact:
      "恢复指定修复请求前的本地设置快照；当前设置与快照预期不符时应停止并重新确认。",
  },
};
const hash = (s) => createHash("sha256").update(s).digest("hex");
export function createRepairs({
  db,
  clock = () => Date.now(),
  broadcast = () => {},
  getDevice,
  consents,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS assistance_repairs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,device_id TEXT NOT NULL,operation TEXT NOT NULL,restore_request_id TEXT,reason TEXT NOT NULL,actor_id TEXT,status TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,accepted INTEGER,finished INTEGER,execution_hash TEXT,result TEXT);
 CREATE INDEX IF NOT EXISTS assistance_repairs_conversation ON assistance_repairs(conversation_id,created);`);
  for (const name of ["target_route_id", "target_route_label", "grant_id"])
    if (
      !db
        .prepare("PRAGMA table_info(assistance_repairs)")
        .all()
        .some((c) => c.name === name)
    )
      db.exec(`ALTER TABLE assistance_repairs ADD COLUMN ${name} TEXT`);
  db.prepare(
    "UPDATE assistance_repairs SET status='unknown' WHERE status='running'",
  ).run();
  const fail = (n, s) => {
    throw new HttpError(n, s);
  };
  function refresh(id) {
    const device = getDevice(id);
    if (device) {
      db.prepare(
        "UPDATE assistance_repairs SET status='revoked',finished=? WHERE conversation_id=? AND device_id!=? AND status='pending'",
      ).run(clock(), id, device.deviceId);
      db.prepare(
        "UPDATE assistance_repairs SET status='unknown' WHERE conversation_id=? AND device_id!=? AND status='running'",
      ).run(id, device.deviceId);
    }
    db.prepare(
      "UPDATE assistance_repairs SET status='expired',finished=? WHERE conversation_id=? AND status='pending' AND expires<=?",
    ).run(clock(), id, clock());
    db.prepare(
      "UPDATE assistance_repairs SET status='unknown' WHERE conversation_id=? AND status='running' AND expires<=?",
    ).run(id, clock());
    if (
      db.prepare("SELECT status FROM conversations WHERE id=?").get(id)
        ?.status === "closed"
    ) {
      db.prepare(
        "UPDATE assistance_repairs SET status='revoked',finished=? WHERE conversation_id=? AND status='pending'",
      ).run(clock(), id);
      db.prepare(
        "UPDATE assistance_repairs SET status='unknown' WHERE conversation_id=? AND status='running'",
      ).run(id);
    }
  }
  function state(id) {
    refresh(id);
    return db
      .prepare(
        "SELECT * FROM assistance_repairs WHERE conversation_id=? ORDER BY created DESC,rowid DESC LIMIT 30",
      )
      .all(id)
      .map(({ execution_hash, ...r }) => ({
        ...r,
        result: r.result ? JSON.parse(r.result) : null,
        ...repairOperations[r.operation],
      }));
  }
  function request(
    id,
    operation,
    reason,
    actorId = null,
    restoreRequestId = null,
    targetRouteId = null,
  ) {
    refresh(id);
    const conversation = db
      .prepare("SELECT status FROM conversations WHERE id=?")
      .get(id);
    if (!conversation || !["open", "pending"].includes(conversation.status))
      fail(409, "会话不存在或已结束");
    const device = getDevice(id);
    if (
      !Object.hasOwn(repairOperations, operation) ||
      !device?.online ||
      !device.repairCapabilities?.includes(operation)
    )
      fail(409, "客户端未接入此修复能力或已离线");
    const target =
      operation === "switch_route" &&
      device.routeOptions?.find((r) => r.id === targetRouteId);
    if (operation === "switch_route" && !target)
      fail(409, "请选择客户端提供的备用线路");
    if (operation !== "switch_route" && targetRouteId)
      fail(400, "此操作不支持选择线路");
    const busy = db
      .prepare(
        "SELECT id,status FROM assistance_repairs WHERE conversation_id=? AND device_id=? AND status IN ('pending','running','unknown')",
      )
      .get(id, device.deviceId);
    if (busy) fail(409, "已有修复请求等待确认或结果待确认，请先查询原请求结果");
    if (operation === "restore_settings") {
      const original =
        typeof restoreRequestId === "string" &&
        db
          .prepare(
            "SELECT * FROM assistance_repairs WHERE id=? AND conversation_id=? AND device_id=? AND status IN ('succeeded','failed','rolled_back')",
          )
          .get(restoreRequestId, id, device.deviceId);
      if (
        !original ||
        ![
          "reconnect",
          "restart_core",
          "reapply_proxy",
          "switch_route",
        ].includes(original.operation) ||
        !JSON.parse(original.result || "{}").snapshotAvailable
      )
        fail(409, "没有可恢复的本机修复快照");
    } else if (restoreRequestId) fail(400, "此操作不支持指定恢复请求");
    if (
      db
        .prepare(
          "SELECT count(*) n FROM assistance_repairs WHERE conversation_id=? AND created>?",
        )
        .get(id, clock() - 60000).n >= 3
    )
      fail(429, "修复请求过于频繁");
    const uid = randomUUID();
    db.prepare(
      "INSERT INTO assistance_repairs(id,conversation_id,device_id,operation,restore_request_id,reason,actor_id,status,created,expires,accepted,finished,execution_hash,result,target_route_id,target_route_label) VALUES(?,?,?,?,?,?,?,'pending',?,?,NULL,NULL,NULL,NULL,?,?)",
    ).run(
      uid,
      id,
      device.deviceId,
      operation,
      restoreRequestId,
      String(reason || "排查当前连接问题").slice(0, 300),
      actorId,
      clock(),
      clock() + 5 * 60000,
      target ? target.id : null,
      target ? target.label : null,
    );
    broadcast(id);
    return { id: uid, status: "pending", ...repairOperations[operation] };
  }
  function visitor(id, b) {
    const response = () => ({
      repairs: state(id),
      conversationClosed:
        db.prepare("SELECT status FROM conversations WHERE id=?").get(id)
          ?.status === "closed",
    });
    const row = db
      .prepare(
        "SELECT * FROM assistance_repairs WHERE id=? AND conversation_id=?",
      )
      .get(b.requestId, id);
    if (!row || row.device_id !== b.deviceId) fail(403, "修复请求与设备不匹配");
    refresh(id);
    const current = db
      .prepare("SELECT * FROM assistance_repairs WHERE id=?")
      .get(row.id);
    if (b.action === "repair_decline") {
      if (current.status !== "pending") fail(409, "修复请求状态已变化");
      db.prepare(
        "UPDATE assistance_repairs SET status='declined',finished=? WHERE id=?",
      ).run(clock(), row.id);
    } else if (b.action === "repair_accept") {
      if (
        typeof b.executionKey !== "string" ||
        !/^[-\w]{40,100}$/.test(b.executionKey)
      )
        fail(400, "执行凭据无效");
      if (
        current.accepted !== null &&
        current.execution_hash === hash(b.executionKey)
      )
        return response();
      if (current.status !== "pending")
        fail(409, "请求已处理或已过期，不得重新执行");
      const device = getDevice(id);
      if (
        !device?.online ||
        device.deviceId !== row.device_id ||
        !device.repairCapabilities.includes(row.operation) ||
        (row.operation === "switch_route" &&
          !device.routeOptions?.some(
            (r) =>
              r.id === row.target_route_id &&
              r.label === row.target_route_label,
          ))
      )
        fail(409, "设备修复能力已变化");
      const grant = consents?.require(
        id,
        b.grantId,
        "operation",
        row.operation,
        row.operation === "switch_route"
          ? { id: row.target_route_id, label: row.target_route_label }
          : null,
      );
      db.prepare(
        "UPDATE assistance_repairs SET status='running',accepted=?,expires=?,execution_hash=?,grant_id=? WHERE id=? AND status='pending'",
      ).run(
        clock(),
        Math.min(clock() + 3 * 60000, grant?.expires || Infinity),
        hash(b.executionKey),
        grant?.id || null,
        row.id,
      );
    } else if (b.action === "repair_result") {
      if (
        current.accepted === null ||
        typeof b.executionKey !== "string" ||
        hash(b.executionKey) !== current.execution_hash
      )
        fail(403, "修复执行凭据无效");
      if (
        ["succeeded", "failed", "rolled_back", "not_started"].includes(
          current.status,
        )
      )
        return response();
      // Late results remain admissible after a disconnect, expiry, server restart or closed chat.
      if (!["running", "unknown"].includes(current.status))
        fail(409, "修复未获执行授权");
      const r = b.result;
      if (
        !r ||
        typeof r !== "object" ||
        !["succeeded", "failed", "rolled_back", "not_started"].includes(
          r.outcome,
        ) ||
        typeof r.summary !== "string" ||
        r.summary.length > 1000 ||
        typeof r.verified !== "boolean" ||
        typeof r.snapshotAvailable !== "boolean"
      )
        fail(400, "修复结果无效");
      if (r.outcome === "succeeded" && !r.verified)
        fail(400, "未复查的结果不能标记成功");
      if (
        !["not_needed", "succeeded", "failed", "not_attempted"].includes(
          r.rollback,
        )
      )
        fail(400, "回滚状态无效");
      if (r.outcome === "rolled_back" && r.rollback !== "succeeded")
        fail(400, "回滚结果不一致");
      if (
        row.operation === "switch_route" &&
        (typeof r.originalRouteRestored !== "boolean" ||
          (r.outcome === "succeeded" && !r.originalRouteRestored))
      )
        fail(400, "线路验证必须报告是否恢复原线路，未恢复不能标记成功");
      const result = {
        outcome: r.outcome,
        summary: r.summary
          .replace(/https?:\/\/[^\s]+/gi, "[链接已隐藏]")
          .replace(
            /((?:token|password|secret|authorization|subscription|密码|密钥)\s*[:=]\s*)[^\s,;]+/gi,
            "$1[已隐藏]",
          ),
        verified: r.verified,
        snapshotAvailable: r.snapshotAvailable,
        rollback: r.rollback,
        ...(row.operation === "switch_route"
          ? { originalRouteRestored: r.originalRouteRestored }
          : {}),
      };
      db.prepare(
        "UPDATE assistance_repairs SET status=?,result=?,finished=? WHERE id=?",
      ).run(result.outcome, JSON.stringify(result), clock(), row.id);
    } else fail(400, "未知修复操作");
    broadcast(id);
    return response();
  }
  return { state, request, visitor };
}
