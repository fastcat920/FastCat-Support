export async function renderOperations(el, { api, E, toast }, section) {
  const safe = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    }
  };
  const post = (path, value = {}) =>
    api(path, { method: "POST", body: JSON.stringify(value) });
  const redraw = () => renderOperations(el, { api, E, toast }, section);
  if (section === "operations") {
    const s = await api("/operations/status");
    const states = (q) =>
      q.states.map((r) => `${E(r.state)} ${r.count}`).join(" · ") || "无任务";
    el.innerHTML = `<h2>运行状态</h2><p class="small">版本 ${E(s.version)} · ${E(s.revision.slice(0, 12))} · 端口 ${s.port} · 运行 ${Math.floor(s.uptimeSeconds / 60)} 分钟</p><div class="grid"><article class="card"><h3>数据库</h3><p>${s.database.ready ? "可读写" : "未就绪"} · ${E(s.database.journalMode)}</p></article><article class="card"><h3>推送通道</h3><p>客服 APNs：${s.push.staff.apns ? "已配置" : "未配置"}</p><p>用户 APNs：${s.push.user.apns ? "已配置" : "未配置"} · FCM：${s.push.user.fcm ? "已配置" : "未配置"}</p><p class="small">已配置表示配置项存在，实际送达请结合失败记录检查。</p></article></div><h3>推送任务</h3><p>客服：${states(s.push.staffQueue)} · 待入队 ${s.push.staffQueue.events}</p><p>用户：${states(s.push.userQueue)} · 待入队 ${s.push.userQueue.events}</p>${[...s.push.staffQueue.failures, ...s.push.userQueue.failures].map((f) => `<p class="small">${E(f.reason || "未知错误")} · ${f.count}</p>`).join("")}<h3>客服在线状态</h3>${s.agents.map((a) => `<p>${E(a.name)} · ${a.online ? "连接在线" : "连接离线"} · ${E({ available: "接待中", away: "忙碌", offline: "离线" }[a.availability])} · 容量 ${a.capacity}</p>`).join("")}<h3>最近运行事件</h3>${s.recentEvents.map((r) => `<p class="small">${E(r.created)} · ${E(r.event)} · ${E(r.status)}</p>`).join("") || "<p>暂无事件</p>"}<button id="ops-refresh">刷新状态</button>`;
    el.querySelector("#ops-refresh").onclick = safe(redraw);
    return;
  }
  if (section === "backups") {
    const s = await api("/operations/status"),
      b = s.backups;
    el.innerHTML = `<h2>备份与恢复验证</h2><p>每 24 小时自动备份，默认保留最近 7 份；每份备份创建时执行数据库及文件校验。</p><p class="small">备份包含敏感密钥，请另行同步到安全的异机存储。校验通过不代表已完成服务器切换演练。</p><p class="${b.lastResult?.status === "failed" ? "danger" : ""}">最近任务：${b.lastResult ? E(b.lastResult.status) + " · " + E(b.lastResult.created) : "尚未执行"}</p><button class="primary" id="backup-now" ${b.busy ? "disabled" : ""}>${b.busy ? "正在备份…" : "立即备份并校验"}</button>${b.items.map((r) => `<article class="card"><p>${E(r.created)}</p><p class="small">校验时间 ${E(r.verified || "未校验")} · 密钥文件 ${r.credentials} 个</p><button data-verify="${E(r.id)}">重新校验</button></article>`).join("")}<details><summary>恢复操作</summary><p>在服务器使用项目内 restore-backup.mjs，将备份恢复到一个全新目录。确认完整性、密钥及环境变量后，停服切换 DB_PATH，再启动并检查就绪状态。恢复工具不会覆盖现有数据库。</p></details>`;
    el.querySelector("#backup-now").onclick = safe(async () => {
      const button = el.querySelector("#backup-now");
      button.disabled = true;
      try {
        await post("/operations/backups");
        toast("备份和校验完成");
      } finally {
        await redraw();
      }
    });
    el.querySelectorAll("[data-verify]").forEach(
      (b) =>
        (b.onclick = safe(async () => {
          b.disabled = true;
          try {
            await post("/operations/backups/" + b.dataset.verify + "/verify");
            toast("备份校验通过");
          } finally {
            b.disabled = false;
          }
        })),
    );
    return;
  }
  if (section === "quality") {
    el.innerHTML = `<h2>服务质量</h2><label>统计范围<select id="metrics-days"><option value="7">最近 7 天</option><option value="30" selected>最近 30 天</option><option value="90">最近 90 天</option></select></label><div id="metrics-content" aria-live="polite"></div>`;
    const draw = async () => {
      const m = await api(
        "/operations/metrics?days=" + el.querySelector("#metrics-days").value,
      );
      el.querySelector("#metrics-content").innerHTML =
        `<div class="grid"><article class="card"><h3>会话 ${m.totalConversations}</h3><p>人工接待事件 ${m.handoffs} 个会话</p></article><article class="card"><h3>首次回复</h3><p>${m.firstReply.seconds == null ? "暂无样本" : Math.round(m.firstReply.seconds) + " 秒"} · ${m.firstReply.samples} 个样本</p><p class="small">首次人工回复 ${m.firstHumanReply.seconds == null ? "暂无样本" : Math.round(m.firstHumanReply.seconds) + " 秒"}</p></article><article class="card"><h3>当前等待 ${m.waiting.count}</h3><p>最长等待 ${Math.floor(m.waiting.oldestSeconds / 60)} 分钟</p></article><article class="card"><h3>登记解决率 ${m.outcomes.resolutionRate == null ? "暂无登记" : Math.round(m.outcomes.resolutionRate * 100) + "%"}</h3><p>已登记 ${m.outcomes.recorded}，已解决 ${m.outcomes.resolved}</p></article></div><h3>AI 转人工率 ${m.aiHandoff.rate == null ? "暂无样本" : Math.round(m.aiHandoff.rate * 100) + "%"}</h3><p>本期新建且有 AI 接待记录的会话 ${m.aiHandoff.total}，其中 AI 接待后转人工 ${m.aiHandoff.transferred}。</p><h3>AI 使用量</h3><p>请求 ${m.ai.requests} · 输入 ${m.ai.inputTokens} Token · 输出 ${m.ai.outputTokens} Token</p><p>${!m.ai.costByCurrency.length ? "未配置价格，暂无法统计费用" : m.ai.costByCurrency.map((c) => E(c.currency || "未标注币种") + " " + E(c.cost)).join(" · ")} · 已计价 ${m.ai.pricedRequests} / ${m.ai.requests}</p><p class="small">解决率来自客服手工登记，不等同用户满意度。回复时间及 AI 转人工率按本期新建会话统计，自动分配人工不计入 AI 转人工。人工接待事件按本期事件去重统计。费用只反映已有价格记录。</p>`;
    };
    el.querySelector("#metrics-days").onchange = safe(draw);
    await draw();
    return;
  }
  const rows = (await api("/operations/knowledge-candidates")).items;
  el.innerHTML = `<h2>知识改进待审核</h2><p class="small">会话中提交的内容经管理员编辑和审核后，才加入知识库。</p>${rows.map((r) => `<article class="card" data-candidate="${E(r.id)}"><p>${E({ pending: "待审核", approved: "已通过", rejected: "已拒绝" }[r.state])} · ${E(r.created)}</p><label>问题<textarea name="question" maxlength="2000" ${r.state !== "pending" ? "disabled" : ""}>${E(r.question)}</textarea></label><label>答案<textarea name="answer" rows="4" maxlength="12000" ${r.state !== "pending" ? "disabled" : ""}>${E(r.answer)}</textarea></label>${r.state === "pending" ? '<div class="row"><button class="primary" data-approve>审核并加入默认知识库</button><button data-reject>拒绝</button></div>' : ""}</article>`).join("") || "<p>暂无待审核条目</p>"}`;
  el.querySelectorAll("[data-candidate]").forEach((card) => {
    const review = (action) =>
      safe(async () => {
        await post(
          "/operations/knowledge-candidates/" + card.dataset.candidate,
          {
            action,
            question: card.querySelector('[name="question"]').value,
            answer: card.querySelector('[name="answer"]').value,
          },
        );
        toast("审核已保存");
        await redraw();
      });
    card
      .querySelector("[data-approve]")
      ?.addEventListener("click", review("approve"));
    card
      .querySelector("[data-reject]")
      ?.addEventListener("click", review("reject"));
  });
}
