export function createSettingsUI({
  api,
  E,
  toast,
  getMe,
  navigate,
  notifications,
  onProfile,
}) {
  let section = "profile";
  const safe = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    }
  };
  async function render() {
    const me = getMe();
    const tabs = [
      ["profile", "个人资料"],
      ["general", "通用"],
      ["notifications", "消息通知"],
      ["about", "关于"],
    ];
    document.querySelector("#view").innerHTML =
      `<div class="content"><div class="page-heading"><h1>设置</h1></div><div class="tabs">${tabs.map(([id, name]) => `<button data-settings="${id}" class="${id === section ? "active" : ""}">${name}</button>`).join("")}</div><section id="settings-panel" class="panel"></section></div>`;
    document.querySelectorAll("[data-settings]").forEach(
      (b) =>
        (b.onclick = safe(async () => {
          if (["members", "model", "extensions"].includes(b.dataset.settings))
            navigate(b.dataset.settings);
          else {
            section = b.dataset.settings;
            await render();
          }
        })),
    );
    const el = document.querySelector("#settings-panel");
    if (section === "profile") {
      el.innerHTML = `<h2>个人资料</h2><p>${E(me.email)} · ${me.role === "admin" ? "管理员" : "客服"}</p><form><div class="profile-avatar"><div class="avatar">${me.avatar ? `<img src="/api/profile/avatar" alt="个人头像">` : E(me.name[0])}</div><label>上传头像<input id="profile-avatar" type="file" accept="image/png,image/jpeg,image/webp"></label><span class="small">自动裁切为正方形，最大 5 MB</span></div><div class="field"><label>姓名<input name="name" maxlength="100" required value="${E(me.name)}"></label></div><button class="primary">保存资料</button></form><h3>接待服务状态</h3><p>暂停接待不影响已有会话。</p><button id="toggle-reception">${me.availability === "offline" ? "恢复接待" : "暂停接待"}</button>`;
      let avatar = me.avatar || "";
      el.querySelector("#profile-avatar").onchange = safe(async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (
          file.size > 5 * 1024 * 1024 ||
          !["image/png", "image/jpeg", "image/webp"].includes(file.type)
        )
          throw Error("请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片");
        const image = await createImageBitmap(file);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 192;
        const side = Math.min(image.width, image.height);
        canvas
          .getContext("2d")
          .drawImage(
            image,
            (image.width - side) / 2,
            (image.height - side) / 2,
            side,
            side,
            0,
            0,
            192,
            192,
          );
        image.close();
        avatar = canvas.toDataURL("image/webp", 0.85);
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/webp", 0.85),
        );
        const previewURL = URL.createObjectURL(blob);
        const preview = document.createElement("img");
        preview.alt = "个人头像预览";
        preview.src = previewURL;
        preview.onload = preview.onerror = () =>
          URL.revokeObjectURL(previewURL);
        el.querySelector(".profile-avatar .avatar").replaceChildren(preview);
      });
      el.querySelector("form").onsubmit = async (e) => {
        e.preventDefault();
        await safe(async () => {
          const result = await api("/profile", {
            method: "PUT",
            body: JSON.stringify({
              name: e.target.elements.name.value,
              avatar,
            }),
          });
          await onProfile(result);
          toast("资料已保存");
        })();
      };
      el.querySelector("#toggle-reception").onclick = safe(async () => {
        const availability =
          me.availability === "offline" ? "available" : "offline";
        await api("/presence", {
          method: "PATCH",
          body: JSON.stringify({ availability }),
        });
        await onProfile({ ...me, availability });
        toast("接待状态已更新");
      });
    }
    if (section === "general") {
      const p = await api("/preferences");
      el.innerHTML = `<h2>通用</h2><div class="field"><label>主题模式<select id="settings-theme"><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label></div><p class="small">主题偏好随账号保存。当前界面语言：简体中文。</p>`;
      el.querySelector("select").value = p.theme;
      el.querySelector("select").onchange = safe(async () => {
        await notifications.save({ theme: el.querySelector("select").value });
        toast("主题已保存");
      });
    }
    if (section === "notifications") {
      const p = await api("/preferences");
      el.innerHTML = `<h2>消息通知</h2><p id="notification-permission">浏览器权限：${E({ granted: "已授权", denied: "已拒绝", default: "未授权", unsupported: "浏览器不支持" }[notifications.permission()])}</p><button id="request-notifications">申请桌面通知权限</button><form>${[
        ["notificationEnabled", "桌面通知"],
        ["notificationSound", "声音通知"],
        ["notifyOnBackground", "页面在后台时提醒"],
        ["notifyOnOtherConversation", "其他会话消息提醒"],
        ["notifyOnNewVisitor", "新访客首次咨询提醒"],
        ["notificationPreview", "在系统通知中显示消息预览"],
      ]
        .map(
          ([k, label]) =>
            `<label class="retrieval-checkbox"><input type="checkbox" name="${k}" ${p[k] ? "checked" : ""}>${label}</label>`,
        )
        .join(
          "",
        )}<p class="small">前台正在查看的会话不重复提醒；自己发送及系统消息不提醒。声音需浏览器允许播放；关闭页面后不提供离线推送。预览默认关闭。</p><button class="primary">保存通知设置</button><button type="button" id="test-notifications">测试通知</button></form>`;
      el.querySelector("#request-notifications").onclick = safe(async () => {
        const permission = await notifications.request();
        el.querySelector("#notification-permission").textContent =
          "浏览器权限：" + permission;
      });
      el.querySelector("#test-notifications").onclick = () =>
        notifications.test();
      el.querySelector("form").onsubmit = async (e) => {
        e.preventDefault();
        await safe(async () => {
          const values = {};
          el.querySelectorAll("input").forEach(
            (i) => (values[i.name] = i.checked),
          );
          const saved = await notifications.save(values, {
            expectedRevision: p.revision,
          });
          p.revision = saved.revision;
          toast("通知设置已保存");
        })();
      };
    }
    if (section === "about")
      el.innerHTML =
        "<h2>FastCat Support</h2><p>版本 0.16.0</p><p>独立客服工作空间</p>";
  }
  return { render };
}
