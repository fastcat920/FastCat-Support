import { validateWorkflow } from "./workflow.mjs";
import { HttpError } from "./management.mjs";
export function migrateWorkflowVersions(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS workflow_state(workflow_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0, published_version INTEGER);
CREATE TABLE IF NOT EXISTS workflow_versions(workflow_id TEXT REFERENCES resources(id) ON DELETE CASCADE, version INTEGER, snapshot TEXT NOT NULL, note TEXT, actor_id TEXT, created TEXT, PRIMARY KEY(workflow_id,version));
CREATE TABLE IF NOT EXISTS workflow_run_versions(run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE, version INTEGER, revision INTEGER);
`);
}
export function workflowEditorState(db, id) {
  const row = db
    .prepare("SELECT * FROM resources WHERE id=? AND kind='workflow'")
    .get(id);
  if (!row) throw new HttpError(404, "工作流不存在");
  const state = db
    .prepare("SELECT * FROM workflow_state WHERE workflow_id=?")
    .get(id);
  return {
    ...row,
    config: JSON.parse(row.config),
    revision: state?.revision || 0,
    publishedVersion: state?.published_version || null,
  };
}
function expect(current, revision) {
  if (revision !== current.revision)
    throw new HttpError(
      409,
      "工作流已被其他编辑更新，请保留本地草稿后重新打开",
    );
}
export function saveWorkflowDraft(db, id, b) {
  const old = workflowEditorState(db, id);
  expect(old, b.expectedRevision);
  if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 200)
    throw new HttpError(400, "工作流名称须为 1–200 字符");
  if (!b.config || typeof b.config !== "object" || Array.isArray(b.config))
    throw new HttpError(400, "配置必须为对象");
  validateWorkflow(b.config.definition);
  db.exec("SAVEPOINT workflow_edit");
  try {
    db.prepare(
      "UPDATE resources SET name=?,description=?,config=? WHERE id=?",
    ).run(
      b.name.trim(),
      String(b.description || "").slice(0, 10000),
      JSON.stringify(b.config),
      id,
    );
    db.prepare(
      "INSERT INTO workflow_state(workflow_id,revision) VALUES(?,1) ON CONFLICT(workflow_id) DO UPDATE SET revision=revision+1",
    ).run(id);
    db.exec("RELEASE workflow_edit");
  } catch (e) {
    db.exec("ROLLBACK TO workflow_edit");
    db.exec("RELEASE workflow_edit");
    throw e;
  }
  return workflowEditorState(db, id);
}
export function workflowRunSnapshot(db, id, b = {}) {
  const current = workflowEditorState(db, id);
  if (b.published === true || b.version !== undefined) {
    const version = b.version ?? current.publishedVersion;
    if (!Number.isInteger(version) || version < 1)
      throw new HttpError(400, "请先发布工作流版本");
    const row = db
      .prepare(
        "SELECT snapshot FROM workflow_versions WHERE workflow_id=? AND version=?",
      )
      .get(id, version);
    if (!row) throw new HttpError(404, "发布版本不存在");
    return { ...JSON.parse(row.snapshot), version, revision: null };
  }
  return { ...current, version: null };
}
export async function handleWorkflowVersions({
  req,
  res,
  url,
  u,
  db,
  body,
  send,
}) {
  const m = url.pathname.match(
    /^\/api\/workflows\/([^/]+)\/(editor|publish|versions|restore)$/,
  );
  if (!m) return false;
  const current = workflowEditorState(db, m[1]),
    action = m[2];
  if (req.method === "GET" && action === "editor") {
    send(res, 200, current);
    return true;
  }
  if (req.method === "GET" && action === "versions") {
    send(
      res,
      200,
      db
        .prepare(
          "SELECT v.version,v.note,v.created,u.name actorName FROM workflow_versions v LEFT JOIN users u ON u.id=v.actor_id WHERE workflow_id=? ORDER BY version DESC",
        )
        .all(current.id),
    );
    return true;
  }
  if (req.method === "PUT" && action === "editor") {
    send(res, 200, saveWorkflowDraft(db, current.id, await body(req)));
    return true;
  }
  if (req.method === "POST" && action === "publish") {
    const b = await body(req);
    const latest = workflowEditorState(db, current.id);
    expect(latest, b.expectedRevision);
    validateWorkflow(latest.config.definition);
    const note = String(b.note || "").trim();
    if (note.length > 1000) throw new HttpError(400, "发布说明最多 1000 字符");
    const version = db
      .prepare(
        "SELECT coalesce(max(version),0)+1 n FROM workflow_versions WHERE workflow_id=?",
      )
      .get(current.id).n;
    const snapshot = {
      name: latest.name,
      description: latest.description,
      config: latest.config,
    };
    db.exec("SAVEPOINT workflow_publish");
    try {
      db.prepare("INSERT INTO workflow_versions VALUES(?,?,?,?,?,?)").run(
        current.id,
        version,
        JSON.stringify(snapshot),
        note,
        u.id,
        new Date().toISOString(),
      );
      db.prepare(
        "INSERT INTO workflow_state(workflow_id,published_version) VALUES(?,?) ON CONFLICT(workflow_id) DO UPDATE SET published_version=excluded.published_version",
      ).run(current.id, version);
      db.exec("RELEASE workflow_publish");
    } catch (e) {
      db.exec("ROLLBACK TO workflow_publish");
      db.exec("RELEASE workflow_publish");
      throw e;
    }
    send(res, 201, { version, revision: latest.revision });
    return true;
  }
  if (req.method === "POST" && action === "restore") {
    const b = await body(req);
    if (!Number.isInteger(b.version) || b.version < 1)
      throw new HttpError(400, "恢复版本无效");
    expect(workflowEditorState(db, current.id), b.expectedRevision);
    const snapshot = workflowRunSnapshot(db, current.id, {
      version: b.version,
    });
    send(
      res,
      200,
      saveWorkflowDraft(db, current.id, {
        ...snapshot,
        expectedRevision: b.expectedRevision,
      }),
    );
    return true;
  }
  throw new HttpError(405, "不支持的工作流操作");
}
