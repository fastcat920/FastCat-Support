import { createExtensionsUI } from "./extensions.js";
import { createNotifications } from "./notifications.js";
import { createSettingsUI } from "./settings.js";
import { createAgentEditor } from "./agent-editor.js";
import { createAccessUI } from "./access.js";
import { createProviderUI } from "./providers.js";
import { purgeOutbox } from "./outbox.js";
import { createServiceUI } from "./service.js";
import { createManagementUI } from "./management.js";
import { createInboxUI } from "./inbox.js";
import { iconMarkup } from "./icons.js";
import { createFeatureUI } from "./features.js";
const app = document.querySelector("#app");
let me,
  page = location.hash.slice(1) || "inbox",
  query = "",
  resources = [],
  events;
const drafts = new Map();
const E = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icons = iconMarkup;
const titles = {
  inbox: "会话收件箱",
  visitors: "访客管理",
  replies: "快捷回复",
  agent: "智能体",
  reception: "自动接待",
  knowledge: "知识库",
  workflow: "工作流",
  tool: "工具集成",
  channel: "接入平台",
  model: "模型管理",
  extensions: "技能与设备",
  members: "团队管理",
  teams: "团队管理",
  tags: "标签管理",
  audit: "操作记录",
  settings: "设置",
};
const details = {
  agent: [
    "智能体",
    "配置角色、指令与模型，为不同业务场景建立专属智能体。",
    "创建智能体",
  ],
  knowledge: [
    "让每一次回答都有据可依",
    "集中整理业务知识，为客服提供准确的参考信息。",
    "添加知识",
  ],
  workflow: [
    "连接服务中的每一个环节",
    "保存工作流定义，规划自动化服务流程。",
    "创建工作流",
  ],
  tool: ["拓展服务能力", "管理工具连接信息与业务系统集成配置。", "添加工具"],
  channel: [
    "在客户所在的地方提供服务",
    "统一管理服务入口，与客户建立连接。",
    "添加渠道",
  ],
  model: ["模型管理", "管理模型标识与服务地址。", "添加模型"],
};
const accessUI = createAccessUI({ api, E, modal, toast });
const featureUI = createFeatureUI({
  api,
  E,
  modal,
  toast,
  isActive: (kind) => page === kind,
  isAdmin: () => me?.role === "admin",
});
const inboxUI = createInboxUI({
  api,
  E,
  modal,
  toast,
  getMe: () => me,
  isActive: () => page === "inbox",
  drafts,
  aiDebug,
  navigate,
});
const managementUI = createManagementUI({
  api,
  E,
  modal,
  toast,
  getMe: () => me,
  navigate,
  openConversation: (id) => inboxUI.open(id),
  isActive: (kind) => page === kind,
});
const serviceUI = createServiceUI({
  api,
  E,
  modal,
  toast,
  isActive: (kind) => page === kind,
  openConversation: (id) => inboxUI.open(id),
});
const extensionsUI = createExtensionsUI({ api, E, modal, toast });
const providerUI = createProviderUI({ api, E, modal, toast });
const allowedPage = (p) =>
  me?.role === "admin" ||
  ["inbox", "knowledge", "visitors", "replies", "settings"].includes(p);
async function api(p, opts = {}) {
  const r = await fetch("/api" + p, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts.headers },
  });
  const d = await r.json();
  if (!r.ok) {
    if (r.status === 401 && me) {
      me = null;
      events?.close();
      boot();
    }
    throw Object.assign(Error(d.error || "请求失败"), { status: r.status });
  }
  return d;
}
function toast(s) {
  const el = document.querySelector("#toast");
  el.textContent = s;
  el.style.display = "block";
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => (el.style.display = "none"), 3500);
}
function bindError(fn) {
  return async (e) => {
    try {
      await fn(e);
    } catch (err) {
      toast(err.message);
    }
  };
}
function empty(symbol, title, desc, action = "") {
  return `<div class="empty"><div class="empty-symbol">${symbol}</div><strong>${title}</strong><p>${desc}</p>${action}</div>`;
}
function field(name, label, placeholder = "", type = "text", value = "") {
  return `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" placeholder="${E(placeholder)}" value="${E(value)}" required></div>`;
}
const notifications = createNotifications({
  api,
  getMe: () => me,
  getActive: () => (page === "inbox" ? inboxUI.activeId : null),
  openConversation: (id) => inboxUI.open(id),
  toast,
});
const settingsUI = createSettingsUI({
  api,
  E,
  toast,
  getMe: () => me,
  navigate,
  notifications,
  onProfile: async (value) => {
    me = value;
    shell();
    await render();
  },
});
async function boot() {
  try {
    const invite = new URLSearchParams(location.search).get("invite");
    if (invite) return invitationScreen(invite);
    const s = await api("/setup");
    if (s.required) return auth(true);
    try {
      me = await api("/me");
    } catch {
      return auth(false);
    }
    sessionStorage.setItem(
      "fc_staff_identity",
      JSON.stringify({ id: me.id, name: me.name, role: me.role }),
    );
    shell();
    await notifications.init();
    events?.close();
    events = new EventSource("/api/events");
    events.onopen = () => notifications.poll();
    events.onmessage = () => {
      notifications.poll();
      if (page === "inbox") inboxUI.refresh();
    };
    render();
  } catch (e) {
    const cached = sessionStorage.getItem("fc_staff_identity");
    if ((navigator.onLine === false || !e.status) && cached) {
      const identity = JSON.parse(cached);
      let pendingBox;
      app.innerHTML = `<main class="login"><section class="login-card"><h1>当前离线</h1><p>待发消息已保留在此浏览器，恢复网络后会重新验证登录与会话权限。</p><div id="offline-pending"></div><button id="retry-connection">重新连接</button></section></main>`;
      const { createOutbox, outboxHTML, bindOutbox } =
        await import("./outbox.js");
      pendingBox = createOutbox({
        owner: "staff:" + identity.id,
        canSend: () => false,
        send: async () => {},
        onChange: (rows) => {
          const el = document.querySelector("#offline-pending");
          if (el) {
            el.innerHTML = outboxHTML(rows, E);
            bindOutbox(el, pendingBox);
          }
        },
      });
      document.querySelector("#retry-connection").onclick = () => {
        pendingBox.close();
        boot();
      };
      window.addEventListener(
        "online",
        () => {
          pendingBox.close();
          boot();
        },
        { once: true },
      );
      return;
    }
    app.innerHTML = empty(
      "!",
      "服务暂时不可用",
      E(e.message),
      '<button onclick="location.reload()">重新加载</button>',
    );
  }
}
async function invitationScreen(token) {
  try {
    const inv = await api("/invites/" + encodeURIComponent(token));
    app.innerHTML = `<main class="login"><section class="login-card"><div class="brand"><span class="mark">F</span>FastCat Support</div><h1>加入团队工作空间</h1><p class="muted">${E(inv.email)} · ${inv.role === "admin" ? "管理员" : "客服"}</p><form>${field("name", "你的姓名", "填写显示名称")}${field("password", "设置密码", "至少 10 位", "password")}<p class="error" role="alert"></p><button class="primary">接受邀请并创建账号</button></form><p class="small">创建账号后使用邀请邮箱登录。</p></section></main>`;
    app.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const button = e.submitter;
      button.disabled = true;
      try {
        await api("/invites/" + encodeURIComponent(token) + "/accept", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
        });
        history.replaceState(null, "", "/");
        toast("账号已创建，请登录");
        auth(false);
      } catch (err) {
        app.querySelector(".error").textContent = err.message;
        button.disabled = false;
      }
    };
  } catch (err) {
    app.innerHTML = `<main class="login"><section class="login-card"><h1>邀请无法使用</h1><p class="muted">${E(err.message)}</p><a href="/">返回登录</a></section></main>`;
  }
}
function auth(setup) {
  app.innerHTML = `<main class="login"><section class="login-card"><div class="brand"><span class="mark">F</span>FastCat Support</div><h1>${setup ? "设置管理员账号" : "欢迎回来"}</h1><p class="muted">${setup ? "首次部署，请设置管理员姓名、登录邮箱和密码。此步骤仅需完成一次。" : "登录以继续为客户提供帮助。"}</p><form>${setup ? field("name", "你的姓名", "请输入姓名") : ""}${field("email", "邮箱", "name@company.com", "email")}${field("password", "密码", setup ? "至少 10 位" : "请输入密码", "password")}${setup ? field("confirmPassword", "确认密码", "再次输入密码", "password") : ""}<p class="error" id="auth-error" role="alert"></p><button class="primary">${setup ? "创建管理员并进入工作台" : "登录工作台"}</button></form><p class="small">FastCat Support · 让服务更进一步</p></section></main>`;
  app.querySelector('[name="password"]').autocomplete = setup
    ? "new-password"
    : "current-password";
  app.querySelector('[name="email"]').autocomplete = "username";
  if (setup) {
    app.querySelector('[name="password"]').minLength = 10;
    app.querySelector('[name="confirmPassword"]').autocomplete = "new-password";
  }
  app.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target));
    if (setup && values.password !== values.confirmPassword) {
      document.querySelector("#auth-error").textContent =
        "两次输入的密码不一致";
      return;
    }
    delete values.confirmPassword;
    const b = e.submitter;
    b.disabled = true;
    try {
      await api(setup ? "/setup" : "/login", {
        method: "POST",
        body: JSON.stringify(values),
      });
      location.hash = "inbox";
      boot();
    } catch (err) {
      document.querySelector("#auth-error").textContent = err.message;
    } finally {
      b.disabled = false;
    }
  };
}
let agentMenuOpen = false;
const agentChildren = ["workflow", "tool", "extensions"];
function navigationMarkup() {
  const button = (key, label = titles[key]) =>
    `<button data-page="${key}" aria-label="${label}"><span class="icon">${icons[key] || icons.tool}</span><span class="nav-text">${label}</span></button>`;
  return Object.keys(titles)
    .filter(
      (k) => allowedPage(k) && !agentChildren.includes(k) && k !== "teams",
    )
    .map((k) => {
      const label =
        { inbox: "服务工作台", agent: "AI 与渠道", members: "工作空间管理" }[
          k
        ] || (me.role !== "admin" && k === "knowledge" ? "共享知识" : "");
      const heading = label
        ? `<div class="nav-group-label">${label}</div>`
        : "";
      if (k === "agent")
        return (
          heading +
          `<div class="nav-parent"><div class="nav-parent-row">${button(k)}<button id="toggle-agent-menu" class="nav-disclosure" aria-label="展开智能体子菜单" aria-expanded="false" aria-controls="agent-submenu">⌄</button></div><div id="agent-submenu" class="nav-submenu" hidden>${agentChildren.map((k) => button(k)).join("")}</div></div>`
        );
      return heading + button(k);
    })
    .join("");
}
function updateAgentMenu() {
  const menu = document.querySelector("#agent-submenu"),
    toggle = document.querySelector("#toggle-agent-menu");
  if (!menu) return;
  menu.hidden = !agentMenuOpen;
  toggle.setAttribute("aria-expanded", String(agentMenuOpen));
  toggle.setAttribute(
    "aria-label",
    agentMenuOpen ? "收起智能体子菜单" : "展开智能体子菜单",
  );
}
function shell() {
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="mark">F</span><span class="brand-text">FastCat<span style="font-weight:400"> Support</span></span></div><div class="nav-label">工作空间</div><nav class="nav">${navigationMarkup()}</nav><div class="sidebar-foot"><div class="row"><div class="avatar">${me.avatar ? `<img src="/api/profile/avatar" alt="个人头像">` : E(me.name[0])}</div><div class="small">${E(me.name)}<br>${me.role === "admin" ? "管理员" : "客服"}</div></div><button id="logout" class="quiet small">退出登录</button></div></aside><main><header class="topbar"><strong id="breadcrumb"></strong><div class="right"><button id="global-search-button" class="search-launcher" aria-label="搜索与快速跳转"><span>搜索工作空间</span><kbd>⌘ K</kbd></button><button id="theme-toggle" class="quiet" aria-label="切换主题" title="切换明暗主题">◐</button><select id="own-availability" class="presence-select" aria-label="我的接待状态"><option value="available">可接待</option><option value="away">暂离</option><option value="offline">不接待</option></select><button id="open-widget" class="quiet">↗ 访客端预览</button><div class="avatar">${me.avatar ? `<img src="/api/profile/avatar" alt="个人头像">` : E(me.name[0])}</div></div></header><div id="view"></div></main></div>`;
  app
    .querySelectorAll("[data-page]")
    .forEach((b) => (b.onclick = () => navigate(b.dataset.page)));
  const toggle = document.querySelector("#toggle-agent-menu");
  if (toggle)
    toggle.onclick = () => {
      agentMenuOpen = !agentMenuOpen;
      updateAgentMenu();
    };
  updateAgentMenu();
  document.querySelector("#global-search-button").onclick = () =>
    managementUI.globalSearch();
  document.querySelector("#own-availability").value =
    me.availability || "available";
  document.querySelector("#own-availability").onchange = bindError(
    async (event) => {
      const select = event.target;
      select.disabled = true;
      try {
        await api("/presence", {
          method: "PATCH",
          body: JSON.stringify({ availability: select.value }),
        });
        me.availability = select.value;
        toast("接待状态已更新");
      } catch (error) {
        select.value = me.availability || "available";
        throw error;
      } finally {
        select.disabled = false;
      }
    },
  );
  document.querySelector("#theme-toggle").onclick = () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    notifications
      .save({ theme: dark ? "dark" : "light" })
      .catch((e) => toast(e.message));
  };
  document.querySelector("#logout").onclick = bindError(async () => {
    sessionStorage.removeItem("fc_staff_identity");
    inboxUI.close();
    notifications.close();
    await purgeOutbox("staff:" + me.id).catch(() =>
      toast("本地队列清理失败，请清除本站点数据"),
    );
    await api("/logout", { method: "POST" });
    me = null;
    drafts.clear();
    events?.close();
    boot();
  });
  document.querySelector("#open-widget").onclick = () =>
    window.open("/widget", "_blank", "noopener");
}
function navigate(p) {
  query = "";
  location.hash = p;
  if (page === p) render();
}
window.onhashchange = () => {
  page = location.hash.slice(1) || "inbox";
  if (me) render();
};
async function render() {
  if (!titles[page] || !allowedPage(page)) page = "inbox";
  if (page === "agent" || agentChildren.includes(page)) agentMenuOpen = true;
  updateAgentMenu();
  document.querySelectorAll("[data-page]").forEach((b) => {
    b.classList.toggle(
      "active",
      b.dataset.page === page ||
        (b.dataset.page === "members" && page === "teams") ||
        (b.dataset.page === "agent" && agentChildren.includes(page)),
    );
    b.setAttribute("aria-current", b.dataset.page === page ? "page" : "false");
  });
  document
    .querySelector('nav [aria-current="page"]')
    ?.scrollIntoView({ block: "nearest" });
  document.querySelector("#breadcrumb").textContent = titles[page];
  const v = document.querySelector("#view");
  try {
    if (page === "channel") return await accessUI.render();
    if (page === "extensions") return await extensionsUI.render();
    if (page === "settings") return await settingsUI.render();
    if (page === "model") return await providerUI.render();
    if (page === "inbox") return await inboxUI.mount();
    if (["teams", "reception"].includes(page))
      return await serviceUI.render(page);
    if (["members", "replies", "tags", "audit", "settings"].includes(page))
      return await managementUI.render(page);
    if (page === "visitors") {
      const rows = await api("/visitors");
      if (page !== "visitors") return;
      v.innerHTML = `<div class="content management-page">${heading("访客管理", "搜索客户资料，快速回到相关服务会话。")}<section class="panel"><div class="toolbar"><input id="visitor-query" aria-label="搜索访客" placeholder="搜索姓名、邮箱或备注…"><span class="small">${rows.length} 位可见访客</span></div><div id="visitor-table"></div></section></div>`;
      const draw = (q) => {
        const filtered = rows.filter((r) =>
          (r.name + r.email + r.notes).toLowerCase().includes(q.toLowerCase()),
        );
        document.querySelector("#visitor-table").innerHTML = filtered.length
          ? `<div class="table-scroll"><table class="table"><thead><tr><th>姓名</th><th>邮箱</th><th>备注</th><th>操作</th></tr></thead><tbody>${filtered.map((r) => `<tr><td><strong>${E(r.name)}</strong></td><td>${E(r.email || "未提供")}</td><td>${E(r.notes || "—")}</td><td><button class="quiet" data-visitor-history="${r.id}">会话记录 →</button></td></tr>`).join("")}</tbody></table></div>`
          : empty("♧", "暂无匹配访客", "试试其他关键词，或等待新的客户咨询。");
        document.querySelectorAll("[data-visitor-history]").forEach(
          (button) =>
            (button.onclick = bindError(async () => {
              const items = await api(
                "/visitors/" + button.dataset.visitorHistory + "/conversations",
              );
              const o = modal(
                "访客会话记录",
                items
                  .map(
                    (c) =>
                      `<button type="button" class="history-row" data-history-conversation="${c.id}"><strong>${E(c.subject)}</strong><span class="badge">${statusName(c.status)}</span><span class="small">${E(c.assigneeName || "未分配")} · ${new Date(c.updated).toLocaleString("zh-CN")}</span></button>`,
                  )
                  .join(""),
                "关闭",
              );
              o.querySelectorAll("[data-history-conversation]").forEach(
                (b) =>
                  (b.onclick = () => {
                    o.querySelector("[data-close]").click();
                    inboxUI.open(b.dataset.historyConversation);
                  }),
              );
            })),
        );
      };
      draw("");
      document.querySelector("#visitor-query").oninput = (e) =>
        draw(e.target.value);
      return;
    }
    await resourcePage();
  } catch (e) {
    toast(e.message);
  }
}
function heading(t, d, btn = "") {
  return `<div class="page-heading"><div><h1>${t}</h1><p>${d}</p></div>${btn}</div>`;
}
function statusName(s) {
  return { open: "待处理", pending: "跟进中", closed: "已结束" }[s] || s;
}
async function resourcePage() {
  if (["knowledge", "workflow", "tool"].includes(page))
    return featureUI.render(page);
  const kind = page;
  resources = await api("/resources?kind=" + kind);
  if (kind !== page) return;
  const [title, desc, button] = details[kind],
    v = document.querySelector("#view");
  v.innerHTML = `<div class="content">${heading(title, desc, `<button class="primary" id="create">＋ ${button}</button>`)}${["workflow", "tool", "model"].includes(kind) ? '<div class="notice">模型目录用于记录服务与模型标识。实际模型连接和密钥由服务器环境变量配置。</div>' : kind === "agent" ? '<div class="notice">支持服务指令、多知识库、授权工具自动调用和可选角色协作。可选择模型供应商或使用工作空间默认连接；调试结果由人工确认发送。</div>' : ""}${kind === "channel" ? `<section class="panel" style="margin-bottom:24px"><div class="panel-head"><div><h2>网站客服组件</h2><p class="small">可用 · 访客发送消息，客服工作台实时接收</p></div><button id="widget-preview">打开预览 ↗</button></div><label>嵌入代码（同源网站）</label><div class="code">${E('<iframe src="' + location.origin + '/widget" title="在线客服" width="430" height="730"></iframe>')}</div><p class="small">其他域名嵌入需要单独配置访问策略。外部渠道仅保存配置，尚未接入。</p></section>` : ""}<div class="toolbar"><input id="search" aria-label="搜索" placeholder="搜索${titles[kind]}…" value="${E(query)}"><div class="row">${kind === "knowledge" ? '<button id="knowledge-search">检索测试</button><button id="import-knowledge">导入文本</button>' : ""}<span class="small">共 ${resources.length} 项</span></div></div><div id="resource-list"></div></div>`;
  document.querySelector("#create").onclick = () => resourceModal(kind);
  document
    .querySelector("#widget-preview")
    ?.addEventListener("click", () =>
      window.open("/widget", "_blank", "noopener"),
    );
  document.querySelector("#search").oninput = (e) => {
    query = e.target.value;
    resourceList(kind);
  };
  document
    .querySelector("#knowledge-search")
    ?.addEventListener("click", knowledgeSearch);
  document
    .querySelector("#import-knowledge")
    ?.addEventListener("click", importKnowledge);
  resourceList(kind);
}
function resourceList(kind) {
  const rows = resources.filter((r) =>
    (r.name + r.description).toLowerCase().includes(query.toLowerCase()),
  );
  document.querySelector("#resource-list").innerHTML = rows.length
    ? `<div class="grid">${rows.map((r) => `<article class="card"><div class="row"><div class="avatar">${icons[kind]}</div><span class="badge">${kind === "knowledge" ? "知识条目" : "已保存"}</span><button class="quiet danger" data-delete="${r.id}" style="margin-left:auto" aria-label="删除 ${E(r.name)}">×</button></div><h3>${E(r.name)}</h3><p>${E(r.description.slice(0, 150) || "暂无描述")}</p><div class="small">${new Date(r.created).toLocaleDateString("zh-CN")} 创建</div><div class="row" style="margin-top:18px"><button data-view="${r.id}">查看详情</button><button data-edit="${r.id}">编辑</button>${kind === "agent" ? `<button data-debug="${r.id}" class="primary">调试</button>` : ""}</div></article>`).join("")}</div>`
    : empty(
        icons[kind],
        query ? "没有匹配结果" : `还没有${titles[kind]}`,
        query
          ? "试试其他关键词。"
          : `点击右上角「${details[kind][2]}」开始配置。`,
      );
  document.querySelectorAll("[data-edit]").forEach(
    (b) =>
      (b.onclick = () =>
        resourceModal(
          kind,
          resources.find((x) => x.id === b.dataset.edit),
        )),
  );
  document
    .querySelectorAll("[data-debug]")
    .forEach((b) => (b.onclick = () => aiDebug(b.dataset.debug)));
  document
    .querySelectorAll("[data-delete]")
    .forEach((b) => (b.onclick = () => confirmDelete(b.dataset.delete, kind)));
  document.querySelectorAll("[data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        const r = resources.find((x) => x.id === b.dataset.view);
        modal(
          r.name,
          `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${E(r.description)}</p><div class="code">${E(JSON.stringify(r.config, null, 2))}</div>`,
          "关闭",
        );
      }),
  );
}
function modal(title, html, submit = "保存", onSubmit) {
  const o = document.createElement("div");
  o.className = "overlay";
  const titleId = "dialog-" + crypto.randomUUID();
  const parentDialog = [...document.querySelectorAll(".overlay")].at(-1);
  const appRoot = document.querySelector("#app");
  if (parentDialog) parentDialog.inert = true;
  appRoot.inert = true;
  o.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}"><header><h2 id="${titleId}">${E(title)}</h2><button class="quiet" type="button" data-close aria-label="关闭">×</button></header><form>${html}<footer>${onSubmit ? '<button type="button" data-close>取消</button>' : ""}<button class="primary" ${onSubmit ? 'type="submit"' : 'type="button" data-close'}>${submit}</button></footer></form></section>`;
  document.body.append(o);
  const prior = document.activeElement;
  const close = () => {
    o.dispatchEvent(new Event("dialogclose"));
    o.remove();
    const remaining = [...document.querySelectorAll(".overlay")],
      top = remaining.at(-1);
    remaining.forEach((dialog) => (dialog.inert = dialog !== top));
    appRoot.inert = !!top;
    if (top) {
      if (prior?.isConnected && top.contains(prior)) prior.focus();
      else top.querySelector("button,input,textarea,select")?.focus();
    } else if (prior?.isConnected) prior.focus();
  };
  o.querySelectorAll("[data-close]").forEach((b) => (b.onclick = close));
  o.onkeydown = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      const els = [
        ...o.querySelectorAll("button,input,textarea,select"),
      ].filter((el) => !el.disabled && el.getClientRects().length);
      if (e.shiftKey && document.activeElement === els[0]) {
        e.preventDefault();
        els.at(-1).focus();
      } else if (!e.shiftKey && document.activeElement === els.at(-1)) {
        e.preventDefault();
        els[0].focus();
      }
    }
  };
  o.querySelector("form").onsubmit = bindError(async (e) => {
    e.preventDefault();
    if (onSubmit) {
      e.submitter.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(e.target)));
      } catch (err) {
        e.submitter.disabled = false;
        throw err;
      }
    }
    close();
  });
  (
    o.querySelector("form input,form textarea,form select") ||
    o.querySelector("button")
  ).focus();
  return o;
}
function confirmDelete(id, kind) {
  const r = resources.find((x) => x.id === id);
  modal(
    "删除确认",
    `<p>确定删除「${E(r.name)}」？删除后无法恢复。</p>`,
    "确认删除",
    async () => {
      await api("/resources/" + id, { method: "DELETE" });
      toast("已删除");
      resourcePage();
    },
  );
}
async function resourceModal(kind, existing) {
  if (kind === "agent")
    return createAgentEditor({ api, E, modal, toast, onSaved: resourcePage })(
      existing,
    );
  let collections = [],
    providerOptions = [],
    agentOptions = [],
    toolOptions = [],
    modelOptions = [];
  const toolBindings = structuredClone(existing?.config.toolBindings || []);
  if (kind === "agent") {
    try {
      [collections, providerOptions, agentOptions, toolOptions, modelOptions] =
        await Promise.all([
          api("/knowledge/collections"),
          api("/ai/providers"),
          api("/resources?kind=agent"),
          api("/resources?kind=tool"),
          api("/ai/models"),
        ]);
    } catch (e) {
      return toast(e.message);
    }
  }
  const fields = {
    agent: ["服务指令", "描述角色、回答范围和转人工条件"],
    knowledge: ["知识内容 / 问答", "输入业务知识，或按“问题：… 答案：…”整理"],
    tool: ["工具说明", "描述工具用途"],
    workflow: ["流程说明", "描述步骤和分支条件"],
    channel: ["渠道说明", "描述接入场景"],
    model: ["模型说明", "描述模型用途"],
  }[kind];
  const overlay = modal(
    existing ? "编辑" + titles[kind] : details[kind][2],
    `${field("name", "名称", "给它起一个便于识别的名称")}<div class="field"><label for="description">${fields[0]}</label><textarea id="description" name="description" placeholder="${fields[1]}" required></textarea></div>${
      kind === "model"
        ? field(
            "endpoint",
            "兼容接口地址",
            "https://api.example.com/v1",
            "url",
          ) + field("model", "模型标识", "provider/model")
        : kind === "tool"
          ? field(
              "endpoint",
              "服务地址",
              "https://tools.example.com/mcp",
              "url",
            )
          : kind === "agent"
            ? `<div class="field"><label for="providerId">模型供应商</label><select name="providerId" id="providerId"><option value="">工作空间默认</option>${providerOptions.map((p) => `<option value="${p.id}">${E(p.name)} · ${E(p.model)}</option>`).join("")}</select></div><div class="field"><label for="model">覆盖模型标识（选填）</label><input id="model" name="model" placeholder="默认模型"></div><div class="field"><label for="collectionIds">绑定知识库（可多选，未选择则检索全部）</label><select id="collectionIds" name="collectionIds" multiple size="4">${collections.map((c) => `<option value="${c.id}" ${(existing?.config.collectionIds || [existing?.config.collectionId]).includes(c.id) ? "selected" : ""}>${E(c.name)}</option>`).join("")}</select></div><h3>可自动执行的工具操作</h3><div id="agent-tool-bindings"></div><button type="button" id="add-agent-tool">＋ 绑定工具操作</button><div class="field"><label for="maxToolRounds">模型调用轮数上限（含最终回答）</label><input id="maxToolRounds" name="maxToolRounds" type="number" min="1" max="5" value="${existing?.config.maxToolRounds || 3}"></div><p class="small">仅授权所选操作供此智能体自动执行。请按业务权限选择；远程操作不自动重试，取消不能撤销已经完成的操作。</p><label class="row"><input type="checkbox" name="collaborationEnabled" ${existing?.config.collaboration?.enabled ? "checked" : ""}>启用多智能体协作</label><div class="field"><label for="collaborationMembers">协作成员（选择 2–4 位）</label><select id="collaborationMembers" name="collaborationMembers" multiple size="5">${agentOptions
                .filter(
                  (a) =>
                    a.id !== existing?.id && !a.config.collaboration?.enabled,
                )
                .map(
                  (a) =>
                    `<option value="${a.id}" ${existing?.config.collaboration?.memberIds?.includes(a.id) ? "selected" : ""}>${E(a.name)}</option>`,
                )
                .join(
                  "",
                )}</select></div><div class="field"><label for="collaborationRounds">讨论轮数</label><input id="collaborationRounds" name="collaborationRounds" type="number" min="1" max="3" value="${existing?.config.collaboration?.rounds || 1}"></div><p class="small">成员先独立分析，再互相评议，最后由当前智能体汇总。成员不能嵌套协作；每轮会产生模型调用。</p>`
            : kind === "channel"
              ? '<div class="field"><label for="type">渠道类型</label><select id="type" name="type"><option>微信</option><option>飞书</option><option>钉钉</option><option>Telegram</option><option>Slack</option><option>邮件</option></select></div>'
              : kind === "workflow"
                ? '<div class="field"><label for="definition">节点定义 JSON</label><textarea id="definition" name="definition" placeholder=\'{"nodes":[],"edges":[]}\'></textarea></div>'
                : ""
    }`,
    "保存",
    async (b) => {
      const { name, description, ...config } = b;
      if (kind === "agent") {
        config.collectionIds = [
          ...overlay.querySelector("#collectionIds").selectedOptions,
        ].map((x) => x.value);
        config.toolBindings = toolBindings;
        config.maxToolRounds = Number(b.maxToolRounds);
        config.collaboration = {
          enabled: !!b.collaborationEnabled,
          memberIds: [
            ...overlay.querySelector("#collaborationMembers").selectedOptions,
          ].map((x) => x.value),
          rounds: Number(b.collaborationRounds),
        };
        delete config.collaborationEnabled;
        delete config.collaborationMembers;
        delete config.collaborationRounds;
      }
      if (config.definition) {
        try {
          config.definition = JSON.parse(config.definition);
        } catch {
          throw Error("节点定义必须是有效 JSON");
        }
      }
      await api(existing ? "/resources/" + existing.id : "/resources", {
        method: existing ? "PATCH" : "POST",
        body: JSON.stringify({ kind, name, description, config }),
      });
      toast("已保存");
      resourcePage();
    },
  );
  if (kind === "agent") {
    const modelInput = overlay.querySelector("#model"),
      providerInput = overlay.querySelector("#providerId"),
      catalog = document.createElement("datalist");
    catalog.id = "agent-model-catalog";
    modelInput.setAttribute("list", catalog.id);
    overlay.querySelector("form").append(catalog);
    const drawModels = () => {
      const provider =
        providerInput.value || providerOptions.find((p) => p.is_default)?.id;
      catalog.replaceChildren(
        ...modelOptions
          .filter(
            (m) =>
              m.provider_id === provider &&
              m.model_type === "chat" &&
              m.enabled,
          )
          .map((m) => {
            const option = document.createElement("option");
            option.value = m.model;
            option.label = m.name;
            return option;
          }),
      );
    };
    providerInput.addEventListener("change", drawModels);
    drawModels();
    const showBindings = () => {
      const target = overlay.querySelector("#agent-tool-bindings");
      target.innerHTML =
        toolBindings
          .map(
            (b, i) =>
              `<div class="row"><span>${E(toolOptions.find((t) => t.id === b.resourceId)?.name || b.resourceId)} / ${E(b.name)}</span><button type="button" data-remove-binding="${i}">移除</button></div>`,
          )
          .join("") || '<p class="small">尚未授权自动工具操作。</p>';
      target.querySelectorAll("[data-remove-binding]").forEach(
        (button) =>
          (button.onclick = () => {
            toolBindings.splice(Number(button.dataset.removeBinding), 1);
            showBindings();
          }),
      );
    };
    showBindings();
    overlay.querySelector("#add-agent-tool").onclick = () => {
      let discoveredResource = "",
        tools = [];
      const picker = modal(
        "绑定工具操作",
        `<div class="field"><label>工具服务<select name="resource_id">${toolOptions.map((t) => `<option value="${t.id}">${E(t.name)}</option>`).join("")}</select></label></div><button type="button" id="discover-agent-tool">发现可用操作</button><div class="field"><label>工具操作<select name="tool_name"></select></label></div><p class="small" id="tool-discovery-status">先选择工具服务并发现操作。</p>`,
        "绑定",
        async (form) => {
          if (
            form.resource_id !== discoveredResource ||
            !tools.some((t) => t.name === form.tool_name)
          )
            throw Error("请先发现并选择一个操作");
          if (toolBindings.length >= 16) throw Error("最多绑定 16 个工具操作");
          if (
            toolBindings.some(
              (b) =>
                b.resourceId === form.resource_id && b.name === form.tool_name,
            )
          )
            throw Error("此操作已经绑定");
          toolBindings.push({
            resourceId: form.resource_id,
            name: form.tool_name,
          });
          showBindings();
        },
      );
      picker.querySelector("#discover-agent-tool").onclick = async (e) => {
        e.target.disabled = true;
        const status = picker.querySelector("#tool-discovery-status");
        try {
          const id = picker.querySelector("[name=resource_id]").value;
          if (!id) throw Error("请先创建本地工具服务");
          const result = await api("/tools/" + id + "/discover", {
            method: "POST",
          });
          tools = result.tools;
          discoveredResource = id;
          picker.querySelector("[name=tool_name]").innerHTML = tools
            .map((t) => `<option value="${E(t.name)}">${E(t.name)}</option>`)
            .join("");
          status.textContent =
            "已发现 " + tools.length + " 个操作，请选择需要授权的操作。";
        } catch (error) {
          status.textContent = error.message;
        } finally {
          e.target.disabled = false;
        }
      };
    };
  }
  if (existing) {
    const values = {
      name: existing.name,
      description: existing.description,
      ...existing.config,
    };
    for (const [key, value] of Object.entries(values)) {
      const input = overlay.querySelector(`[name="${key}"]`);
      if (input && !input.multiple)
        input.value =
          typeof value === "object" ? JSON.stringify(value, null, 2) : value;
    }
    if (kind === "agent")
      overlay.querySelector("#providerId").dispatchEvent(new Event("change"));
  }
}
async function aiDebug(agentId, conversationId) {
  let agents = [];
  if (conversationId) {
    try {
      agents = await api("/resources?kind=agent");
    } catch (error) {
      return toast(error.message);
    }
  }
  const o = modal(
    conversationId ? "生成回复草稿" : "智能体调试",
    `${conversationId ? `<div class="field"><label for="draft-agent">选择智能体</label><select id="draft-agent"><option value="">默认客服助手</option>${agents.map((a) => `<option value="${a.id}">${E(a.name)}${a.config.collaboration?.enabled ? " · 多智能体协作" : ""}</option>`).join("")}</select></div>` : field("question", "问题", "请输入需要测试的问题")}<div class="notice">回复由外部模型生成，仅供客服核对。知识检索使用所选知识库配置的关键词、语义或混合模式。</div><div id="ai-output" class="code" role="status">等待生成</div><div id="ai-collaboration" class="small" role="status"></div><div id="ai-sources" class="small" style="margin-top:12px"></div><div class="row" style="margin-top:18px"><button id="generate" type="button" class="primary">生成回复</button>${conversationId ? '<button id="use-draft" type="button" disabled>填入回复框</button>' : ""}</div>`,
    "关闭",
  );
  let output = "";
  const controller = new AbortController();
  o.addEventListener("dialogclose", () => controller.abort());
  o.querySelector("#generate").onclick = async (e) => {
    const question = o.querySelector('[name="question"]')?.value;
    if (!conversationId && !question?.trim()) return toast("请输入问题");
    output = "";
    e.target.disabled = true;
    o.querySelector("#ai-output").textContent = "正在生成…";
    try {
      const r = await fetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: conversationId
            ? o.querySelector("#draft-agent").value || undefined
            : agentId,
          conversationId,
          question,
        }),
        signal: controller.signal,
      });
      if (!r.ok) throw Error((await r.json()).error);
      let buffer = "";
      const decoder = new TextDecoder();
      let finished = false;
      for await (const chunk of r.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const lines = block.split("\n"),
            type = lines.find((l) => l.startsWith("event:"))?.slice(7),
            data = JSON.parse(
              lines.find((l) => l.startsWith("data:"))?.slice(6) || "{}",
            );
          if (type === "delta") {
            output += data.text;
            o.querySelector("#ai-output").textContent = output;
          } else if (type === "sources")
            o.querySelector("#ai-sources").textContent =
              "参考知识：" + (data.map((r) => r.name).join("、") || "无匹配");
          else if (type === "collaboration" && data.type === "tool")
            o.querySelector("#ai-collaboration").textContent =
              "工具 " +
              data.name +
              " · " +
              ({
                running: "调用中",
                succeeded: "已完成",
                failed: "失败",
                cancelled: "已取消",
              }[data.status] || data.status);
          else if (type === "collaboration")
            o.querySelector("#ai-collaboration").textContent =
              "第 " + data.round + " 轮 · " + data.name + " 已完成意见";
          else if (type === "error") throw Error(data.error);
          else if (type === "done") finished = true;
        }
      }
      if (!finished) throw Error("生成未完成");
      if (!output) throw Error("模型没有返回文本");
      if (conversationId) o.querySelector("#use-draft").disabled = false;
    } catch (err) {
      o.querySelector("#ai-output").textContent =
        err.name === "AbortError" ? "已取消" : err.message;
      output = "";
    } finally {
      e.target.disabled = false;
    }
  };
  o.querySelector("#use-draft")?.addEventListener("click", () => {
    if (document.querySelector("#reply")) {
      document.querySelector("#reply").value = output;
      drafts.set(conversationId, output);
      o.querySelector("[data-close]").click();
      toast("草稿已填入，请核对后发送");
    }
  });
}
document.addEventListener("keydown", (e) => {
  if (me && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!document.querySelector(".overlay")) managementUI.globalSearch();
  }
});
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("fc_theme") === "dark" ? "dark" : "light";
} catch {}
boot();

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
