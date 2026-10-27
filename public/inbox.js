import { receiptMarkup } from "./message-status.js";
import { nextConversation } from "./inbox-selection.js";
import { bindComposer } from "./chat-controls.js";
import { renderMessage, bindMessageActions } from "./message-renderer.js";
import { createOutbox, outboxHTML, bindOutbox } from "./outbox.js";
import { createMediaUI } from "./media.js";
export function createInboxUI({
  api,
  E,
  modal,
  toast,
  getMe,
  isActive,
  drafts,
  aiDebug,
  navigate,
}) {
  const media = createMediaUI({ E, modal });
  const uploadIds = new Map();
  const priorityNames = {
      low: "低",
      normal: "普通",
      high: "高",
      urgent: "紧急",
    },
    statusNames = { open: "待处理", pending: "跟进中", closed: "已结束" };
  const state = {
    active: null,
    filter: {
      status: "open",
      assignee: "all",
      priority: "all",
      unread: false,
      q: "",
    },
    offset: 0,
    items: [],
    total: 0,
    counts: {},
    members: [],
    selected: new Set(),
    detail: null,
    threadKey: "",
    headerKey: "",
    notesDirty: false,
    revision: 0,
    mounted: false,
    userId: null,
  };
  const noteDrafts = new Map();
  const internal = new Map(),
    requestIds = new Map(),
    sending = new Set();
  const uploading = new Set();
  let queryTimer,
    outbox,
    pending = [];
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (err) {
      toast(err.message);
    }
  };
  const options = (rows, value, blank = "未分配") =>
    `<option value="">${blank}</option>` +
    rows
      .filter((r) => r.active || r.id === value)
      .map(
        (r) =>
          `<option value="${r.id}" ${r.id === value ? "selected" : ""} ${r.active ? "" : "disabled"}>${E(r.name)}${!r.active ? "（已停用）" : r.workload ? " · " + r.workload + " 待处理" : ""}</option>`,
      )
      .join("");
  function params(paged = true) {
    const f = state.filter,
      p = new URLSearchParams();
    for (const [key, v] of Object.entries(f))
      if (v && v !== "all") p.set(key, key === "unread" ? "1" : v);
    if (paged) {
      p.set("paged", "1");
      p.set("limit", "40");
      p.set("offset", String(state.offset));
    }
    return p;
  }
  function saveFilters() {
    const { q, ...filters } = state.filter;
    try {
      localStorage.setItem("fc_inbox_" + getMe().id, JSON.stringify(filters));
    } catch {}
  }
  function ensureIdentity() {
    const me = getMe();
    if (state.userId !== me.id || state.userRole !== me.role) {
      outbox?.close();
      const ownerId = me.id;
      outbox = createOutbox({
        owner: "staff:" + ownerId,
        canSend: () => getMe()?.id === ownerId,
        send: async (r) => {
          let response;
          if (r.file) {
            response = await fetch(
              "/api/conversations/" + r.conversationId + "/attachments",
              {
                method: "POST",
                headers: {
                  "X-Expected-User": ownerId,
                  "X-Filename": encodeURIComponent(r.filename),
                  "X-Internal-Note": r.internal ? "1" : "0",
                  "X-Client-Id": r.id,
                },
                body: r.file,
              },
            );
          } else {
            response = await fetch(
              "/api/conversations/" + r.conversationId + "/messages",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Expected-User": ownerId,
                },
                body: JSON.stringify({
                  body: r.body,
                  internal: r.internal,
                  clientId: r.id,
                }),
              },
            );
          }
          if (!response.ok) {
            const d = await response.json();
            throw Object.assign(Error(d.error), { status: response.status });
          }
          refresh();
        },
        onChange: (rows) => {
          pending = rows;
          paintPending();
        },
      });
      state.userId = me.id;
      state.userRole = me.role;
      drafts.clear();
      media.clear();
      uploadIds.clear();
      state.filter = {
        status: "open",
        assignee: "all",
        priority: "all",
        unread: false,
        q: "",
      };
      state.offset = 0;
      noteDrafts.clear();
      internal.clear();
      requestIds.clear();
      sending.clear();
      uploading.clear();
      state.active = null;
      state.selected.clear();
      try {
        const f = JSON.parse(localStorage.getItem("fc_inbox_" + me.id) || "{}");
        for (const key of ["status", "assignee", "priority", "unread"])
          if (Object.hasOwn(f, key)) state.filter[key] = f[key];
      } catch {}
    }
  }
  let mountRevision = 0;
  async function mount() {
    const mountId = ++mountRevision;
    ensureIdentity();
    const members = await api("/members");
    if (!isActive() || mountId !== mountRevision) return;
    state.members = members;
    document.querySelector("#view").innerHTML =
      `<div class="inbox inbox-v3 ${state.active ? "has-chat" : ""}"><section class="conversation-list"><div class="list-head"><div class="panel-head inbox-list-heading"><h2>会话收件箱 <span class="small" id="queue-total"></span></h2><button class="quiet" id="export-conversations" aria-label="导出当前会话筛选" title="导出 CSV">↧</button></div><input id="conversation-search" placeholder="搜索访客、主题或历史消息…" aria-label="搜索会话" value="${E(state.filter.q)}"><div class="queue-scopes"><button data-scope="mine" class="${state.filter.assignee === "mine" ? "active" : ""}">我负责</button><button data-scope="unassigned" class="${state.filter.assignee === "unassigned" ? "active" : ""}">未分配</button><button data-scope="all" class="${state.filter.assignee === "all" ? "active" : ""}">全部</button></div><div class="tabs inbox-status-tabs">${[
        ["open", "待处理"],
        ["pending", "跟进中"],
        ["closed", "已结束"],
        ["all", "全部"],
      ]
        .map(
          ([key, name]) =>
            `<button data-status="${key}" class="${state.filter.status === key ? "active" : ""}">${name}<span data-status-count="${key}">0</span></button>`,
        )
        .join(
          "",
        )}</div><details class="inbox-filters"><summary>更多筛选 <span id="active-filter-count"></span></summary><div class="field"><label for="owner-filter">客服</label><select id="owner-filter"><option value="all">全部可见客服</option><option value="mine">我负责</option><option value="unassigned">未分配</option>${members
        .filter((m) => m.active)
        .map((m) => `<option value="${m.id}">${E(m.name)}</option>`)
        .join(
          "",
        )}</select></div><div class="filter-pair"><div class="field"><label for="priority-filter">优先级</label><select id="priority-filter"><option value="all">全部优先级</option>${Object.entries(
        priorityNames,
      )
        .map(
          ([key, name]) =>
            `<option value="${key}" ${state.filter.priority === key ? "selected" : ""}>${name}</option>`,
        )
        .join(
          "",
        )}</select></div></div><div class="row"><label class="small row"><input class="switch" type="checkbox" id="unread-filter" ${state.filter.unread ? "checked" : ""}>仅未读</label><button class="quiet small" id="reset-filters">重置筛选</button></div></details></div><div class="selection-toolbar"><label class="small row"><input type="checkbox" class="switch" id="select-page" aria-label="全选当前页">当前页</label><span class="small" id="selected-count">未选择</span><button id="bulk-manage" class="quiet small" disabled>批量处理</button></div><div id="conversations"></div><div class="queue-pagination"><button id="prev-page" aria-label="上一页">←</button><span id="page-info" class="small"></span><button id="next-page" aria-label="下一页">→</button></div></section><section class="chat" id="chat"></section><aside class="visitor-panel" id="visitor-panel"></aside></div>`;
    document.querySelector("#owner-filter").value = state.filter.assignee;
    document
      .querySelectorAll("[data-scope]")
      .forEach(
        (b) => (b.onclick = () => setFilter("assignee", b.dataset.scope)),
      );
    document
      .querySelectorAll("[data-status]")
      .forEach(
        (b) => (b.onclick = () => setFilter("status", b.dataset.status)),
      );
    for (const [id, key] of [
      ["owner-filter", "assignee"],
      ["priority-filter", "priority"],
    ])
      document.getElementById(id).onchange = (e) =>
        setFilter(key, e.target.value);
    document.querySelector("#unread-filter").onchange = (e) =>
      setFilter("unread", e.target.checked);
    document.querySelector("#conversation-search").oninput = (e) => {
      state.filter.q = e.target.value;
      clearTimeout(queryTimer);
      queryTimer = setTimeout(() => {
        state.offset = 0;
        state.selected.clear();
        refresh();
      }, 220);
    };
    document.querySelector("#reset-filters").onclick = () => {
      state.filter = {
        status: "open",
        assignee: "all",
        priority: "all",
        unread: false,
        q: "",
      };
      state.offset = 0;
      state.selected.clear();
      saveFilters();
      mount();
    };
    document.querySelector("#select-page").onchange = (e) => {
      state.selected.clear();
      if (e.target.checked)
        state.items.forEach((c) => state.selected.add(c.id));
      drawList();
    };
    document.querySelector("#bulk-manage").onclick = bulkDialog;
    document.querySelector("#prev-page").onclick = () => {
      state.offset = Math.max(0, state.offset - 40);
      state.selected.clear();
      refresh();
    };
    document.querySelector("#next-page").onclick = () => {
      state.offset += 40;
      state.selected.clear();
      refresh();
    };
    document.querySelector("#export-conversations").onclick = safe(
      async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try {
          const r = await api("/conversations/export?" + params(false));
          const url = URL.createObjectURL(
              new Blob([r.content], { type: "text/csv;charset=utf-8" }),
            ),
            link = document.createElement("a");
          link.href = url;
          link.download = r.filename;
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          toast(
            r.truncated
              ? "已导出前 10,000 条，共 " + r.total + " 条"
              : "已导出 " + r.total + " 条会话",
          );
        } finally {
          button.disabled = false;
        }
      },
    );
    state.detail = null;
    state.threadKey = "";
    state.headerKey = "";
    showEmpty();
    await refresh();
  }
  function setFilter(key, value) {
    state.filter[key] = value;
    state.offset = 0;
    state.selected.clear();
    saveFilters();
    document.querySelector("#owner-filter").value = state.filter.assignee;
    document
      .querySelectorAll("[data-scope]")
      .forEach((b) =>
        b.classList.toggle("active", b.dataset.scope === state.filter.assignee),
      );
    document
      .querySelectorAll("[data-status]")
      .forEach((b) =>
        b.classList.toggle("active", b.dataset.status === state.filter.status),
      );
    refresh();
  }
  function showEmpty() {
    if (state.active) return;
    document.querySelector(".inbox")?.classList.remove("has-chat");
    document.querySelector("#chat").innerHTML =
      '<div class="empty"><div class="empty-symbol">▤</div><strong>选择一段对话</strong><p>集中处理客户咨询，让协作更有条理。</p></div>';
    document.querySelector("#visitor-panel").innerHTML =
      '<h2>访客资料</h2><p class="small">选择会话查看客户与处理信息。</p>';
  }
  async function refresh() {
    if (!isActive() || !document.querySelector("#conversations")) return;
    const revision = ++state.revision;
    try {
      const [list, members] = await Promise.all([
        api("/conversations?" + params()),
        api("/members"),
      ]);
      if (!isActive() || revision !== state.revision) return;
      state.members = members;
      const own = members.find((member) => member.id === getMe().id);
      if (own) {
        getMe().availability = own.availability;
        const select = document.querySelector("#own-availability");
        if (select) select.value = own.availability;
      }
      state.items = list.items;
      state.total = list.total;
      state.counts = list.counts;
      for (const id of state.selected)
        if (!state.items.some((c) => c.id === id)) state.selected.delete(id);
      if (state.offset >= list.total && state.offset > 0) {
        state.offset = Math.max(0, state.offset - 40);
        return refresh();
      }
      drawList();
      if (state.active) await loadDetail(revision);
    } catch (err) {
      toast(err.message);
    }
  }
  function drawList() {
    if (!isActive() || !document.querySelector("#conversations")) return;
    document.querySelector("#queue-total").textContent = state.total;
    document
      .querySelectorAll("[data-status-count]")
      .forEach(
        (s) => (s.textContent = state.counts[s.dataset.statusCount] || 0),
      );
    document.querySelector("#active-filter-count").textContent =
      [state.filter.priority !== "all", state.filter.unread].filter(Boolean)
        .length || "";
    document.querySelector("#conversations").innerHTML = state.items.length
      ? state.items
          .map(
            (c) =>
              `<div class="conversation-row ${state.active === c.id ? "active" : ""} ${state.selected.has(c.id) ? "selected" : ""}"><input type="checkbox" class="conversation-select" data-select="${c.id}" aria-label="选择 ${E(c.name)} 的会话" ${state.selected.has(c.id) ? "checked" : ""}><button class="conversation" data-conversation="${c.id}"><span class="avatar">${E(c.name[0])}</span><span class="conversation-summary"><span class="conversation-title"><strong>${E(c.name)}</strong><time>${new Date(c.updated).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></span><span class="preview">${E(c.preview || c.subject)}</span><span class="conversation-meta"><span>${E(c.assigneeName || (c.automation_mode === "ai" ? "AI 助手" : "未分配"))}</span>${["high", "urgent"].includes(c.priority) ? `<span class="priority-pill ${c.priority}">${priorityNames[c.priority]}</span>` : ""}${c.unreadCount ? `<span class="unread-count">${c.unreadCount}</span>` : ""}</span></span></button></div>`,
          )
          .join("")
      : '<div class="empty"><strong>暂无匹配会话</strong><p>可以调整筛选条件或等待新的客户咨询。</p></div>';
    document
      .querySelectorAll("[data-conversation]")
      .forEach((b) => (b.onclick = () => select(b.dataset.conversation)));
    document.querySelectorAll("[data-select]").forEach(
      (check) =>
        (check.onchange = () => {
          if (check.checked) state.selected.add(check.dataset.select);
          else state.selected.delete(check.dataset.select);
          updateSelection();
        }),
    );
    updateSelection();
    document.querySelector("#prev-page").disabled = state.offset === 0;
    document.querySelector("#next-page").disabled =
      state.offset + 40 >= state.total;
    document.querySelector("#page-info").textContent = state.total
      ? `${state.offset + 1}–${Math.min(state.offset + 40, state.total)} / ${state.total}`
      : "0 条会话";
  }
  function updateSelection() {
    document.querySelector("#selected-count").textContent = state.selected.size
      ? "已选 " + state.selected.size + " 项"
      : "未选择";
    document.querySelector("#bulk-manage").disabled = !state.selected.size;
    const all = document.querySelector("#select-page");
    all.checked =
      !!state.items.length &&
      state.items.every((c) => state.selected.has(c.id));
    all.indeterminate = !!state.selected.size && !all.checked;
    document
      .querySelectorAll(".conversation-row")
      .forEach((row) =>
        row.classList.toggle(
          "selected",
          row.querySelector("[data-select]").checked,
        ),
      );
  }
  async function select(id) {
    state.active = id;
    state.detail = null;
    state.threadKey = "";
    state.headerKey = "";
    state.notesDirty = false;
    document.querySelector(".inbox").classList.add("has-chat");
    await refresh();
  }
  function bulkDialog() {
    const selected = state.items.filter((c) => state.selected.has(c.id)),
      versions = Object.fromEntries(selected.map((c) => [c.id, c.revision]));
    const o = modal(
      "批量处理 " + selected.length + " 个会话",
      `<div class="field"><label for="bulk-status">状态</label><select id="bulk-status" name="status"><option value="keep">保持不变</option>${Object.entries(
        statusNames,
      )
        .map(([k, v]) => `<option value="${k}">${v}</option>`)
        .join(
          "",
        )}</select></div><div class="field"><label for="bulk-assignee">分配给</label><select id="bulk-assignee" name="assignee"><option value="keep">保持不变</option>${options(state.members, "")}</select></div><div class="field"><label for="bulk-priority">优先级</label><select id="bulk-priority" name="priority"><option value="keep">保持不变</option>${Object.entries(
        priorityNames,
      )
        .map(([k, v]) => `<option value="${k}">${v}</option>`)
        .join("")}</select></div>`,
      "应用更改",
      async (b) => {
        const changes = {};
        for (const key of ["status", "assignee", "priority"])
          if (b[key] !== "keep") changes[key] = b[key];
        if (!Object.keys(changes).length) throw Error("请选择需要更改的项目");
        await api("/conversations/bulk", {
          method: "POST",
          body: JSON.stringify({
            ids: selected.map((c) => c.id),
            versions,
            changes,
          }),
        });
        const completed =
          changes.status === "closed" &&
          selected.some((c) => c.id === state.active);
        state.selected.clear();
        toast("已更新 " + selected.length + " 个会话");
        if (completed)
          return await advanceQueue(
            state.active,
            selected.map((c) => c.id),
          );
        await refresh();
      },
    );
  }
  async function advanceQueue(completedId, excluded = []) {
    state.active = nextConversation(state.items, completedId, excluded);
    state.detail = null;
    state.headerKey = state.threadKey = "";
    state.notesDirty = false;
    if (!state.active) showEmpty();
    await refresh();
    if (!isActive()) return;
    if (!state.active) {
      state.active = nextConversation(state.items, completedId, excluded);
      if (state.active) {
        document.querySelector(".inbox")?.classList.add("has-chat");
        await loadDetail(state.revision);
        drawList();
      }
    }
  }
  async function change(changes, expectedRevision, conversationId) {
    const c = state.detail?.conversation;
    if (!c || (conversationId && c.id !== conversationId))
      throw Error("当前会话已变化，请重新打开后操作");
    await api("/conversations/" + c.id, {
      method: "PATCH",
      body: JSON.stringify({
        ...changes,
        expectedRevision: expectedRevision ?? c.revision,
      }),
    });
    if (
      getMe().role !== "admin" &&
      changes.assignee &&
      changes.assignee !== getMe().id
    ) {
      state.active = null;
      state.detail = null;
      showEmpty();
      toast("会话已转交");
    }
    if (changes.status === "closed" && state.active === c.id)
      return await advanceQueue(c.id);
    await refresh();
  }
  async function loadDetail(revision) {
    const id = state.active;
    let data;
    try {
      data = await api("/conversations/" + id);
    } catch (err) {
      if (isActive() && state.active === id) {
        state.active = null;
        state.detail = null;
        showEmpty();
        toast(err.message);
      }
      return;
    }
    if (!isActive() || revision !== state.revision || state.active !== id)
      return;
    const previous = state.detail?.conversation;
    const initial = previous?.id !== id;
    if (
      !initial &&
      previous.status !== "closed" &&
      data.conversation.status === "closed"
    ) {
      await advanceQueue(id);
      return;
    }
    state.detail = data;
    const c = data.conversation;
    if (initial) {
      document.querySelector("#chat").innerHTML =
        `<div class="chat-head" id="chat-head"></div><div class="messages" id="messages"></div><div id="staff-outbox"></div><div id="automation-banner" class="automation-banner" hidden></div><form class="composer" id="reply-form"><input id="staff-file" type="file" hidden><textarea id="reply" name="body" placeholder="输入回复内容…" aria-label="回复消息" required maxlength="10000"></textarea><div class="composer-footer"><div class="row composer-actions"><label class="composer-mode"><input name="internal" type="checkbox" ${internal.get(id) ? "checked" : ""} aria-label="内部备注"><span class="mode-public">公开回复</span><span class="mode-note">内部备注</span></label><button type="button" class="quiet small" id="upload-attachment" aria-label="上传并发送附件">⌁ 附件</button><button type="button" class="quiet small" id="quick-replies">快捷回复</button><button type="button" class="quiet small" id="ai-draft">✧ AI 草稿</button></div><span class="small send-hint">Enter 发送 · Shift+Enter 换行</span><button class="primary" id="send-reply" type="submit">发送 ↗</button></div></form>`;
      document.querySelector("#upload-attachment").onclick = () =>
        document.querySelector("#staff-file").click();
      document.querySelector("#staff-file").onchange = safe(async (event) => {
        const file = event.target.files[0];
        if (!file || uploading.has(id)) return;
        if (!file.size || file.size > 8 * 1024 * 1024)
          throw Error("请选择不超过 8 MB 的非空文件");
        const note = document.querySelector("#reply-form").internal.checked;
        await outbox.enqueue({
          conversationId: id,
          file,
          filename: file.name,
          internal: note,
        });
        event.target.value = "";
      });
      const textarea = document.querySelector("#reply");
      textarea.value = drafts.get(id) || "";
      textarea.oninput = (e) => drafts.set(id, e.target.value);
      document.querySelector("#reply-form").internal.onchange = (e) => {
        internal.set(id, e.target.checked);
        document
          .querySelector("#reply-form")
          .classList.toggle("internal-mode", e.target.checked);
      };
      document
        .querySelector("#reply-form")
        .classList.toggle("internal-mode", !!internal.get(id));
      document.querySelector("#reply-form").onsubmit = safe(async (e) => {
        e.preventDefault();
        if (sending.has(id)) return;
        const form = e.currentTarget,
          text = form.body.value.trim(),
          note = form.internal.checked;
        if (!text) return;
        sending.add(id);
        try {
          await outbox.enqueue({
            conversationId: id,
            body: text,
            internal: note,
          });
          drafts.delete(id);
          if (state.active === id) {
            form.body.value = "";
            form.body.dispatchEvent(new Event("input", { bubbles: true }));
          }
        } finally {
          sending.delete(id);
        }
      });
      bindComposer(document.querySelector("#reply-form"));
      document.querySelector("#quick-replies").onclick = () => replyChooser(c);
      document.querySelector("#ai-draft").onclick = () => aiDebug(null, id);
      drawVisitor(c);
    }
    if (
      !initial &&
      JSON.stringify([previous.name, previous.email, previous.profile]) !==
        JSON.stringify([c.name, c.email, c.profile])
    )
      drawVisitor(c);
    const headerKey = JSON.stringify([
      c.subject,
      c.status,
      c.assignee,
      c.priority,
      state.members,
      c.name,
    ]);
    if (headerKey !== state.headerKey) {
      state.headerKey = headerKey;
      document.querySelector("#chat-head").innerHTML =
        `<div class="chat-heading"><button class="quiet chat-back" id="back-list" aria-label="返回会话列表">←</button><div><strong>${E(c.name)} <span class="badge neutral">${statusNames[c.status]}</span></strong><button class="quiet small" id="edit-subject" title="编辑主题">${E(c.subject)} ✎</button></div></div><div class="row chat-actions"><button class="quiet" id="show-visitor">访客资料</button><select id="chat-owner" aria-label="分配客服">${options(state.members, c.assignee)}</select><select id="chat-status" aria-label="会话状态">${Object.entries(
          statusNames,
        )
          .map(
            ([key, value]) =>
              `<option value="${key}" ${c.status === key ? "selected" : ""}>${value}</option>`,
          )
          .join(
            "",
          )}</select><button id="follow" class="${c.status === "closed" ? "" : "quiet"}">${c.status === "closed" ? "重新打开" : "结束会话"}</button></div>`;
      document.querySelector("#back-list").onclick = () => {
        state.active = null;
        state.detail = null;
        showEmpty();
        drawList();
      };
      document.querySelector("#edit-subject").onclick = () =>
        modal(
          "编辑会话主题",
          `<div class="field"><label for="conversation-subject">主题</label><input id="conversation-subject" name="subject" maxlength="200" value="${E(c.subject)}" required></div>`,
          "保存",
          (b) => change(b),
        );
      document.querySelector("#chat-owner").onchange = safe((e) =>
        change({ assignee: e.target.value }),
      );
      document.querySelector("#chat-status").onchange = safe((e) =>
        change({ status: e.target.value }),
      );
      document.querySelector("#follow").onclick = safe(() =>
        change({ status: c.status === "closed" ? "open" : "closed" }),
      );
      document.querySelector("#show-visitor").onclick = () =>
        visitorDialog(state.detail.conversation);
    }
    paintPending();
    const threadKey = JSON.stringify([data.messages, data.receipts]);
    if (threadKey !== state.threadKey) {
      const el = document.querySelector("#messages"),
        atBottom =
          !state.threadKey ||
          el.scrollHeight - el.scrollTop - el.clientHeight < 90;
      state.threadKey = threadKey;
      el.innerHTML = data.messages.length
        ? data.messages
            .map(
              (m) =>
                `<div class="message ${m.role}"><div class="bubble ${m.attachment ? "attachment-bubble" : ""}">${m.attachment ? media.render(m.attachment) : renderMessage(m.body, { plain: m.role === "visitor" || m.role === "note" })}</div><div class="small">${E(m.role === "visitor" ? c.name : m.role === "note" ? (m.senderName || "客服") + " · 内部备注" : m.source === "ai" ? "AI 助手" : m.source === "system" ? "系统" : m.senderName || "客服")} · ${new Date(m.created).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}${m.role === "agent" && m.source !== "system" ? " " + receiptMarkup(m.seq, data.receipts) : ""}</div></div>`,
            )
            .join("")
        : '<p class="small thread-welcome">对话已建立，等待访客消息。</p>';
      media.bind(el);
      bindMessageActions(el, (text) => {
        const input = document.querySelector("#reply");
        if (input) {
          input.value = text;
          input.focus();
        }
      });
      if (atBottom) el.scrollTop = el.scrollHeight;
    }
    acknowledgeThread(data);
    const automation = data.automation || {},
      banner = document.querySelector("#automation-banner");
    banner.hidden = automation.mode !== "ai";
    if (automation.mode === "ai") {
      banner.innerHTML = `<span>✧ ${automation.typing ? "AI 正在生成回复" : "AI 助手正在接待"}${automation.draft ? " · " + E(automation.draft.slice(0, 100)) : ""}</span><button type="button" id="takeover-ai">人工接管</button>`;
      banner.querySelector("button").onclick = safe(async () => {
        await api("/conversations/" + id + "/handoff", {
          method: "POST",
          body: JSON.stringify({ expectedRevision: c.revision }),
        });
        toast("已接管会话，自动回复已停止");
        await refresh();
      });
    }
    document.querySelector("#upload-attachment").disabled =
      c.status === "closed" || uploading.has(id);
    document.querySelector("#reply").disabled = c.status === "closed";
    document.querySelector("#send-reply").disabled =
      c.status === "closed" || sending.has(id);
    document.querySelector("#visitor-state").textContent =
      statusNames[c.status];
    document.querySelector("#visitor-assignee").textContent =
      c.assigneeName || "未分配";
    document.querySelector("#visitor-priority").value = c.priority;
    if (!state.notesDirty)
      document.querySelector("#visitor-notes").value = c.notes || "";
  }
  function profileDetails(profile = {}) {
    const labels = {
      externalId: "用户 ID",
      displayName: "姓名",
      phone: "电话",
      company: "公司",
      jobTitle: "职位",
      source: "来源",
      timezone: "时区",
      platform: "平台",
      device: "设备",
      os: "系统",
      appVersion: "应用版本",
      browser: "浏览器",
      language: "语言",
      location: "地区",
    };
    const rows = Object.entries(labels)
      .filter(([key]) => profile[key])
      .map(
        ([key, label]) =>
          `<div class="visitor-info-row"><dt>${label}</dt><dd>${E(profile[key])}</dd></div>`,
      )
      .join("");
    const custom = Object.entries(profile.custom || {})
      .map(
        ([key, value]) =>
          `<div class="visitor-info-row"><dt>${E(key)}</dt><dd>${E(value)}</dd></div>`,
      )
      .join("");
    return `${rows ? `<section class="visitor-info-section"><h3>用户资料</h3><dl>${rows}</dl></section>` : ""}${custom ? `<section class="visitor-info-section"><h3>自定义信息</h3><dl>${custom}</dl></section>` : ""}`;
  }
  function drawVisitor(c) {
    state.notesDirty = noteDrafts.has(c.id);
    const profile = c.profile || {};
    document.querySelector("#visitor-panel").innerHTML =
      `<div class="visitor-profile-head"><div class="avatar">${E((c.name || "?")[0])}</div><div><h2>${E(c.name)}</h2><span class="small">${profile.platform ? E(profile.platform) : "访客"} · 访客提供</span></div></div><section class="visitor-info-section"><h3>联系信息</h3><dl><div class="visitor-info-row"><dt>邮箱</dt><dd>${E(c.email || "未提供")}</dd></div><div class="visitor-info-row"><dt>当前状态</dt><dd id="visitor-state"></dd></div><div class="visitor-info-row"><dt>负责客服</dt><dd id="visitor-assignee"></dd></div></dl></section>${profileDetails(profile)}<section class="visitor-info-section"><div class="field"><label for="visitor-priority">优先级</label><select id="visitor-priority">${Object.entries(
        priorityNames,
      )
        .map(([k, v]) => `<option value="${k}">${v}</option>`)
        .join(
          "",
        )}</select></div><label for="visitor-notes" class="small">客户备注</label><textarea id="visitor-notes" placeholder="记录需要交接的信息…"></textarea><button id="save-notes">保存备注</button></section>`;
    document.querySelector("#visitor-priority").onchange = safe((e) =>
      change({ priority: e.target.value }),
    );
    document.querySelector("#visitor-notes").value =
      noteDrafts.get(c.id) ?? c.notes ?? "";
    document.querySelector("#visitor-notes").oninput = (e) => {
      state.notesDirty = true;
      noteDrafts.set(c.id, e.target.value);
    };
    document.querySelector("#save-notes").onclick = safe(async () => {
      const notes = document.querySelector("#visitor-notes").value;
      await change({ notes });
      state.notesDirty = false;
      noteDrafts.delete(c.id);
      toast("备注已保存");
    });
  }
  function visitorDialog(c) {
    modal(
      "访客与会话",
      `<h3>${E(c.name)}</h3><p class="small">${E(c.email || "未提供邮箱")} · 访客提供</p>${profileDetails(c.profile || {})}<div class="field"><label for="dialog-priority">优先级</label><select name="priority" id="dialog-priority">${Object.entries(
        priorityNames,
      )
        .map(
          ([k, v]) =>
            `<option value="${k}" ${c.priority === k ? "selected" : ""}>${v}</option>`,
        )
        .join(
          "",
        )}</select></div><div class="field"><label for="dialog-status">状态</label><select name="status" id="dialog-status">${Object.entries(
        statusNames,
      )
        .map(
          ([k, v]) =>
            `<option value="${k}" ${c.status === k ? "selected" : ""}>${v}</option>`,
        )
        .join(
          "",
        )}</select></div><div class="field"><label for="dialog-notes">客户备注</label><textarea id="dialog-notes" name="notes">${E(noteDrafts.get(c.id) ?? c.notes ?? "")}</textarea></div>`,
      "保存",
      async (b) => {
        await change(b, c.revision, c.id);
        state.notesDirty = false;
        noteDrafts.delete(c.id);
      },
    );
  }
  async function replyChooser(c) {
    try {
      const rows = await api("/quick-replies");
      const o = modal(
        "插入快捷回复",
        '<input id="quick-query" aria-label="搜索话术" placeholder="搜索标题、分类或内容…"><div id="quick-options" class="global-results"></div>',
        "关闭",
      );
      const draw = (q) => {
        const list = rows.filter((r) =>
          (r.title + r.category + r.body)
            .toLowerCase()
            .includes(q.toLowerCase()),
        );
        o.querySelector("#quick-options").innerHTML = list.length
          ? list
              .map(
                (r) =>
                  `<button type="button" class="search-result" data-insert-reply="${r.id}"><strong>${E(r.title)} <span class="badge neutral">${E(r.category)}</span></strong><span class="small">${E(r.body.slice(0, 160))}</span></button>`,
              )
              .join("")
          : '<p class="small">暂无匹配话术。管理员可在快捷回复页面维护。</p>';
        o.querySelectorAll("[data-insert-reply]").forEach(
          (b) =>
            (b.onclick = () => {
              if (state.active !== c.id) return toast("当前会话已变化");
              const text = rows
                  .find((r) => r.id === b.dataset.insertReply)
                  .body.replaceAll("{{visitor.name}}", c.name)
                  .replaceAll("{{agent.name}}", getMe().name),
                input = document.querySelector("#reply");
              input.value = (input.value ? input.value + "\n" : "") + text;
              input.dispatchEvent(new Event("input", { bubbles: true }));
              o.querySelector("[data-close]").click();
              input.focus();
            }),
        );
      };
      draw("");
      o.querySelector("#quick-query").oninput = (e) => draw(e.target.value);
    } catch (e) {
      toast(e.message);
    }
  }
  function open(id) {
    ensureIdentity();
    state.filter = {
      status: "all",
      assignee: "all",
      priority: "all",
      unread: false,
      q: "",
    };
    state.active = id;
    state.offset = 0;
    state.detail = null;
    state.threadKey = "";
    state.headerKey = "";
    if (isActive()) mount();
    else navigate("inbox");
  }
  function paintPending() {
    const el = document.querySelector("#staff-outbox");
    if (!el || !outbox) return;
    const rows = pending.filter((r) => r.conversationId === state.active);
    el.innerHTML = outboxHTML(rows, E);
    bindOutbox(el, outbox);
  }
  const acknowledgements = new Map();
  async function acknowledgeThread(data) {
    if (!data?.receipts || !state.active || !getMe()) return;
    const id = data.conversation.id,
      seq = data.receipts.lastSeq,
      el = document.querySelector("#messages"),
      read =
        document.visibilityState === "visible" &&
        el &&
        el.scrollHeight - el.scrollTop - el.clientHeight < 90
          ? seq
          : 0;
    const key = getMe().id + "|" + id,
      prior = acknowledgements.get(key) || { delivered: 0, read: 0 };
    if (seq <= prior.delivered && read <= prior.read) return;
    acknowledgements.set(key, {
      delivered: seq,
      read: Math.max(read, prior.read),
    });
    try {
      await api("/conversations/" + id + "/receipts", {
        method: "POST",
        body: JSON.stringify({
          deliveredSeq: seq,
          readSeq: Math.max(read, prior.read),
        }),
      });
    } catch {
      acknowledgements.delete(key);
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (isActive() && state.detail) acknowledgeThread(state.detail);
  });
  document.addEventListener(
    "scroll",
    (e) => {
      if (e.target?.id === "messages" && isActive() && state.detail)
        acknowledgeThread(state.detail);
    },
    true,
  );
  return {
    mount,
    get activeId() {
      return state.active;
    },
    refresh,
    open,
    close() {
      outbox?.close();
      pending = [];
      acknowledgements.clear();
    },
  };
}
