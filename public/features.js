import { createRetrievalUI } from "./retrieval.js";
import { createKnowledgeJobsUI } from "./knowledge-jobs.js";
import {
  layoutFlow,
  flowHistory,
  duplicateNode,
  connectNodes,
} from "./flow-model.js";
export function createFeatureUI({
  api,
  E,
  modal,
  toast,
  isActive,
  isAdmin = () => true,
}) {
  let refreshRetrievalStatus = () => {};
  const retrievalUI = createRetrievalUI({
    api,
    E,
    modal,
    toast,
    isAdmin,
    onChange: () => refreshRetrievalStatus(),
  });
  const knowledgeJobsUI = createKnowledgeJobsUI({
    api,
    E,
    modal,
    toast,
    refresh: () => render("knowledge"),
    isAvailable: () => isAdmin() && isActive("knowledge"),
  });
  const state = {
    collection: "default",
    query: "",
    source: "all",
    category: "",
    epoch: 0,
  };
  const labels = {
    start: "开始",
    text: "文本处理",
    knowledge: "知识检索",
    condition: "条件分支",
    llm: "大模型",
    tool: "工具调用",
    output: "输出",
  };
  const nodeIcons = {
    start: "▷",
    text: "T",
    knowledge: "▧",
    condition: "⑂",
    llm: "✧",
    tool: "⊞",
    output: "↗",
  };
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (err) {
      toast(err.message);
    }
  };
  const post = (p, b) => api(p, { method: "POST", body: JSON.stringify(b) });
  const options = (rows, value) =>
    rows
      .map(
        (r) =>
          `<option value="${E(r.id)}" ${r.id === value ? "selected" : ""}>${E(r.name)}</option>`,
      )
      .join("");
  function textField(
    name,
    label,
    value = "",
    placeholder = "",
    required = true,
  ) {
    return `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" value="${E(value)}" placeholder="${E(placeholder)}" ${required ? "required" : ""}></div>`;
  }
  const heading = (title, desc, action) =>
    `<div class="page-heading"><div><h1>${title}</h1><p>${desc}</p></div>${action}</div>`;
  const noData = (name, desc) =>
    `<div class="empty"><div class="empty-symbol">⊞</div><strong>${name}</strong><p>${desc}</p></div>`;
  function removeDialog(item, onDone) {
    modal(
      "删除确认",
      `<p>确定删除「${E(item.name)}」？此操作无法撤销。</p>`,
      "确认删除",
      async () => {
        await api("/resources/" + item.id, { method: "DELETE" });
        toast("已删除");
        await onDone();
      },
    );
  }
  let catalogs = { agents: [], tools: [], collections: [] };
  async function render(kind) {
    const epoch = ++state.epoch;
    const rows = await api("/resources?kind=" + kind);
    if (!isActive(kind) || epoch !== state.epoch) return;
    if (kind === "knowledge") return knowledgePage(rows, epoch);
    if (kind === "workflow") {
      const [agents, tools, collections] = await Promise.all([
        api("/resources?kind=agent"),
        api("/resources?kind=tool"),
        api("/knowledge/collections"),
      ]);
      if (!isActive(kind) || epoch !== state.epoch) return;
      catalogs = { agents, tools, collections };
      return workflowPage(rows);
    }
    return toolPage(rows);
  }
  async function knowledgePage(rows, epoch) {
    const route = location.hash.match(
      /^#knowledge\/([^/]+)\/(all|document|qa|website)$/,
    );
    if (route) {
      try {
        state.collection = decodeURIComponent(route[1]);
        state.source = route[2];
      } catch {
        state.collection = "default";
        state.source = "all";
      }
    }
    const collections = await api("/knowledge/collections");
    if (!isActive("knowledge") || epoch !== state.epoch) return;
    if (!collections.some((c) => c.id === state.collection))
      state.collection = "default";
    const selected = collections.find((c) => c.id === state.collection);
    const setKnowledgeRoute = () => {
      const hash = `#knowledge/${encodeURIComponent(state.collection)}/${state.source}`;
      if (location.hash !== hash) history.pushState(null, "", hash);
    };
    document.querySelector("#view").innerHTML =
      `<div class="content feature-content">${heading("知识库", "整理业务知识，让每次回答有据可依。", '<button class="primary" id="new-document">＋ 添加知识</button>')}<div class="knowledge-layout"><aside class="collection-panel"><div class="panel-head"><span class="section-label">知识库</span><button class="quiet" id="new-collection" aria-label="创建知识库">＋</button></div>${collections.map((c) => `<button class="collection-item ${c.id === state.collection ? "active" : ""}" data-collection="${c.id}"><span class="icon">▧</span><span>${E(c.name)}</span><span class="count">${c.documentCount}</span></button>`).join("")}<div class="collection-help small">知识分块后自动建立检索索引。可在智能体中绑定指定知识库。</div></aside><section class="panel knowledge-main"><div class="panel-head"><div><h2>${E(selected.name)}</h2><p class="small">${E(selected.description || "")} · ${selected.chunkCount} 个分块</p></div><div class="row"><button id="retrieval-test">检索测试</button>${isAdmin() ? '<button id="retrieval-config">检索配置</button><button id="embedding-jobs">向量索引</button><button id="website-sources">网站采集与同步</button>' : ""}${state.collection !== "default" ? '<button class="quiet danger" id="delete-collection">删除知识库</button>' : ""}</div></div><div class="toolbar"><input id="knowledge-filter" aria-label="搜索知识" placeholder="搜索知识名称或说明…" value="${E(state.query)}"><span class="small">${selected.documentCount} 个知识来源</span></div><div id="knowledge-table"></div></section></div></div>`;
    document.querySelector("#retrieval-config")?.addEventListener(
      "click",
      safe(() => retrievalUI.configure(selected)),
    );
    document.querySelector("#embedding-jobs")?.addEventListener(
      "click",
      safe(() => retrievalUI.jobs(selected)),
    );
    const toolbar = document
      .querySelector("#knowledge-filter")
      .closest(".toolbar");
    const indexSummary = document.createElement("div");
    indexSummary.className = "knowledge-index-summary small";
    indexSummary.setAttribute("role", "status");
    indexSummary.textContent = "正在读取检索状态…";
    toolbar.before(indexSummary);
    const refreshIndex = document.createElement("button");
    refreshIndex.type = "button";
    refreshIndex.textContent = "刷新检索状态";
    toolbar.before(refreshIndex);
    let indexRevision = 0;
    const loadIndexSummary = () => {
      const requestRevision = ++indexRevision;
      return api(
        "/knowledge/retrieval/collections/" + encodeURIComponent(selected.id),
      )
        .then(({ config, jobs }) => {
          if (
            !isActive("knowledge") ||
            epoch !== state.epoch ||
            requestRevision !== indexRevision ||
            !indexSummary.isConnected
          )
            return;
          const mode =
            { bm25: "关键词", semantic: "语义", hybrid: "混合" }[config.mode] ||
            config.mode;
          const active = jobs.find((job) =>
            ["queued", "running"].includes(job.status),
          );
          indexSummary.textContent = `检索模式：${mode} · 有效向量：${config.indexed} / ${config.total} 个分块${active ? ` · 索引${active.status === "running" ? "进行中" : "等待执行"} ${active.done} / ${active.total}` : ""}${config.error ? ` · ${config.error}` : ""}`;
        })
        .catch(() => {
          if (requestRevision === indexRevision && indexSummary.isConnected)
            indexSummary.textContent = "暂时无法读取检索状态，请刷新重试。";
        });
    };
    refreshIndex.onclick = loadIndexSummary;
    refreshRetrievalStatus = loadIndexSummary;
    loadIndexSummary();
    if (isAdmin()) {
      const importButton = document.createElement("button");
      importButton.type = "button";
      importButton.textContent = "批量导入问答";
      importButton.onclick = () => importQuestions(selected);
      toolbar.before(importButton);
    }
    const sourceTabs = document.createElement("nav");
    sourceTabs.className = "knowledge-source-tabs";
    sourceTabs.setAttribute("aria-label", "知识来源类型");
    toolbar.before(sourceTabs);
    const categoryFilter = document.createElement("select");
    categoryFilter.setAttribute("aria-label", "问答分类");
    toolbar.append(categoryFilter);
    const sources = [
      ["all", "全部"],
      ["document", "文档"],
      ["qa", "问答"],
      ["website", "网站"],
    ];
    const sourceOf = (row) =>
      row.config.source === "qa" || row.config.source === "website"
        ? row.config.source
        : "document";
    const draw = () => {
      const inCollection = rows.filter(
        (r) => (r.config.collectionId || "default") === state.collection,
      );
      const categories = [
        ...new Set(
          inCollection
            .filter((r) => sourceOf(r) === "qa")
            .map((r) => r.config.category || "")
            .filter(Boolean),
        ),
      ].sort();
      if (state.category && !categories.includes(state.category))
        state.category = "";
      categoryFilter.innerHTML =
        '<option value="">全部分类</option>' +
        categories
          .map(
            (category) =>
              `<option value="${E(category)}">${E(category)}</option>`,
          )
          .join("");
      categoryFilter.value = state.category;
      categoryFilter.hidden = state.source !== "qa" || !categories.length;
      sourceTabs.innerHTML = sources
        .map(([key, label]) => {
          const count =
            key === "all"
              ? inCollection.length
              : inCollection.filter((r) => sourceOf(r) === key).length;
          return `<button type="button" data-knowledge-source="${key}" class="${state.source === key ? "active" : ""}" aria-pressed="${state.source === key}">${label} <span>${count}</span></button>`;
        })
        .join("");
      sourceTabs
        .querySelectorAll("[data-knowledge-source]")
        .forEach((button) => {
          button.onclick = () => {
            state.source = button.dataset.knowledgeSource;
            state.category = "";
            setKnowledgeRoute();
            draw();
          };
        });
      const list = rows.filter(
        (r) =>
          (r.config.collectionId || "default") === state.collection &&
          (state.source === "all" || sourceOf(r) === state.source) &&
          (!state.category || r.config.category === state.category) &&
          (r.name + r.description)
            .toLowerCase()
            .includes(state.query.toLowerCase()),
      );
      document.querySelector("#knowledge-table").innerHTML = list.length
        ? `<div class="table-scroll"><table class="table knowledge-table"><thead><tr><th>名称</th><th>类型</th><th>状态</th><th>操作</th></tr></thead><tbody>${list.map((r) => `<tr><td><strong>${E(r.name)}</strong><div class="small">${E(r.description.slice(0, 55))}${r.description.length > 55 ? "…" : ""}</div></td><td><span class="badge neutral">${r.config.source === "website" ? "网站" : r.config.source === "qa" ? "问答" : "文档"}</span></td><td><span class="status-dot">关键词已索引</span></td><td><div class="row"><button class="quiet" data-view-knowledge="${r.id}">查看详情</button>${r.config.source === "file" ? `<a class="file-source-link" href="/api/knowledge/files/${r.id}" download>原文件</a>` : ""}${r.config.sourceId ? '<span class="small">由采集来源维护</span>' : `${r.config.source === "website" ? `<button class="quiet" data-sync-source="${r.id}">同步</button>` : ""}<button class="quiet" data-edit="${r.id}">编辑</button><button class="quiet danger" data-delete="${r.id}" aria-label="删除 ${E(r.name)}">删除</button>`}</div></td></tr>`).join("")}</tbody></table></div>`
        : noData(
            state.query || state.source !== "all"
              ? "没有匹配的知识"
              : "还没有知识内容",
            state.query || state.source !== "all"
              ? "试试其他关键词或切换来源类型。"
              : isAdmin()
                ? "添加文档、问答或网站内容，开始构建你的知识库。"
                : "请联系管理员添加知识内容。",
          );
      if (!isAdmin())
        document
          .querySelectorAll(
            "#new-document,#new-collection,#delete-collection,[data-edit],[data-delete],[data-sync-source]",
          )
          .forEach((button) => (button.hidden = true));
      document.querySelectorAll("[data-sync-source]").forEach(
        (b) =>
          (b.onclick = safe(async () => {
            b.disabled = true;
            try {
              await post("/knowledge/" + b.dataset.syncSource + "/sync", {});
              toast("网站内容已同步");
              await render("knowledge");
            } finally {
              b.disabled = false;
            }
          })),
      );
      document.querySelectorAll("[data-view-knowledge]").forEach((button) => {
        button.onclick = () =>
          knowledgeDetail(
            rows.find((r) => r.id === button.dataset.viewKnowledge),
            selected,
          );
      });
      document.querySelectorAll("[data-edit]").forEach(
        (b) =>
          (b.onclick = () =>
            documentDialog(
              collections,
              rows.find((r) => r.id === b.dataset.edit),
            )),
      );
      document.querySelectorAll("[data-delete]").forEach(
        (b) =>
          (b.onclick = () =>
            removeDialog(
              rows.find((r) => r.id === b.dataset.delete),
              () => render("knowledge"),
            )),
      );
    };
    draw();
    categoryFilter.onchange = () => {
      state.category = categoryFilter.value;
      draw();
    };
    document.querySelector("#knowledge-filter").oninput = (e) => {
      state.query = e.target.value;
      draw();
    };
    document.querySelectorAll("[data-collection]").forEach(
      (b) =>
        (b.onclick = () => {
          state.collection = b.dataset.collection;
          state.query = "";
          state.source = "all";
          state.category = "";
          setKnowledgeRoute();
          render("knowledge");
        }),
    );
    document.querySelector("#new-document").onclick = () =>
      documentDialog(collections);
    document.querySelector("#new-collection").onclick = () =>
      modal(
        "创建知识库",
        textField("name", "知识库名称", "", "例如：产品与售后") +
          textField("description", "说明", "", "用于哪些业务场景", false),
        "创建",
        async (b) => {
          const c = await post("/knowledge/collections", b);
          state.collection = c.id;
          state.source = "all";
          setKnowledgeRoute();
          await render("knowledge");
        },
      );
    document.querySelector("#website-sources")?.addEventListener(
      "click",
      safe(() => knowledgeJobsUI.open(state.collection)),
    );
    document.querySelector("#retrieval-test").onclick = safe(() =>
      retrievalUI.test(selected),
    );
    document
      .querySelector("#delete-collection")
      ?.addEventListener("click", () =>
        modal(
          "删除知识库",
          `<p>删除「${E(selected.name)}」？需先移出或删除其中全部知识。</p>`,
          "删除",
          async () => {
            await api("/knowledge/collections/" + selected.id, {
              method: "DELETE",
            });
            state.collection = "default";
            state.source = "all";
            setKnowledgeRoute();
            render("knowledge");
          },
        ),
      );
  }
  function importQuestions(collection) {
    modal(
      "批量导入问答 · " + collection.name,
      `<p class="small">每次最多 100 条；JSON 为对象数组，CSV 首行使用 question,answer,category。保存后建立关键词索引。</p><div class="field"><label>格式<select name="format"><option value="json">JSON</option><option value="csv">CSV</option></select></label></div><div class="field"><label>导入内容<textarea name="data" rows="12" required placeholder='[{"question":"问题","answer":"答案","category":"分类"}]'></textarea></label></div>`,
      "导入",
      async (values) => {
        const result = await post("/knowledge/qa/import", {
          collectionId: collection.id,
          ...values,
        });
        state.source = "qa";
        state.category = "";
        history.pushState(
          null,
          "",
          `#knowledge/${encodeURIComponent(collection.id)}/qa`,
        );
        toast(`已导入 ${result.count} 条问答`);
        await render("knowledge");
      },
    );
  }
  function knowledgeDetail(item, collection) {
    const source = item.config.source;
    const title =
      source === "qa"
        ? "问答详情"
        : source === "website"
          ? "网站内容详情"
          : "文档详情";
    const content =
      source === "qa"
        ? `<p class="small">分类：${E(item.config.category || "未分类")}</p><h3>问题</h3><p class="knowledge-detail-text">${E(item.config.question || "")}</p><h3>答案</h3><p class="knowledge-detail-text">${E(item.config.answer || "")}</p>`
        : `<h3>${source === "website" ? "采集正文" : "文档内容"}</h3><p class="knowledge-detail-text">${E(item.description || "暂无内容")}</p>`;
    const url =
      source === "website" && item.config.url
        ? `<p class="small">来源地址：${E(item.config.url)}</p>`
        : "";
    const file =
      source === "file"
        ? `<p><a href="/api/knowledge/files/${encodeURIComponent(item.id)}" download>下载原文件</a></p>`
        : "";
    modal(
      title + " · " + item.name,
      `<p class="small">所属知识库：${E(collection.name)}${item.config.sourceId ? " · 由采集来源维护" : ""}</p>${url}${file}${content}`,
      "关闭",
    );
  }
  function documentDialog(collections, existing) {
    let type = existing?.config.source === "qa" ? "qa" : "text";
    const o = modal(
      existing ? "编辑知识" : "添加知识",
      `${!existing ? '<div class="segmented" role="group" aria-label="知识来源"><button type="button" class="active" data-source="text">文本</button><button type="button" data-source="qa">问答</button><button type="button" data-source="file">文件</button><button type="button" data-source="website">网站</button></div>' : ""}${textField("name", "名称", existing?.name || "", "便于识别的知识名称")}<div class="field"><label for="collectionId">所属知识库</label><select id="collectionId" name="collectionId">${options(collections, existing?.config.collectionId || state.collection)}</select></div><div id="source-fields"></div>`,
      "保存并索引",
      async (b) => {
        const collectionId = b.collectionId;
        if (type === "file") {
          const f = o.querySelector("#document-file").files[0];
          if (
            !f ||
            !f.size ||
            f.size > 8 * 1024 * 1024 ||
            !/\.(pdf|docx|txt|md)$/i.test(f.name)
          )
            throw Error("请选择不超过 8 MB 的 PDF、DOCX、TXT 或 Markdown 文件");
          const response = await fetch(
            "/api/knowledge/files?collectionId=" +
              encodeURIComponent(collectionId),
            {
              method: "POST",
              headers: {
                "Content-Type": "application/octet-stream",
                "X-Filename": encodeURIComponent(f.name),
              },
              body: f,
            },
          );
          const result = await response.json();
          if (!response.ok) throw Error(result.error);
          if (b.name && b.name !== f.name) {
            const rows = await api("/resources?kind=knowledge"),
              r = rows.find((r) => r.id === result.id);
            await api("/resources/" + result.id, {
              method: "PATCH",
              body: JSON.stringify({ ...r, name: b.name }),
            });
          }
        } else if (type === "website") {
          await post("/knowledge/crawl", {
            name: b.name,
            collectionId,
            url: b.url,
          });
        } else {
          const config = {
            ...(existing?.config || {}),
            collectionId,
            source: type === "qa" ? "qa" : existing?.config.source || "text",
            ...(type === "qa"
              ? {
                  question: b.question,
                  answer: b.answer,
                  category: b.category || "",
                }
              : {}),
          };
          const description =
            type === "qa"
              ? `问题：${b.question}\n答案：${b.answer}`
              : b.content;
          await api(existing ? "/resources/" + existing.id : "/resources", {
            method: existing ? "PATCH" : "POST",
            body: JSON.stringify({
              kind: "knowledge",
              name: b.name,
              description,
              config,
            }),
          });
        }
        toast("知识已保存并索引");
        await render("knowledge");
      },
    );
    const draw = () => {
      o.querySelector("#source-fields").innerHTML =
        type === "qa"
          ? `${textField("question", "问题", existing?.config.question || "")}${textField("category", "分类（选填）", existing?.config.category || "", "", false)}<div class="field"><label for="answer">答案</label><textarea id="answer" name="answer" required>${E(existing?.config.answer || "")}</textarea></div>`
          : type === "file"
            ? '<div class="field"><label for="document-file">PDF / DOCX / 文本文件</label><input type="file" id="document-file" accept=".pdf,.docx,.txt,.md" required><p class="small">不超过 8 MB、200,000 字符；PDF 最多 100 页，不支持扫描件 OCR。</p></div>'
            : type === "website"
              ? textField("url", "网站地址", "", "https://example.com/help") +
                '<p class="small">导入当前页面的静态正文。网站来源需在服务器允许列表中配置。</p>'
              : `<div class="field"><label for="content">知识内容</label><textarea id="content" name="content" class="document-content" required maxlength="200000">${E(existing?.description || "")}</textarea></div>`;
    };
    draw();
    o.addEventListener("change", (e) => {
      if (e.target.id === "document-file" && e.target.files[0]) {
        const name = o.querySelector('[name="name"]');
        if (!name.value) name.value = e.target.files[0].name;
      }
    });
    o.querySelectorAll("[data-source]").forEach(
      (b) =>
        (b.onclick = () => {
          type = b.dataset.source;
          o.querySelectorAll("[data-source]").forEach((x) =>
            x.classList.toggle("active", x === b),
          );
          draw();
        }),
    );
  }
  const template = () => ({
    nodes: [
      { id: "start", name: "开始", type: "start", config: {} },
      {
        id: "search",
        name: "查询知识",
        type: "knowledge",
        config: { query: "{{input}}" },
      },
      {
        id: "answer",
        name: "输出检索结果",
        type: "output",
        config: { value: "{{nodes.search}}" },
      },
    ],
    edges: [
      { source: "start", target: "search" },
      { source: "search", target: "answer" },
    ],
  });
  function workflowPage(rows) {
    document.querySelector("#view").innerHTML =
      `<div class="content feature-content">${heading("工作流", "通过节点与连接编排客服处理流程。", '<button class="primary" id="new-workflow">＋ 创建工作流</button>')}<div class="toolbar"><span class="small">${rows.length} 个工作流 · 支持知识、条件、模型与工具节点</span></div><div class="grid">${rows
        .map(
          (r) =>
            `<article class="card workflow-card"><div class="row"><div class="feature-icon violet">⌘</div><span class="badge neutral">${r.config.definition?.nodes?.length || 0} 个节点</span><button class="quiet danger" data-delete="${r.id}" aria-label="删除 ${E(r.name)}" style="margin-left:auto">×</button></div><h3>${E(r.name)}</h3><p>${E(r.description || "暂无说明")}</p><div class="workflow-mini">${(
              r.config.definition?.nodes || []
            )
              .slice(0, 5)
              .map(
                (n) =>
                  `<span title="${E(n.name || labels[n.type])}">${nodeIcons[n.type] || "◈"}</span>`,
              )
              .join(
                "<i>→</i>",
              )}</div><div class="card-actions"><button data-editor="${r.id}">编辑流程</button><button data-runs="${r.id}">运行记录</button><button data-versions="${r.id}">版本发布</button><button class="primary" data-run="${r.id}">调试运行</button></div></article>`,
        )
        .join(
          "",
        )}</div>${rows.length ? "" : noData("创建你的第一个工作流", "从知识检索开始，连接业务需要的处理步骤。")}</div>`;
    document.querySelector("#new-workflow").onclick = () =>
      workflowEditor({
        name: "新工作流",
        description: "",
        config: { definition: template() },
      });
    document
      .querySelectorAll("[data-editor]")
      .forEach(
        (b) =>
          (b.onclick = safe(() =>
            workflowEditor(rows.find((r) => r.id === b.dataset.editor)),
          )),
      );
    document
      .querySelectorAll("[data-run]")
      .forEach(
        (b) =>
          (b.onclick = safe(() =>
            runDialog(rows.find((r) => r.id === b.dataset.run)),
          )),
      );
    document
      .querySelectorAll("[data-runs]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            runHistory(rows.find((r) => r.id === b.dataset.runs))),
      );
    document
      .querySelectorAll("[data-versions]")
      .forEach(
        (b) =>
          (b.onclick = safe(() =>
            versionDialog(rows.find((r) => r.id === b.dataset.versions)),
          )),
      );
    document.querySelectorAll("[data-delete]").forEach(
      (b) =>
        (b.onclick = () =>
          removeDialog(
            rows.find((r) => r.id === b.dataset.delete),
            () => render("workflow"),
          )),
    );
  }
  async function workflowEditor(item) {
    if (item.id) item = await api("/workflows/" + item.id + "/editor");
    let definition = structuredClone(item.config.definition || template());
    layoutFlow(definition);
    const history = flowHistory(definition);
    let clipboard = null,
      connecting = null,
      suppressClick = 0;
    let selected = definition.nodes[0]?.id;
    const o = modal(
      item.id ? "编辑工作流" : "创建工作流",
      `<div class="editor-meta">${textField("workflow-name", "工作流名称", item.name)}${textField("workflow-description", "说明", item.description, "简要描述流程用途", false)}</div><div class="workflow-editor"><aside class="node-library"><span class="section-label">添加节点</span>${Object.entries(
        labels,
      )
        .filter(([t]) => t !== "start")
        .map(
          ([t, label]) =>
            `<button type="button" data-add-node="${t}"><span class="node-kind ${t}">${nodeIcons[t]}</span>${label}<span class="muted">＋</span></button>`,
        )
        .join(
          "",
        )}<p class="small">拖动节点标题自由移动。拖动右侧端口到目标节点连线；也可依次点击端口和目标节点。方向键移动，Shift 加速。</p></aside><div class="flow-center"><div class="flow-toolbar" role="toolbar" aria-label="画布操作"><button type="button" id="flow-undo">撤销</button><button type="button" id="flow-redo">重做</button><button type="button" id="flow-copy">复制</button><button type="button" id="flow-paste">粘贴</button><button type="button" id="flow-layout">自动排布</button><button type="button" id="flow-export">导出草稿</button><select id="flow-branch" aria-label="新连接条件"><option value="true">true 分支</option><option value="false">false 分支</option></select><span id="flow-hint" class="small" role="status"></span></div><div class="flow-canvas" id="flow-canvas"></div><div class="connection-editor"><div class="panel-head"><strong>节点连接</strong><button type="button" class="quiet" id="add-edge">＋ 添加连接</button></div><div id="edges"></div></div></div><aside class="node-properties" id="node-properties"></aside></div><p id="workflow-error" class="error" role="alert"></p>`,
      "保存工作流",
      async () => {
        saveProps();
        const name = o.querySelector("#workflow-name").value.trim();
        if (!name) throw Error("工作流名称必填");
        await api(
          item.id ? "/workflows/" + item.id + "/editor" : "/resources",
          {
            method: item.id ? "PUT" : "POST",
            body: JSON.stringify({
              kind: "workflow",
              expectedRevision: item.revision,
              name,
              description: o.querySelector("#workflow-description").value,
              config: { ...item.config, definition },
            }),
          },
        );
        toast("工作流已验证并保存");
        await render("workflow");
      },
    );
    o.querySelector(".modal").classList.add("workflow-dialog");
    function saveProps() {
      const node = definition.nodes.find((n) => n.id === selected);
      if (!node) return;
      const form = o.querySelector("#node-config");
      if (!form) return;
      const name = o.querySelector("#node-name").value.trim();
      let config;
      if (form.dataset.dirty === "true") {
        try {
          config = JSON.parse(form.value || "{}");
        } catch {
          throw Error("节点配置必须是有效 JSON");
        }
      } else {
        config = { ...node.config };
        for (const f of o.querySelectorAll("[data-node-field]")) {
          const key = f.dataset.nodeField;
          if (f.dataset.json === "true") {
            try {
              config[key] = JSON.parse(f.value || "{}");
            } catch {
              throw Error("工具参数必须是有效 JSON");
            }
          } else if (f.value !== "") config[key] = f.value;
          else delete config[key];
        }
      }
      if (!config || typeof config !== "object" || Array.isArray(config))
        throw Error("节点配置须为对象");
      if (["knowledge", "llm"].includes(node.type)) {
        const retries = Number(o.querySelector("#node-retries")?.value || 0),
          delayMs = Number(o.querySelector("#node-retry-delay")?.value || 0);
        if (
          !Number.isInteger(retries) ||
          retries < 0 ||
          retries > 3 ||
          !Number.isInteger(delayMs) ||
          delayMs < 0 ||
          delayMs > 5000
        )
          throw Error("重试次数须为 0–3，间隔须为 0–5000 ms");
        if (retries) node.retry = { retries, delayMs };
        else delete node.retry;
      }
      node.name = name || labels[node.type];
      node.config = config;
    }
    function nodeDefaults(type) {
      return (
        {
          text: { text: "请输入文本 {{input}}" },
          knowledge: { query: "{{input}}", collectionId: state.collection },
          condition: { left: "{{input}}", operator: "contains", right: "退款" },
          llm: { prompt: "请回答客户的问题：{{input}}" },
          tool: { resourceId: "", name: "", arguments: {} },
          output: { value: "{{input}}" },
        }[type] || {}
      );
    }
    function configFields(node) {
      const c = node.config || {};
      const input = (key, label, placeholder = "", area = false) =>
        `<div class="field"><label for="node-${key}">${label}</label>${area ? `<textarea id="node-${key}" data-node-field="${key}" placeholder="${E(placeholder)}">${E(typeof c[key] === "object" ? JSON.stringify(c[key]) : (c[key] ?? ""))}</textarea>` : `<input id="node-${key}" data-node-field="${key}" value="${E(c[key] ?? "")}" placeholder="${E(placeholder)}">`}</div>`;
      const select = (key, label, rows, empty = "全部") =>
        `<div class="field"><label for="node-${key}">${label}</label><select id="node-${key}" data-node-field="${key}"><option value="">${empty}</option>${options(rows, c[key])}</select></div>`;
      return (
        {
          start: '<p class="small">调试时输入的内容可在后续节点中引用。</p>',
          text: input("text", "文本内容", "{{input}}", true),
          knowledge:
            input("query", "检索问题", "{{input}}", true) +
            select("collectionId", "知识库", catalogs.collections),
          condition:
            input("left", "比较内容", "{{input}}") +
            select(
              "operator",
              "判断条件",
              [
                { id: "contains", name: "包含" },
                { id: "equals", name: "等于" },
                { id: "not_empty", name: "非空" },
                { id: "greater_than", name: "大于" },
              ],
              "请选择",
            ) +
            input("right", "比较值", "例如：退款"),
          llm:
            input("prompt", "提示词", "请回答：{{input}}", true) +
            select("agentId", "智能体", catalogs.agents, "默认客服助手"),
          tool:
            select("resourceId", "工具服务", catalogs.tools, "请选择工具服务") +
            input("name", "工具名称", "例如：lookup_order") +
            `<div class="field"><label for="node-arguments">工具参数</label><textarea id="node-arguments" data-node-field="arguments" data-json="true">${E(JSON.stringify(c.arguments || {}, null, 2))}</textarea></div>`,
          output: input("value", "输出内容", "{{nodes.search}}", true),
        }[node.type] || ""
      );
    }
    function draw() {
      const positions = layoutFlow(definition);
      history.record(definition);
      o.querySelector("#flow-undo").disabled = !history.canUndo;
      o.querySelector("#flow-redo").disabled = !history.canRedo;
      o.querySelector("#flow-copy").disabled =
        definition.nodes.find((n) => n.id === selected)?.type === "start";
      o.querySelector("#flow-paste").disabled = !clipboard;
      const width = Math.max(
          660,
          ...[...positions.values()].map((p) => p.x + 220),
        ),
        height = Math.max(
          300,
          ...[...positions.values()].map((p) => p.y + 120),
        );
      o.querySelector("#flow-canvas").innerHTML =
        `<div class="flow-plane" style="width:${width}px;height:${height}px"><svg class="flow-lines" width="${width}" height="${height}" aria-hidden="true">${definition.edges
          .filter((e) => positions.has(e.source) && positions.has(e.target))
          .map((e) => {
            const a = positions.get(e.source),
              b = positions.get(e.target);
            return `<path d="M${a.x + 180},${a.y + 37} C${a.x + 210},${a.y + 37} ${b.x - 30},${b.y + 37} ${b.x},${b.y + 37}" fill="none"/><text x="${(a.x + b.x + 180) / 2}" y="${(a.y + b.y) / 2 + 29}">${E(e.branch || "")}</text>`;
          })
          .join("")}</svg>${definition.nodes
          .map((n) => {
            const p = positions.get(n.id);
            return `<div class="flow-node ${n.id === selected ? "selected" : ""}" data-node="${n.id}" style="left:${p.x}px;top:${p.y}px"><button type="button" class="flow-node-select" data-select-node="${n.id}" aria-label="选择并移动 ${E(n.name || labels[n.type])}"><span class="node-kind ${n.type}">${nodeIcons[n.type]}</span><span><strong>${E(n.name || labels[n.type])}</strong><small>${labels[n.type]}</small></span></button>${n.type !== "output" ? `<button type="button" class="flow-port" data-port="${n.id}" aria-label="从 ${E(n.name || labels[n.type])} 连线">＋</button>` : ""}</div>`;
          })
          .join("")}</div>`;
      o.querySelectorAll("[data-select-node]").forEach(
        (b) =>
          (b.onclick = safe(() => {
            if (Date.now() < suppressClick) {
              suppressClick = 0;
              return;
            }
            if (connecting) {
              finishConnection(b.dataset.selectNode);
              return;
            }
            saveProps();
            selected = b.dataset.selectNode;
            draw();
          })),
      );
      o.querySelectorAll("[data-port]").forEach(
        (b) =>
          (b.onclick = () => {
            if (Date.now() < suppressClick) {
              suppressClick = 0;
              return;
            }
            connecting = b.dataset.port;
            o.querySelector("#flow-hint").textContent =
              "请选择目标节点；Esc 取消连线";
          }),
      );
      const node = definition.nodes.find((n) => n.id === selected);
      o.querySelector("#node-properties").innerHTML = node
        ? `<div class="panel-head"><h3>${labels[node.type]}</h3>${node.type !== "start" ? '<button id="remove-node" type="button" class="quiet danger" aria-label="删除节点">×</button>' : ""}</div><div class="small">节点 ID：${E(node.id)}</div>${textField("node-name", "节点名称", node.name || labels[node.type])}<div class="node-config-fields">${configFields(node)}${["knowledge", "llm"].includes(node.type) ? `<div class="field"><label for="node-retries">失败重试次数</label><input id="node-retries" type="number" min="0" max="3" value="${node.retry?.retries || 0}"></div><div class="field"><label for="node-retry-delay">重试间隔（毫秒）</label><input id="node-retry-delay" type="number" min="0" max="5000" value="${node.retry?.delayMs || 0}"></div><p class="small">默认不重试，最多额外尝试 3 次。模型重试可能产生额外用量。</p>` : ""}</div><details><summary>高级配置</summary><div class="field"><label for="node-config">JSON</label><textarea id="node-config" class="code-input" spellcheck="false">${E(JSON.stringify(node.config || {}, null, 2))}</textarea></div></details><button type="button" id="apply-node">应用配置</button><p class="small">输入：<code>{{input}}</code><br>节点输出：<code>{{nodes.节点ID}}</code><br>条件分支连接须分别填写 true / false。</p>`
        : "";
      o.querySelector("#node-config")?.addEventListener(
        "input",
        (e) => (e.target.dataset.dirty = "true"),
      );
      o.querySelector("#apply-node")?.addEventListener(
        "click",
        safe(() => {
          saveProps();
          draw();
          toast("节点配置已应用");
        }),
      );
      o.querySelector("#remove-node")?.addEventListener("click", () => {
        definition.nodes = definition.nodes.filter((n) => n.id !== selected);
        definition.edges = definition.edges.filter(
          (e) => e.source !== selected && e.target !== selected,
        );
        selected = definition.nodes[0]?.id;
        draw();
      });
      const opts = (value) =>
        definition.nodes
          .map(
            (n) =>
              `<option value="${n.id}" ${n.id === value ? "selected" : ""}>${E(n.name || n.id)}</option>`,
          )
          .join("");
      o.querySelector("#edges").innerHTML = definition.edges
        .map(
          (edge, i) =>
            `<div class="edge-row"><select aria-label="连接 ${i + 1} 起点" data-edge-source="${i}">${opts(edge.source)}</select><span>→</span><select aria-label="连接 ${i + 1} 终点" data-edge-target="${i}">${opts(edge.target)}</select><select aria-label="连接 ${i + 1} 条件" data-edge-branch="${i}"><option value="">默认</option><option value="true" ${edge.branch === "true" ? "selected" : ""}>true</option><option value="false" ${edge.branch === "false" ? "selected" : ""}>false</option></select><button class="quiet danger" type="button" data-remove-edge="${i}" aria-label="删除连接 ${i + 1}">×</button></div>`,
        )
        .join("");
      for (const key of ["source", "target", "branch"])
        o.querySelectorAll(`[data-edge-${key}]`).forEach(
          (select) =>
            (select.onchange = safe(() => {
              saveProps();
              definition.edges[
                Number(
                  select.dataset["edge" + key[0].toUpperCase() + key.slice(1)],
                )
              ][key] = select.value;
              if (!select.value)
                delete definition.edges[Number(select.dataset.edgeBranch)]
                  .branch;
              draw();
            })),
        );
      o.querySelectorAll("[data-remove-edge]").forEach(
        (b) =>
          (b.onclick = safe(() => {
            saveProps();
            definition.edges.splice(Number(b.dataset.removeEdge), 1);
            draw();
          })),
      );
    }
    o.querySelectorAll("[data-add-node]").forEach(
      (b) =>
        (b.onclick = safe(() => {
          saveProps();
          if (definition.nodes.length >= 50) throw Error("最多 50 个节点");
          const type = b.dataset.addNode,
            id = type + "_" + Math.random().toString(36).slice(2, 7);
          definition.nodes.push({
            id,
            type,
            name: labels[type],
            config: nodeDefaults(type),
          });
          selected = id;
          draw();
        })),
    );
    o.querySelector("#add-edge").onclick = safe(() => {
      saveProps();
      definition.edges.push({
        source: definition.nodes[0].id,
        target: definition.nodes.at(-1).id,
      });
      draw();
    });
    function finishConnection(target) {
      const source = connecting;
      connecting = null;
      o.querySelector("#flow-hint").textContent = "";
      try {
        saveProps();
        connectNodes(
          definition,
          source,
          target,
          o.querySelector("#flow-branch").value,
        );
        draw();
      } catch (error) {
        toast(error.message);
      }
    }
    function restore(value) {
      if (!value) return;
      definition = value;
      if (!definition.nodes.some((n) => n.id === selected))
        selected = definition.nodes[0]?.id;
      draw();
    }
    o.querySelector("#flow-undo").onclick = safe(() => {
      saveProps();
      history.record(definition);
      restore(history.undo());
    });
    o.querySelector("#flow-redo").onclick = () => restore(history.redo());
    o.querySelector("#flow-copy").onclick = safe(() => {
      saveProps();
      const node = definition.nodes.find((n) => n.id === selected);
      if (node?.type === "start") throw Error("开始节点不能复制");
      clipboard = structuredClone(node);
      draw();
      toast("节点已复制到当前编辑器");
    });
    o.querySelector("#flow-paste").onclick = safe(() => {
      if (!clipboard) return;
      saveProps();
      const copy = structuredClone(clipboard);
      const temp = { nodes: [copy], edges: [] };
      duplicateNode(temp, copy.id);
      if (definition.nodes.length >= 50) throw Error("最多 50 个节点");
      definition.nodes.push(temp.nodes[1]);
      selected = temp.nodes[1].id;
      draw();
    });
    o.querySelector("#flow-layout").onclick = safe(() => {
      saveProps();
      layoutFlow(definition, true);
      draw();
    });
    o.querySelector("#flow-export").onclick = safe(() => {
      saveProps();
      const data = {
        name: o.querySelector("#workflow-name").value,
        description: o.querySelector("#workflow-description").value,
        config: { ...item.config, definition },
        expectedRevision: item.revision,
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "workflow-draft.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const canvas = o.querySelector("#flow-canvas");
    let gesture = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const select = e.target.closest("[data-select-node]"),
        port = e.target.closest("[data-port]");
      if (!select && !port) return;
      try {
        saveProps();
      } catch (error) {
        toast(error.message);
        return;
      }
      const id = (port || select).dataset[port ? "port" : "selectNode"];
      const node = definition.nodes.find((n) => n.id === id);
      gesture = {
        id,
        port: !!port,
        startX: e.clientX,
        startY: e.clientY,
        position: { ...node.position },
        moved: false,
      };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!gesture) return;
      const dx = e.clientX - gesture.startX,
        dy = e.clientY - gesture.startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) gesture.moved = true;
      if (gesture.moved && !canvas.hasPointerCapture(e.pointerId))
        canvas.setPointerCapture(e.pointerId);
      if (!gesture.moved) return;
      if (gesture.port) {
        const svg = o.querySelector(".flow-lines"),
          node = definition.nodes.find((n) => n.id === gesture.id),
          rect = canvas.getBoundingClientRect();
        let path = svg.querySelector("[data-preview]");
        if (!path) {
          path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.dataset.preview = "true";
          path.setAttribute("fill", "none");
          path.setAttribute("stroke-dasharray", "5 4");
          svg.append(path);
        }
        const x = e.clientX - rect.left + canvas.scrollLeft,
          y = e.clientY - rect.top + canvas.scrollTop;
        path.setAttribute(
          "d",
          `M${node.position.x + 180},${node.position.y + 37} L${x},${y}`,
        );
        return;
      }
      const node = definition.nodes.find((n) => n.id === gesture.id);
      node.position = {
        x: Math.max(12, Math.min(10000, gesture.position.x + dx)),
        y: Math.max(12, Math.min(10000, gesture.position.y + dy)),
      };
      const el = o.querySelector(`[data-node="${gesture.id}"]`);
      el.style.left = node.position.x + "px";
      el.style.top = node.position.y + "px";
      const plane = el.parentElement;
      plane.style.width =
        Math.max(parseFloat(plane.style.width), node.position.x + 220) + "px";
      plane.style.height =
        Math.max(parseFloat(plane.style.height), node.position.y + 120) + "px";
      const svg = o.querySelector(".flow-lines");
      svg.setAttribute("width", plane.style.width.replace("px", ""));
      svg.setAttribute("height", plane.style.height.replace("px", ""));
      const positions = new Map(
        definition.nodes.map((n) => [n.id, n.position]),
      );
      definition.edges
        .filter(
          (edge) => positions.has(edge.source) && positions.has(edge.target),
        )
        .forEach((edge, i) => {
          const a = positions.get(edge.source),
            b = positions.get(edge.target);
          svg
            .querySelectorAll("path")
            [i]?.setAttribute(
              "d",
              `M${a.x + 180},${a.y + 37} C${a.x + 210},${a.y + 37} ${b.x - 30},${b.y + 37} ${b.x},${b.y + 37}`,
            );
          const text = svg.querySelectorAll("text")[i];
          if (text) {
            text.setAttribute("x", (a.x + b.x + 180) / 2);
            text.setAttribute("y", (a.y + b.y) / 2 + 29);
          }
        });
      o.querySelector("#flow-hint").textContent = "释放保存位置";
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!gesture) return;
      const g = gesture;
      o.querySelector("[data-preview]")?.remove();
      gesture = null;
      if (!g.moved) return;
      suppressClick = Date.now() + 150;
      if (g.port) {
        connecting = g.id;
        const target = document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest("[data-node]");
        if (target) finishConnection(target.dataset.node);
        else
          o.querySelector("#flow-hint").textContent =
            "请选择目标节点；Esc 取消连线";
      } else {
        selected = g.id;
        draw();
        o.querySelector("#flow-hint").textContent = "节点位置已更新";
      }
    });
    canvas.addEventListener("pointercancel", () => {
      if (gesture && !gesture.port) {
        definition.nodes.find((n) => n.id === gesture.id).position =
          gesture.position;
      }
      gesture = null;
      draw();
    });
    o.addEventListener(
      "keydown",
      (e) => {
        const editing = e.target.matches("input,textarea,select");
        if (e.key === "Escape" && connecting) {
          connecting = null;
          o.querySelector("#flow-hint").textContent = "";
          e.stopPropagation();
          return;
        }
        if (editing) return;
        if (
          (e.ctrlKey || e.metaKey) &&
          ["z", "y", "c", "v"].includes(e.key.toLowerCase())
        ) {
          e.preventDefault();
          const key = e.key.toLowerCase();
          o.querySelector(
            key === "z"
              ? e.shiftKey
                ? "#flow-redo"
                : "#flow-undo"
              : key === "y"
                ? "#flow-redo"
                : key === "c"
                  ? "#flow-copy"
                  : "#flow-paste",
          ).click();
          return;
        }
        const button = e.target.closest("[data-select-node]");
        if (
          button &&
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
        ) {
          e.preventDefault();
          const node = definition.nodes.find(
              (n) => n.id === button.dataset.selectNode,
            ),
            step = e.shiftKey ? 50 : 10;
          selected = node.id;
          node.position.x +=
            e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
          node.position.y +=
            e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
          draw();
          o.querySelector(`[data-select-node="${node.id}"]`).focus();
        }
      },
      true,
    );
    draw();
  }
  async function versionDialog(item) {
    const [current, versions] = await Promise.all([
      api("/workflows/" + item.id + "/editor"),
      api("/workflows/" + item.id + "/versions"),
    ]);
    const o = modal(
      "版本发布 · " + item.name,
      `<p class="small">草稿修订 ${current.revision} · 当前发布 ${current.publishedVersion ? "v" + current.publishedVersion : "暂无"}。发布会保存不可修改的流程快照；恢复历史版本只覆盖草稿。</p><div class="field"><label for="publish-note">发布说明</label><input id="publish-note" maxlength="1000" placeholder="本次更新了什么"></div><button type="button" id="publish-workflow" class="primary">发布当前草稿</button><div class="version-list">${versions.length ? versions.map((v) => `<article><div><strong>v${v.version}${v.version === current.publishedVersion ? " · 当前发布" : ""}</strong><p>${E(v.note || "无发布说明")}</p><span class="small">${E(v.actorName || "已移除成员")} · ${new Date(v.created).toLocaleString("zh-CN")}</span></div><button type="button" data-restore="${v.version}">恢复到草稿</button></article>`).join("") : '<p class="small">还没有发布版本。</p>'}</div>`,
      "关闭",
    );
    o.querySelector("#publish-workflow").onclick = safe(async (e) => {
      e.target.disabled = true;
      try {
        const r = await post("/workflows/" + item.id + "/publish", {
          expectedRevision: current.revision,
          note: o.querySelector("#publish-note").value,
        });
        toast("已发布 v" + r.version);
        o.querySelector("[data-close]").click();
        await render("workflow");
      } finally {
        if (e.target.isConnected) e.target.disabled = false;
      }
    });
    o.querySelectorAll("[data-restore]").forEach(
      (b) =>
        (b.onclick = () =>
          modal(
            "恢复历史版本",
            `<p>将 v${Number(b.dataset.restore)} 恢复到草稿。当前发布版本保持不变，未保存的编辑内容不在此操作范围内。</p>`,
            "恢复草稿",
            async () => {
              await post("/workflows/" + item.id + "/restore", {
                expectedRevision: current.revision,
                version: Number(b.dataset.restore),
              });
              toast("已恢复到草稿");
              o.querySelector("[data-close]").click();
              await render("workflow");
            },
          )),
    );
  }
  function renderSteps(result) {
    return `<div class="run-summary">${result.version ? `<span class="badge neutral">发布 v${result.version}</span>` : Number.isInteger(result.revision) ? `<span class="badge neutral">草稿修订 ${result.revision}</span>` : ""}<span class="badge ${result.status === "succeeded" ? "success" : "neutral"}">${{ succeeded: "运行成功", failed: "运行失败", cancelled: "已取消", running: "运行中" }[result.status] || result.status}</span>${result.error ? `<span class="error">${E(result.error)}</span>` : ""}</div><div class="run-steps">${(result.steps || []).map((s) => `<div class="run-step"><span class="step-status ${s.status}">${s.status === "succeeded" ? "✓" : s.status === "failed" ? "!" : s.status === "skipped" ? "−" : "◌"}</span><div><strong>${E(s.name || s.nodeId)}</strong><span class="small"> · ${s.durationMs || 0} ms${s.attempt ? " · 尝试 " + s.attempt + " 次" : ""}</span>${s.error ? `<p class="error">${E(s.error)}</p>` : ""}</div></div>`).join("")}</div>${result.output !== null && result.output !== undefined ? `<label>输出结果</label><pre class="code run-output">${E(typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2))}</pre>` : ""}`;
  }
  async function runDialog(item) {
    const versions = await api("/workflows/" + item.id + "/versions");
    const o = modal(
      "调试运行 · " + item.name,
      `<div class="field"><label for="run-version">运行版本</label><select id="run-version"><option value="">当前草稿</option>${versions.map((v) => `<option value="${v.version}">已发布 v${v.version} · ${E(v.note || "无说明")}</option>`).join("")}</select></div><div class="field"><label for="run-input">输入内容</label><textarea id="run-input" placeholder="输入需要处理的问题" required></textarea></div><button id="start-run" class="primary" type="button">▷ 运行工作流</button><div id="run-result" class="run-result"></div>`,
      "关闭",
    );
    o.querySelector("#start-run").onclick = safe(async (e) => {
      const input = o.querySelector("#run-input").value;
      if (!input.trim()) throw Error("请输入运行内容");
      e.target.disabled = true;
      o.querySelector("#run-result").innerHTML =
        '<p class="small">正在执行节点…</p>';
      try {
        const version = o.querySelector("#run-version").value;
        const result = await post("/workflows/" + item.id + "/run", {
          input,
          ...(version ? { version: Number(version) } : {}),
        });
        o.querySelector("#run-result").innerHTML = renderSteps(result);
      } finally {
        e.target.disabled = false;
      }
    });
  }
  async function runHistory(item) {
    try {
      const rows = await api("/workflows/" + item.id + "/runs");
      const o = modal(
        "运行记录 · " + item.name,
        rows.length
          ? rows
              .map(
                (r) =>
                  `<button type="button" class="history-row" data-run-detail="${r.id}"><span>${E(r.input.slice(0, 60))}</span><span class="badge ${r.status === "succeeded" ? "success" : "neutral"}">${E(r.status)}</span><time class="small">${new Date(r.created).toLocaleString("zh-CN")}</time></button>`,
              )
              .join("")
          : noData("还没有运行记录", "运行一次工作流后，在这里查看执行结果。"),
        "关闭",
      );
      o.querySelectorAll("[data-run-detail]").forEach(
        (b) =>
          (b.onclick = safe(async () => {
            const r = await api("/runs/" + b.dataset.runDetail);
            modal(
              "运行详情",
              renderSteps({
                ...r.result,
                version: r.version,
                revision: r.revision,
              }),
              "关闭",
            );
          })),
      );
    } catch (e) {
      toast(e.message);
    }
  }
  function toolPage(rows) {
    document.querySelector("#view").innerHTML =
      `<div class="content feature-content">${heading("工具集成", "连接 MCP 服务或 OpenAPI 接口，为客服拓展业务能力。", '<button class="primary" id="new-tool">＋ 添加工具</button>')}<div class="toolbar"><span class="small">${rows.length} 个工具服务</span><span class="small">支持工具发现、参数表单与调用测试</span></div><div class="grid">${rows.map((r) => `<article class="card tool-card"><div class="row"><div class="feature-icon blue">⊞</div><span class="badge neutral">${r.config.type === "openapi" ? "OpenAPI" : "MCP · HTTP"}</span><button class="quiet danger" data-delete="${r.id}" style="margin-left:auto" aria-label="删除 ${E(r.name)}">×</button></div><h3>${E(r.name)}</h3><p>${E(r.description || "暂无说明")}</p><div class="small endpoint">${E(r.config.endpoint || "尚未设置地址")}</div><div class="card-actions"><button data-edit-tool="${r.id}">配置</button><button class="primary" data-discover="${r.id}">连接并发现工具</button></div></article>`).join("")}</div>${rows.length ? "" : noData("连接第一个工具服务", "添加服务地址，发现业务工具并测试调用。")}</div>`;
    document.querySelector("#new-tool").onclick = () => toolDialog();
    document
      .querySelectorAll("[data-edit-tool]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            toolDialog(rows.find((r) => r.id === b.dataset.editTool))),
      );
    document.querySelectorAll("[data-discover]").forEach(
      (b) =>
        (b.onclick = safe(async () => {
          b.disabled = true;
          try {
            const result = await post(
              "/tools/" + b.dataset.discover + "/discover",
              {},
            );
            toolCatalog(
              rows.find((r) => r.id === b.dataset.discover),
              result,
            );
          } finally {
            b.disabled = false;
          }
        })),
    );
    document.querySelectorAll("[data-delete]").forEach(
      (b) =>
        (b.onclick = () =>
          removeDialog(
            rows.find((r) => r.id === b.dataset.delete),
            () => render("tool"),
          )),
    );
  }
  function toolDialog(item) {
    const o = modal(
      item ? "配置工具服务" : "添加工具服务",
      `${textField("name", "名称", item?.name || "")}${textField("description", "说明", item?.description || "", "用于哪些业务操作", false)}<div class="field"><label for="tool-type">协议</label><select id="tool-type" name="type"><option value="mcp" ${item?.config.type !== "openapi" ? "selected" : ""}>MCP · Streamable HTTP</option><option value="openapi" ${item?.config.type === "openapi" ? "selected" : ""}>OpenAPI 3.x</option></select></div>${textField("endpoint", "服务地址", item?.config.endpoint || "", "https://service.example/mcp")}${textField("tokenEnv", "凭据环境变量（选填）", item?.config.tokenEnv || "", "FC_SECRET_SERVICE_TOKEN", false)}<div class="field" id="schema-field"><label for="openapi-spec">OpenAPI JSON / YAML 文档</label><textarea id="openapi-spec" name="spec" class="code-input" spellcheck="false">${E(JSON.stringify(item?.config.spec || { openapi: "3.0.3", paths: {} }, null, 2))}</textarea></div>`,
      "保存",
      async (b) => {
        const config = {
          type: b.type,
          endpoint: b.endpoint,
          tokenEnv: b.tokenEnv,
        };
        new URL(config.endpoint);
        if (b.type === "openapi") {
          config.spec = b.spec;
        }
        await api(item ? "/resources/" + item.id : "/resources", {
          method: item ? "PATCH" : "POST",
          body: JSON.stringify({
            kind: "tool",
            name: b.name,
            description: b.description,
            config,
          }),
        });
        toast("工具服务已保存");
        render("tool");
      },
    );
    const toggle = () =>
      (o.querySelector("#schema-field").hidden =
        o.querySelector("#tool-type").value !== "openapi");
    o.querySelector("#tool-type").onchange = toggle;
    toggle();
  }
  function schemaFields(schema) {
    return Object.entries(schema.properties || {})
      .map(([name, s]) => {
        const required = (schema.required || []).includes(name),
          id = "arg-" + name;
        if (s.type === "boolean")
          return `<div class="field"><label for="${E(id)}">${E(s.title || name)}</label><select id="${E(id)}" data-argument="${E(name)}"><option value="">未设置</option><option value="true">true</option><option value="false">false</option></select></div>`;
        if (s.enum)
          return `<div class="field"><label for="${E(id)}">${E(s.title || name)}${required ? " *" : ""}</label><select id="${E(id)}" data-argument="${E(name)}"><option value="">请选择</option>${s.enum.map((v) => `<option value="${E(v)}">${E(v)}</option>`).join("")}</select></div>`;
        return `<div class="field"><label for="${E(id)}">${E(s.title || name)}${required ? " *" : ""}</label>${["object", "array"].includes(s.type) ? `<textarea id="${E(id)}" data-argument="${E(name)}" placeholder="JSON"></textarea>` : `<input id="${E(id)}" data-argument="${E(name)}" type="${["integer", "number"].includes(s.type) ? "number" : "text"}" ${s.type === "integer" ? 'step="1"' : ""}>`}<div class="small">${E(s.description || "")}</div></div>`;
      })
      .join("");
  }
  function toolCatalog(item, result) {
    const o = modal(
      item.name + " · 工具列表",
      result.tools.length
        ? `<div class="tool-catalog">${result.tools.map((t, i) => `<button type="button" class="tool-operation" data-operation="${i}"><strong>${E(t.name)}</strong><span class="small">${E(t.description || "暂无说明")}</span><span class="badge">测试调用 →</span></button>`).join("")}</div>`
        : noData("没有发现工具", "检查服务是否已发布工具或接口。"),
      "关闭",
    );
    o.querySelectorAll("[data-operation]").forEach(
      (b) =>
        (b.onclick = () => {
          const t = result.tools[Number(b.dataset.operation)],
            dialog = modal(
              "调用工具 · " + t.name,
              `<p class="small">${E(t.description || "")}</p>${schemaFields(t.inputSchema || {})}<button class="primary" type="button" id="execute-tool">执行调用</button><div id="tool-result" class="run-result" role="status"></div>`,
              "关闭",
            );
          dialog.querySelector("#execute-tool").onclick = safe(async (e) => {
            const args = {};
            for (const input of dialog.querySelectorAll("[data-argument]")) {
              if (!input.value) continue;
              const name = input.dataset.argument,
                schema = t.inputSchema.properties[name];
              try {
                args[name] = [
                  "object",
                  "array",
                  "boolean",
                  "number",
                  "integer",
                ].includes(schema.type)
                  ? JSON.parse(input.value)
                  : input.value;
              } catch {
                throw Error(name + " 格式无效");
              }
            }
            e.target.disabled = true;
            try {
              const output = await post("/tools/" + item.id + "/call", {
                name: t.name,
                arguments: args,
              });
              dialog.querySelector("#tool-result").innerHTML =
                `<span class="badge success">执行成功</span><pre class="code run-output">${E(JSON.stringify(output, null, 2))}</pre>`;
            } catch (err) {
              dialog.querySelector("#tool-result").innerHTML =
                `<p class="error">${E(err.message)}</p>`;
            } finally {
              e.target.disabled = false;
            }
          });
        }),
    );
  }
  return { render };
}
