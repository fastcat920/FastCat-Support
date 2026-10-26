import { teamNavigation } from "./team-navigation.js";
export function createManagementUI({
  api,
  E,
  modal,
  toast,
  getMe,
  navigate,
  openConversation,
  isActive,
}) {
  const safe = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (err) {
      toast(err.message);
    }
  };
  const post = (p, data) =>
    api(p, { method: "POST", body: JSON.stringify(data) });
  const patch = (p, data) =>
    api(p, { method: "PATCH", body: JSON.stringify(data) });
  const roleName = (role) => (role === "admin" ? "管理员" : "客服");
  const field = (key, label, value = "", type = "text", required = true) =>
    `<div class="field"><label for="mg-${key}">${label}</label><input id="mg-${key}" name="${key}" type="${type}" value="${E(value)}" ${required ? "required" : ""}></div>`;
  const heading = (t, d, button = "") =>
    `<div class="page-heading"><div><h1>${t}</h1><p>${d}</p></div>${button}</div>`;
  const empty = (t, d) =>
    `<div class="empty"><strong>${t}</strong><p>${d}</p></div>`;
  let lastPage = "";
  let epoch = 0,
    tab = "members",
    query = "",
    category = "all";
  async function render(page) {
    if (page !== lastPage) {
      query = "";
      category = "all";
      lastPage = page;
    }
    const revision = ++epoch;
    const me = getMe(),
      v = document.querySelector("#view");
    if (page === "members") {
      const [members, invitations] = await Promise.all([
        api("/members"),
        api("/invitations"),
      ]);
      if (revision !== epoch || !isActive(page)) return;
      v.innerHTML = `<div class="content management-page">${teamNavigation("members")}${heading("团队管理", "邀请同事加入工作空间，分配客服与管理员权限。", '<button class="primary" id="invite-member">＋ 邀请成员</button>')}<div class="management-stats"><span><strong>${members.filter((m) => m.active).length}</strong> 启用成员</span><span><strong>${members.filter((m) => m.role === "admin" && m.active).length}</strong> 管理员</span><span><strong>${invitations.filter((i) => !i.revoked && !i.accepted && i.expires > Date.now()).length}</strong> 待接受邀请</span></div><section class="panel"><div class="management-tabs"><button data-tab="members" class="${tab === "members" ? "active" : ""}">成员列表</button><button data-tab="invitations" class="${tab === "invitations" ? "active" : ""}">邀请记录</button></div><div class="toolbar"><input id="member-query" aria-label="搜索成员" placeholder="搜索姓名或邮箱…" value="${E(query)}"></div><div id="member-table"></div></section></div>`;
      const draw = () => {
        const rows = (tab === "members" ? members : invitations).filter((r) =>
          (r.name || "")
            .concat(r.email)
            .toLowerCase()
            .includes(query.toLowerCase()),
        );
        document.querySelector("#member-table").innerHTML = rows.length
          ? `<div class="table-scroll"><table class="table"><thead><tr>${tab === "members" ? "<th>成员</th><th>角色</th><th>状态</th><th>待处理会话</th><th>操作</th>" : "<th>邮箱</th><th>角色</th><th>状态</th><th>有效期</th><th>操作</th>"}</tr></thead><tbody>${rows.map((r) => (tab === "members" ? `<tr><td><div class="row"><div class="avatar">${E(r.name[0])}</div><div><strong>${E(r.name)} ${r.id === me.id ? '<span class="badge neutral">我</span>' : ""}</strong><div class="small">${E(r.email)}</div></div></div></td><td>${roleName(r.role)}</td><td><span class="badge ${r.active ? "success" : "neutral"}">${r.active ? "启用" : "停用"}</span></td><td>${r.workload}</td><td><button class="quiet" data-edit-member="${r.id}">管理</button></td></tr>` : `<tr><td>${E(r.email)}</td><td>${roleName(r.role)}</td><td><span class="badge neutral">${r.accepted ? "已加入" : r.revoked ? "已撤销" : r.expires < Date.now() ? "已过期" : "待接受"}</span></td><td>${new Date(r.expires).toLocaleDateString("zh-CN")}</td><td>${!r.accepted && !r.revoked && r.expires > Date.now() ? `<button class="quiet danger" data-revoke="${r.id}">撤销邀请</button>` : "—"}</td></tr>`)).join("")}</tbody></table></div>`
          : empty("暂无记录", "邀请成员后，可以在这里管理。");
        document
          .querySelectorAll("[data-edit-member]")
          .forEach(
            (b) =>
              (b.onclick = () =>
                editMember(members.find((m) => m.id === b.dataset.editMember))),
          );
        document.querySelectorAll("[data-revoke]").forEach(
          (b) =>
            (b.onclick = () =>
              modal(
                "撤销邀请",
                "<p>撤销后，该邀请链接将立即失效。</p>",
                "撤销",
                async () => {
                  await api("/invitations/" + b.dataset.revoke, {
                    method: "DELETE",
                  });
                  toast("邀请已撤销");
                  render("members");
                },
              )),
        );
      };
      draw();
      document.querySelector("#member-query").oninput = (e) => {
        query = e.target.value;
        draw();
      };
      document.querySelectorAll("[data-tab]").forEach(
        (b) =>
          (b.onclick = () => {
            tab = b.dataset.tab;
            render("members");
          }),
      );
      document.querySelector("#invite-member").onclick = inviteMember;
      return;
    }
    if (page === "replies") {
      const rows = await api("/quick-replies");
      if (revision !== epoch || !isActive(page)) return;
      const categories = [...new Set(rows.map((r) => r.category))];
      v.innerHTML = `<div class="content management-page">${heading("快捷回复", "沉淀常用话术，在会话中快速插入并按需调整。", me.role === "admin" ? '<button class="primary" id="new-quick-reply">＋ 新建快捷回复</button>' : "")}<div class="toolbar"><input id="reply-query" aria-label="搜索快捷回复" placeholder="搜索标题或回复内容…" value="${E(query)}"><select class="filter-select" id="reply-category" aria-label="回复分类"><option value="all">全部分类</option>${categories.map((c) => `<option ${category === c ? "selected" : ""}>${E(c)}</option>`).join("")}</select></div><div id="reply-library"></div></div>`;
      const draw = () => {
        const list = rows.filter(
          (r) =>
            (category === "all" || r.category === category) &&
            (r.title + r.body).toLowerCase().includes(query.toLowerCase()),
        );
        document.querySelector("#reply-library").innerHTML = list.length
          ? `<div class="grid">${list.map((r) => `<article class="card quick-reply-card"><div class="row"><span class="badge neutral">${E(r.category)}</span>${me.role === "admin" ? `<button class="quiet danger" data-delete-reply="${r.id}" aria-label="删除 ${E(r.title)}" style="margin-left:auto">×</button>` : ""}</div><h3>${E(r.title)}</h3><p>${E(r.body)}</p><div class="card-actions">${me.role === "admin" ? `<button data-edit-reply="${r.id}">编辑</button>` : ""}<button data-copy-reply="${r.id}">复制内容</button></div></article>`).join("")}</div>`
          : empty("暂无快捷回复", "管理员可以添加接待、售后、物流等常用话术。");
        document
          .querySelectorAll("[data-edit-reply]")
          .forEach(
            (b) =>
              (b.onclick = () =>
                replyDialog(rows.find((r) => r.id === b.dataset.editReply))),
          );
        document.querySelectorAll("[data-copy-reply]").forEach(
          (b) =>
            (b.onclick = safe(async () => {
              await navigator.clipboard.writeText(
                rows.find((r) => r.id === b.dataset.copyReply).body,
              );
              toast("已复制");
            })),
        );
        document.querySelectorAll("[data-delete-reply]").forEach(
          (b) =>
            (b.onclick = () =>
              modal(
                "删除快捷回复",
                "<p>确定删除这条快捷回复？</p>",
                "删除",
                async () => {
                  await api("/quick-replies/" + b.dataset.deleteReply, {
                    method: "DELETE",
                  });
                  render("replies");
                },
              )),
        );
      };
      draw();
      document.querySelector("#reply-query").oninput = (e) => {
        query = e.target.value;
        draw();
      };
      document.querySelector("#reply-category").onchange = (e) => {
        category = e.target.value;
        draw();
      };
      document
        .querySelector("#new-quick-reply")
        ?.addEventListener("click", () => replyDialog());
      return;
    }
    if (page === "tags") {
      const rows = await api("/tags");
      if (revision !== epoch || !isActive(page)) return;
      v.innerHTML = `<div class="content management-page">${heading("标签管理", "用统一的业务标签整理会话，便于筛选与协作。", '<button class="primary" id="new-tag">＋ 新建标签</button>')}<section class="panel">${rows.length ? `<div class="tag-library">${rows.map((r) => `<div class="tag-management-row"><span class="tag-chip ${r.color}">${E(r.name)}</span><button class="quiet danger" data-delete-tag="${r.id}" aria-label="删除标签 ${E(r.name)}">删除</button></div>`).join("")}</div>` : empty("暂无标签", "例如：售后咨询、VIP 客户、等待回访。")}</section></div>`;
      document.querySelector("#new-tag").onclick = () =>
        modal(
          "新建标签",
          field("name", "标签名称") +
            '<div class="field"><label for="tag-color">颜色</label><select id="tag-color" name="color"><option value="violet">紫色</option><option value="blue">蓝色</option><option value="green">绿色</option><option value="amber">橙色</option><option value="red">红色</option></select></div>',
          "创建",
          async (b) => {
            await post("/tags", b);
            render("tags");
          },
        );
      document.querySelectorAll("[data-delete-tag]").forEach(
        (b) =>
          (b.onclick = () =>
            modal(
              "删除标签",
              "<p>标签将从关联会话中移除，会话本身会保留。</p>",
              "删除",
              async () => {
                await api("/tags/" + b.dataset.deleteTag, { method: "DELETE" });
                render("tags");
              },
            )),
      );
      return;
    }
    if (page === "audit") {
      const rows = await api("/audit");
      if (revision !== epoch || !isActive(page)) return;
      const names = {
        "conversation.update": "更新会话",
        "conversation.claim": "接待会话",
        "service.route": "自动分流",
        "service.handoff": "人工接管",
        "ai.provider.save": "模型供应商配置",
        "service.settings": "更新接待设置",
        "member.update": "更新成员",
        "invitation.create": "创建邀请",
        "invitation.revoke": "撤销邀请",
        "tag.create": "创建标签",
        "tag.delete": "删除标签",
        "quick_reply.create": "创建快捷回复",
        "quick_reply.update": "更新快捷回复",
        "quick_reply.delete": "删除快捷回复",
      };
      v.innerHTML = `<div class="content management-page">${heading("操作记录", "查看最近 100 条成员、会话和常用配置的管理操作。", '<button id="refresh-audit">刷新</button>')}<section class="panel">${rows.length ? `<div class="table-scroll"><table class="table"><thead><tr><th>操作者</th><th>操作</th><th>对象</th><th>时间</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${E(r.actorName || (r.actor_id ? "原成员" : "系统"))}</td><td>${names[r.action] || E(r.action)}</td><td><code>${E(r.target_id.slice(0, 8))}</code><button class="quiet small" data-audit-detail="${r.id}">详情</button></td><td class="small">${new Date(r.created).toLocaleString("zh-CN")}</td></tr>`).join("")}</tbody></table></div>` : empty("暂无操作记录", "完成管理操作后，会自动记录在这里。")}</section></div>`;
      document.querySelector("#refresh-audit").onclick = () => render("audit");
      document.querySelectorAll("[data-audit-detail]").forEach(
        (b) =>
          (b.onclick = () => {
            const row = rows.find((r) => r.id === b.dataset.auditDetail);
            modal(
              "操作详情",
              `<p>${names[row.action] || E(row.action)}</p><pre class="code">${E(JSON.stringify(row.details, null, 2))}</pre>`,
              "关闭",
            );
          }),
      );
      return;
    }
    if (page === "settings") {
      v.innerHTML = `<div class="content management-page">${heading("工作空间设置", "管理账号、协作与服务配置。")}<section class="panel"><h2>当前账号</h2>${[
        ["姓名", me.name],
        ["邮箱", me.email],
        ["角色", roleName(me.role)],
        ["版本", "0.9.0"],
      ]
        .map(
          ([k, value]) =>
            `<div class="setting-row"><span class="muted">${k}</span><strong>${E(value)}</strong></div>`,
        )
        .join("")}</section><div class="settings-links">${(me.role === "admin"
        ? [
            ["members", "团队成员", "邀请、角色与成员状态"],
            ["teams", "接待团队", "团队成员、接待状态和容量"],
            ["reception", "自动接待", "关键词分流、工作时间与 AI 答复"],
            ["replies", "快捷回复", "维护团队常用服务话术"],
            ["tags", "标签管理", "管理会话业务分类"],
            ["audit", "操作记录", "查看近期管理操作"],
          ]
        : [
            ["replies", "快捷回复", "查看可用的服务话术"],
            ["inbox", "会话工作台", "处理我负责和未分配的会话"],
          ]
      )
        .map(
          ([id, t, d]) =>
            `<button class="panel" data-settings-page="${id}"><strong>${t} →</strong><span class="small">${d}</span></button>`,
        )
        .join("")}</div></div>`;
      document
        .querySelectorAll("[data-settings-page]")
        .forEach((b) => (b.onclick = () => navigate(b.dataset.settingsPage)));
      return;
    }
  }
  function inviteMember() {
    modal(
      "邀请成员",
      field("email", "同事邮箱", "", "email") +
        '<div class="field"><label for="invite-role">角色</label><select id="invite-role" name="role"><option value="agent">客服 · 处理本人及未分配会话</option><option value="admin">管理员 · 管理整个工作空间</option></select></div><p class="small">邀请有效期 7 天。创建后复制链接，由你自行分享给同事。</p>',
      "创建邀请",
      async (b) => {
        const r = await post("/invitations", b);
        tab = "invitations";
        await render("members");
        setTimeout(() => {
          const link = location.origin + r.path;
          const o = modal(
            "邀请已创建",
            `<p class="small">发送给 ${E(b.email)}，对方完成注册后即可加入。</p><div class="code invite-link">${E(link)}</div><button type="button" class="primary" id="copy-invite">复制邀请链接</button>`,
            "关闭",
          );
          o.querySelector("#copy-invite").onclick = safe(async () => {
            await navigator.clipboard.writeText(link);
            toast("邀请链接已复制");
          });
        }, 0);
      },
    );
  }
  function editMember(member) {
    modal(
      "管理成员",
      field("name", "姓名", member.name) +
        field("email", "邮箱", member.email, "email") +
        `<div class="field"><label for="member-role">角色</label><select id="member-role" name="role"><option value="agent" ${member.role === "agent" ? "selected" : ""}>客服</option><option value="admin" ${member.role === "admin" ? "selected" : ""}>管理员</option></select></div><div class="field"><label for="member-active">状态</label><select id="member-active" name="active"><option value="1" ${member.active ? "selected" : ""}>启用</option><option value="0" ${!member.active ? "selected" : ""}>停用</option></select></div><p class="small">停用后会撤销登录，并将未结束会话退回待分配队列。</p>`,
      "保存",
      async (b) => {
        await patch("/members/" + member.id, {
          ...b,
          active: Number(b.active),
        });
        toast("成员已更新");
        await render("members");
      },
    );
  }
  function replyDialog(item) {
    modal(
      item ? "编辑快捷回复" : "新建快捷回复",
      field("title", "标题", item?.title || "") +
        field("category", "分类", item?.category || "通用") +
        `<div class="field"><label for="reply-body">回复内容</label><textarea id="reply-body" name="body" class="document-content" required maxlength="5000">${E(item?.body || "")}</textarea></div><p class="small">支持 {{visitor.name}} 和 {{agent.name}}，插入会话时自动替换。</p>`,
      "保存",
      async (b) => {
        await api(item ? "/quick-replies/" + item.id : "/quick-replies", {
          method: item ? "PATCH" : "POST",
          body: JSON.stringify(b),
        });
        toast("快捷回复已保存");
        render("replies");
      },
    );
  }
  function globalSearch() {
    const o = modal(
      "搜索与快速跳转",
      '<input id="global-query" aria-label="全局搜索" placeholder="搜索访客、历史消息、知识或配置…" autocomplete="off"><div id="global-results" class="global-results"></div>',
      "关闭",
    );
    let timer,
      revision = 0;
    const destinations =
      getMe().role === "admin"
        ? [
            ["inbox", "会话收件箱"],
            ["members", "团队成员"],
            ["teams", "接待团队"],
            ["reception", "自动接待"],
            ["knowledge", "知识库"],
            ["workflow", "工作流"],
            ["replies", "快捷回复"],
            ["tags", "标签管理"],
            ["audit", "操作记录"],
          ]
        : [
            ["inbox", "会话收件箱"],
            ["knowledge", "知识库"],
            ["replies", "快捷回复"],
          ];
    const drawNav = () => {
      o.querySelector("#global-results").innerHTML = destinations
        .map(
          ([id, label]) =>
            `<button type="button" class="search-result" data-nav="${id}"><strong>${label}</strong><span class="small">打开页面 →</span></button>`,
        )
        .join("");
      o.querySelectorAll("[data-nav]").forEach(
        (b) =>
          (b.onclick = () => {
            o.querySelector("[data-close]").click();
            navigate(b.dataset.nav);
          }),
      );
    };
    drawNav();
    o.querySelector("#global-query").oninput = (e) => {
      clearTimeout(timer);
      const q = e.target.value.trim(),
        rev = ++revision;
      if (q.length < 2) return drawNav();
      timer = setTimeout(
        safe(async () => {
          const r = await api("/global-search?q=" + encodeURIComponent(q));
          if (rev !== revision || !o.isConnected) return;
          o.querySelector("#global-results").innerHTML =
            [
              ...r.conversations.map(
                (c) =>
                  `<button type="button" class="search-result" data-conversation-result="${c.id}"><strong>${E(c.name)}</strong><span>${E(c.subject)}</span><span class="small">会话 · ${E(c.preview || "")}</span></button>`,
              ),
              ...r.resources.map(
                (item) =>
                  `<button type="button" class="search-result" data-resource-kind="${item.kind}"><strong>${E(item.name)}</strong><span class="small">${{ knowledge: "知识", agent: "智能体", workflow: "工作流", tool: "工具", channel: "渠道", model: "模型" }[item.kind]}</span></button>`,
              ),
            ].join("") ||
            empty("没有找到结果", "试试访客姓名、订单号或知识标题。");
          o.querySelectorAll("[data-conversation-result]").forEach(
            (b) =>
              (b.onclick = () => {
                o.querySelector("[data-close]").click();
                openConversation(b.dataset.conversationResult);
              }),
          );
          o.querySelectorAll("[data-resource-kind]").forEach(
            (b) =>
              (b.onclick = () => {
                o.querySelector("[data-close]").click();
                navigate(b.dataset.resourceKind);
              }),
          );
        }),
        220,
      );
    };
    o.addEventListener("dialogclose", () => clearTimeout(timer));
  }
  return { render, globalSearch };
}
