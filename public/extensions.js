export function createExtensionsUI({ api, E, modal, toast }) {
  let tab = "skills";
  const safe = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    }
  };
  async function render() {
    const root = document.querySelector("#view");
    root.innerHTML = `<div class="content"><div class="page-heading"><div><h1>技能与设备</h1><p>管理智能体可读取的专业知识，以及显式绑定的设备。</p></div></div><div class="tabs"><button data-tab="skills">Skills</button><button data-tab="devices">设备</button></div><section class="panel" id="extensions-content"></section></div>`;
    root.querySelectorAll("[data-tab]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
      b.onclick = safe(async () => {
        tab = b.dataset.tab;
        await render();
      });
    });
    const el = root.querySelector("#extensions-content");
    if (tab === "skills") {
      const skills = await api("/skills");
      el.innerHTML = `<div class="row"><h2>项目 Skills</h2><button id="new-skill">创建技能</button><button id="import-skill">从 GitHub 导入 SKILL.md</button></div><p class="small">启用的技能供开启 Skills 的智能体自动发现、读取指令与参考文件。脚本以源文读取，不在服务器执行。公开导入默认停用，核对后启用。</p>${skills.map((s) => `<article class="card"><h3>${E(s.name)}</h3><p>${E(s.description)}</p><p class="small">${s.enabled ? "启用" : "停用"} · ${Object.keys(s.files).length} 个文件</p><button data-edit-skill="${s.id}">编辑</button><button data-toggle-skill="${s.id}">${s.enabled ? "停用" : "启用"}</button></article>`).join("") || "<p>尚无技能</p>"}`;
      el.querySelector("#new-skill").onclick = () => editSkill();
      el.querySelector("#import-skill").onclick = () =>
        modal(
          "从公开 GitHub 导入技能",
          '<div class="field"><label>目录或 SKILL.md 链接<input name="url" type="url" required></label></div><p class="small">只读取公开 SKILL.md，不读取私有凭据或执行代码；引用文件可在导入后补充。</p>',
          "导入",
          async (b) => {
            await api("/skills/import", {
              method: "POST",
              body: JSON.stringify(b),
            });
            toast("已导入，默认停用");
            await render();
          },
        );
      el.querySelectorAll("[data-edit-skill]").forEach(
        (b) =>
          (b.onclick = () =>
            editSkill(skills.find((s) => s.id === b.dataset.editSkill))),
      );
      el.querySelectorAll("[data-toggle-skill]").forEach(
        (b) =>
          (b.onclick = safe(async () => {
            const s = skills.find((s) => s.id === b.dataset.toggleSkill);
            await api("/skills/" + s.id, {
              method: "PUT",
              body: JSON.stringify({
                ...s,
                enabled: !s.enabled,
                expectedRevision: s.revision,
              }),
            });
            await render();
          })),
      );
    } else {
      const devices = await api("/devices");
      el.innerHTML = `<div class="row"><h2>设备管理</h2><button id="bind-device">生成绑定码</button><button id="refresh-devices">刷新</button></div><p class="small">本地代理需要你手动启动。默认仅截图，操作控制需显式添加 --allow-control，并授予操作系统相应权限。绑定智能体后，截图会发送至所选模型供应商。</p>${devices.map((d) => `<article class="card"><h3>${E(d.name)}</h3><p>${E(d.os)} · ${d.status === "online" ? "在线" : "离线"} · ${d.enabled ? "启用" : "已停用"}</p><p class="small">授权操作：${E(d.capabilities.join("、"))}</p><button data-edit-device="${d.id}">配置</button></article>`).join("") || "<p>暂无绑定设备</p>"}`;
      el.querySelector("#refresh-devices").onclick = render;
      el.querySelector("#bind-device").onclick = safe(async () => {
        const code = await api("/devices/bind-code", {
          method: "POST",
          body: "{}",
        });
        modal(
          "绑定设备",
          `<p>一次性绑定码（5 分钟内有效）：<strong>${E(code.code)}</strong></p><p>在需要绑定的设备上，从本项目目录运行：</p><pre class="code">node scripts/device-agent.mjs --server ${E(location.origin)} --code ${E(code.code)}</pre><p class="small">内置 macOS 驱动默认仅截图。需要点击、输入等操作时由本机操作者添加 --allow-control。其他系统可使用 --driver 指定本地适配器。凭据保存在本地 .fastcat-device.json（0600）。</p>`,
          "关闭",
        );
      });
      el.querySelectorAll("[data-edit-device]").forEach(
        (b) =>
          (b.onclick = () => {
            const d = devices.find((d) => d.id === b.dataset.editDevice);
            modal(
              "设备配置",
              `<div class="field"><label>名称<input name="name" value="${E(d.name)}" required></label></div><label class="retrieval-checkbox"><input name="enabled" type="checkbox" ${d.enabled ? "checked" : ""}>启用设备</label><p class="small">停用会撤销该设备连接并终止等待操作。已执行操作不能撤销，不会自动重试。</p>`,
              "保存",
              async (b) => {
                await api("/devices/" + d.id, {
                  method: "PUT",
                  body: JSON.stringify({
                    name: b.name,
                    enabled: !!b.enabled,
                    expectedRevision: d.revision,
                  }),
                });
                await render();
              },
            );
          }),
      );
    }
  }
  function editSkill(s) {
    modal(
      s ? "编辑技能" : "创建技能",
      `<div class="field"><label>名称<input name="name" value="${E(s?.name || "")}" pattern="[a-z0-9][a-z0-9_-]{0,79}" ${s ? "readonly" : ""} required></label></div><div class="field"><label>描述<input name="description" value="${E(s?.description || "")}" required></label></div><div class="field"><label>技能指令<textarea name="instructions" rows="7" required>${E(s?.instructions || "")}</textarea></label></div><details><summary>参考文件及脚本源文</summary><p class="small">JSON 对象，键使用 references/文件名 或 scripts/文件名，值为文本；最多 30 个文件。</p><textarea name="files" rows="5">${E(JSON.stringify(s?.files || {}, null, 2))}</textarea></details><label class="retrieval-checkbox"><input name="enabled" type="checkbox" ${s?.enabled ? "checked" : ""}>启用技能</label>`,
      "保存",
      async (b) => {
        let files;
        try {
          files = JSON.parse(b.files);
        } catch {
          throw Error("文件必须是有效 JSON 对象");
        }
        await api("/skills" + (s ? "/" + s.id : ""), {
          method: s ? "PUT" : "POST",
          body: JSON.stringify({
            ...b,
            files,
            tags: s?.tags || [],
            enabled: !!b.enabled,
            expectedRevision: s?.revision,
          }),
        });
        toast("技能已保存");
        await render();
      },
    );
  }
  return { render };
}
