export function createAgentEditor({ api, E, modal, toast, onSaved }) {
  const safe = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    }
  };
  return async function edit(existing, { duplicate = false } = {}) {
    const [models, collections, tools, workflows, agents, defaults, devices] =
      await Promise.all([
        api("/ai/models"),
        api("/knowledge/collections"),
        api("/resources?kind=tool"),
        api("/resources?kind=workflow"),
        api("/resources?kind=agent"),
        api("/ai/defaults"),
        api("/devices"),
      ]);
    const c = existing?.config || {},
      selectedCollections = new Set(
        c.collectionIds || (c.collectionId ? [c.collectionId] : []),
      ),
      selectedWorkflows = new Set(c.workflowIds || []),
      bindings = structuredClone(c.toolBindings || []);
    const available = models.filter(
      (m) => m.enabled && m.provider_enabled && m.model_type === "chat",
    );
    const initial = existing
      ? available.find(
          (m) => m.provider_id === c.providerId && m.model === c.model,
        )?.id || (!c.providerId && !c.model ? defaults.chat_id : "")
      : defaults.chat_id;
    const field = (name, label, value = "", type = "text") =>
      `<div class="field"><label>${label}<input name="${name}" type="${type}" value="${E(value)}" required></label></div>`;
    const check = (name, label, value) =>
      `<label class="retrieval-checkbox"><input name="${name}" type="checkbox" ${value ? "checked" : ""}>${label}</label>`;
    const o = modal(
      duplicate ? "复制智能体" : existing ? "编辑智能体" : "创建智能体",
      `
   <section class="agent-editor-section"><h3>基本信息</h3><div class="service-form-grid">${field("name", "名称", duplicate ? `${existing.name} 副本` : existing?.name || "")}${field("profession", "职业/角色", c.profession || "")}</div></section>
   <section class="agent-editor-section"><h3>模型配置</h3><div class="field"><label>对话模型<select name="modelId" required><option value="">${available.length ? "请选择模型" : "暂无可用模型，请先到模型管理添加"}</option>${available.map((m) => `<option value="${m.id}" ${m.id === initial ? "selected" : ""}>${E(m.name)} · ${E(m.provider_name)}</option>`).join("")}</select></label></div><p class="small">新建时预选工作空间默认模型。保存后绑定具体模型，后续默认设置变化不会自动替换。</p></section>
   <section class="agent-editor-section"><h3>能力描述</h3><div class="field"><label>详细提示词/服务指令<textarea name="description" rows="5" required>${E(existing?.description || "")}</textarea></label></div></section>
   <details class="agent-editor-section"><summary>高级配置</summary>${check("markdown", "使用 Markdown 格式回答", c.markdown ?? false)}${check("skillsEnabled", "启用 Skills 自动发现与读取", c.skillsEnabled ?? false)}${check("addDatetime", "在上下文中添加当前日期时间", c.addDatetime ?? false)}<div class="service-form-grid">${field("historyRuns", "历史会话轮数（0–20）", c.historyRuns ?? 15, "number")}${field("toolCallLimit", "工具调用总次数（1–50）", c.toolCallLimit ?? 16, "number")}${field("maxToolRounds", "模型调用轮数（含最终回答，1–5）", c.maxToolRounds ?? 3, "number")}</div><details><summary>多智能体协作（可选扩展）</summary>${check("collaborationEnabled", "启用协作", c.collaboration?.enabled)}<div class="field"><label>协作成员（2–4 位）<select name="members" multiple size="4">${agents
     .filter((a) => a.id !== existing?.id && !a.config.collaboration?.enabled)
     .map(
       (a) =>
         `<option value="${a.id}" ${c.collaboration?.memberIds?.includes(a.id) ? "selected" : ""}>${E(a.name)}</option>`,
     )
     .join(
       "",
     )}</select></label></div>${field("rounds", "讨论轮数（1–3）", c.collaboration?.rounds || 1, "number")}</details></details>
   <section class="agent-editor-section"><h3>资源关联</h3><h4>绑定设备</h4><div class="field"><label>设备<select name="boundDeviceId"><option value="">不绑定设备</option>${devices.map((d) => `<option value="${d.id}" ${c.boundDeviceId === d.id ? "selected" : ""} ${d.enabled ? "" : "disabled"}>${E(d.name)} · ${d.status === "online" ? "在线" : "离线"}</option>`).join("")}</select></label></div><p class="small">仅绑定设备声明的操作可用。启用截图会向所选模型发送屏幕内容；控制操作需设备本地显式授权。</p><h4>知识库</h4><div class="field"><label>知识范围<select name="knowledgeScope"><option value="none">不使用知识库</option><option value="selected">仅使用所选知识库</option><option value="all">使用全部知识库（含以后新增）</option></select></label></div><div id="agent-collections"></div><button type="button" id="choose-agent-collections">选择知识库</button><h4>工具操作</h4><div id="agent-tools"></div><button type="button" id="choose-agent-tools">绑定工具操作</button><p class="small">仅授权选中的操作，不自动重试远程操作。</p><h4>工作流</h4><div id="agent-workflows"></div><button type="button" id="choose-agent-workflows">选择工作流</button><p class="small">模型可主动调用绑定工作流的已发布版本；未发布的工作流不能执行。最多嵌套 3 层，禁止循环调用。</p></section><p id="agent-form-error" class="error" role="alert"></p><button type="reset" id="reset-agent-form">重置</button>`,
      existing && !duplicate ? "保存" : "创建智能体",
      async (b) => {
        const chosen = available.find((m) => m.id === b.modelId);
        if (!chosen) throw Error("请选择可用的对话模型");
        if (b.knowledgeScope === "selected" && !selectedCollections.size)
          throw Error("请至少选择一个知识库");
        const config = {
          ...c,
          profession: b.profession.trim(),
          providerId: chosen.provider_id,
          model: chosen.model,
          knowledgeScope: b.knowledgeScope,
          collectionIds:
            b.knowledgeScope === "selected" ? [...selectedCollections] : [],
          workflowIds: [...selectedWorkflows],
          toolBindings: bindings,
          skillsEnabled: !!b.skillsEnabled,
          boundDeviceId: b.boundDeviceId || null,
          markdown: !!b.markdown,
          addDatetime: !!b.addDatetime,
          historyRuns: Number(b.historyRuns),
          toolCallLimit: Number(b.toolCallLimit),
          maxToolRounds: Number(b.maxToolRounds),
          collaboration: {
            enabled: !!b.collaborationEnabled,
            memberIds: [
              ...o.querySelector("[name=members]").selectedOptions,
            ].map((x) => x.value),
            rounds: Number(b.rounds),
          },
        };
        delete config.collectionId;
        try {
          await api(
            existing && !duplicate ? "/resources/" + existing.id : "/resources",
            {
              method: existing && !duplicate ? "PATCH" : "POST",
              body: JSON.stringify({
                kind: "agent",
                name: b.name.trim(),
                description: b.description.trim(),
                config,
              }),
            },
          );
          toast("智能体已保存");
          await onSaved();
        } catch (e) {
          o.querySelector("#agent-form-error").textContent = e.message;
          throw e;
        }
      },
    );
    o.classList.add("agent-editor");
    const form = o.querySelector("form");
    form.elements.name.maxLength = 200;
    form.elements.profession.maxLength = 100;
    form.elements.description.maxLength = 10000;
    form.elements.knowledgeScope.value =
      c.knowledgeScope ||
      (existing ? (selectedCollections.size ? "selected" : "all") : "none");
    for (const [name, min, max] of [
      ["historyRuns", 0, 20],
      ["toolCallLimit", 1, 50],
      ["maxToolRounds", 1, 5],
      ["rounds", 1, 3],
    ]) {
      form.elements[name].min = min;
      form.elements[name].max = max;
    }
    const show = (target, selected, items) => {
      const box = o.querySelector(target);
      box.replaceChildren();
      if (!selected.size) box.textContent = "尚未关联";
      for (const id of selected) {
        const row = document.createElement("div");
        row.className = "row";
        const text = document.createElement("span");
        text.textContent = items.find((x) => x.id === id)?.name || "资源已移除";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "移除";
        remove.setAttribute("aria-label", "移除 " + text.textContent);
        remove.onclick = () => {
          selected.delete(id);
          draw();
        };
        row.append(text, remove);
        box.append(row);
      }
    };
    function draw() {
      show("#agent-collections", selectedCollections, collections);
      show("#agent-workflows", selectedWorkflows, workflows);
      const box = o.querySelector("#agent-tools");
      box.replaceChildren();
      if (!bindings.length) box.textContent = "尚未授权工具操作";
      bindings.forEach((b, i) => {
        const row = document.createElement("div");
        row.className = "row";
        const text = document.createElement("span");
        text.textContent =
          (tools.find((t) => t.id === b.resourceId)?.name || "已移除服务") +
          " / " +
          b.name;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "移除";
        remove.onclick = () => {
          bindings.splice(i, 1);
          draw();
        };
        row.append(text, remove);
        box.append(row);
      });
    }
    function select(title, items, selection, after) {
      const draft = new Set(selection);
      const picker = modal(
        title,
        `<div class="field"><label>搜索<input name="search"></label></div><div id="resource-options"></div>`,
        "确定",
        async () => {
          selection.clear();
          draft.forEach((id) => selection.add(id));
          after?.();
          draw();
        },
      );
      const input = picker.querySelector("input");
      const render = () => {
        const list = picker.querySelector("#resource-options");
        list.replaceChildren();
        for (const item of items.filter((x) =>
          x.name.toLowerCase().includes(input.value.toLowerCase()),
        )) {
          const label = document.createElement("label");
          label.className = "retrieval-checkbox";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = draft.has(item.id);
          cb.onchange = () =>
            cb.checked ? draft.add(item.id) : draft.delete(item.id);
          label.append(cb, document.createTextNode(item.name));
          list.append(label);
        }
        if (!list.childNodes.length) list.textContent = "没有可选资源";
      };
      input.oninput = render;
      render();
    }
    o.querySelector("#choose-agent-collections").onclick = () =>
      select("选择知识库", collections, selectedCollections, () => {
        form.elements.knowledgeScope.value = selectedCollections.size
          ? "selected"
          : "none";
      });
    o.querySelector("#choose-agent-workflows").onclick = () =>
      select("选择工作流", workflows, selectedWorkflows);
    o.querySelector("#choose-agent-tools").onclick = () => {
      let discovered = "",
        operations = [];
      const picker = modal(
        "绑定工具操作",
        `<div class="field"><label>工具服务<select name="resource">${tools.map((t) => `<option value="${t.id}">${E(t.name)}</option>`).join("")}</select></label></div><button type="button" id="discover-tool">发现操作</button><div class="field"><label>工具操作<select name="operation"></select></label></div><p id="operation-status" role="status"></p>`,
        "绑定",
        async (b) => {
          if (
            b.resource !== discovered ||
            !operations.some((t) => t.name === b.operation)
          )
            throw Error("请先发现并选择操作");
          if (bindings.length >= 16) throw Error("最多绑定 16 个工具操作");
          if (
            bindings.some(
              (t) => t.resourceId === b.resource && t.name === b.operation,
            )
          )
            throw Error("操作已绑定");
          bindings.push({ resourceId: b.resource, name: b.operation });
          draw();
        },
      );
      picker.querySelector("#discover-tool").onclick = safe(async () => {
        const button = picker.querySelector("#discover-tool");
        button.disabled = true;
        try {
          const id = picker.querySelector("[name=resource]").value;
          if (!id) throw Error("请先创建工具服务");
          operations = (
            await api("/tools/" + id + "/discover", { method: "POST" })
          ).tools;
          discovered = id;
          picker.querySelector("[name=operation]").innerHTML = operations
            .map((t) => `<option value="${E(t.name)}">${E(t.name)}</option>`)
            .join("");
          picker.querySelector("#operation-status").textContent =
            `发现 ${operations.length} 个操作`;
        } finally {
          button.disabled = false;
        }
      });
    };
    form.addEventListener(
      "invalid",
      (e) => {
        o.querySelector("#agent-form-error").textContent =
          "请检查必填项和数值范围";
        const control = e.target;
        let details = control.closest("details");
        while (details) {
          details.open = true;
          details = details.parentElement.closest("details");
        }
        control.focus();
      },
      true,
    );
    const originalScope = form.elements.knowledgeScope.value;
    form.onreset = () => {
      selectedCollections.clear();
      (c.collectionIds || (c.collectionId ? [c.collectionId] : [])).forEach(
        (x) => selectedCollections.add(x),
      );
      selectedWorkflows.clear();
      (c.workflowIds || []).forEach((x) => selectedWorkflows.add(x));
      bindings.splice(
        0,
        bindings.length,
        ...structuredClone(c.toolBindings || []),
      );
      queueMicrotask(() => {
        form.elements.knowledgeScope.value = originalScope;
        o.querySelector("#agent-form-error").textContent = "";
        draw();
      });
    };
    draw();
  };
}
