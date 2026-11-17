export async function renderPushSettings(el, { api, E, toast }) {
  const { channels } = await api("/push-config");
  const labels = {
    staff_apns: ["客服 APNs", "客服 iOS APP 接收访客消息"],
    user_apns: ["用户 APNs", "FastCat iOS 客户端接收客服回复"],
    user_fcm: ["用户 FCM", "FastCat Android 客户端接收客服回复"],
  };
  el.innerHTML = `<h2>推送配置</h2><p class="small">仅管理员可操作。后台配置保存后立即生效，优先于环境变量；私钥加密保存，不再回显。连接测试不向真实设备发通知，也不等同于真机送达测试。</p><div class="push-config-list">${channels
    .map((c) => {
      const fcm = c.channel === "user_fcm";
      const test = c.test
        ? `${c.test.state === "reachable" ? "服务可达（未验证送达）" : "测试失败"} · ${c.test.code} · ${new Date(c.test.checked).toLocaleString()}`
        : "尚未测试";
      return `<form class="card push-config-card" data-channel="${c.channel}"><h3>${labels[c.channel][0]}</h3><p>${labels[c.channel][1]}</p><p class="small">来源：${c.source === "database" ? "后台配置" : "环境变量"} · 生效状态：${!c.decryptable ? "凭据无法解密，请重新上传或检查主密钥" : c.configured ? "已启用且配置完整" : "未启用或配置不完整"}</p><label><input type="checkbox" name="enabled" ${c.enabled ? "checked" : ""}> 启用通道</label>${fcm ? `<p class="small">项目：${E(c.config.projectId || (c.source === "environment" ? "由服务器环境配置提供" : "未设置"))}<br>服务账号：${E(c.config.clientEmail || (c.source === "environment" ? "由服务器环境配置提供" : "未设置"))}</p>` : `<div class="push-config-fields"><label>Key ID<input name="keyId" maxlength="10" required value="${E(c.config.keyId || "")}" autocomplete="off"></label><label>Team ID<input name="teamId" maxlength="10" required value="${E(c.config.teamId || "")}" autocomplete="off"></label><label>APP Bundle ID<input name="topic" maxlength="200" required value="${E(c.config.topic || "")}" placeholder="com.fastcat.app" autocomplete="off"></label></div>`}<label>${fcm ? "上传 Firebase 管理员服务账号 JSON" : "上传 Apple APNs 私钥 .p8"}<input type="file" name="credential" accept="${fcm ? ".json,application/json" : ".p8,.pem"}"></label><p class="small">${c.hasCredential ? "已有凭据；留空保留后台已保存的凭据。环境变量切换为后台配置时需首次上传。" : "首次保存请上传凭据文件。"}</p><p class="small" data-test-status>${E(test)}</p><p class="error" data-error role="alert"></p><div class="row"><button class="primary" type="submit">保存并生效</button><button type="button" data-test ${!c.configured ? "disabled" : ""}>测试当前已生效配置</button>${c.source === "database" ? '<button type="button" data-reset>清除后台配置，恢复环境变量</button>' : ""}</div></form>`;
    })
    .join("")}</div>`;
  for (const form of el.querySelectorAll("[data-channel]")) {
    const c = channels.find((c) => c.channel === form.dataset.channel),
      path = "/push-config/" + c.channel;
    const busy = (value) =>
      form.querySelectorAll("button").forEach((b) => (b.disabled = value));
    const run = async (fn) => {
      form.querySelector("[data-error]").textContent = "";
      busy(true);
      try {
        await fn();
      } catch (error) {
        form.querySelector("[data-error]").textContent = error.message;
      } finally {
        busy(false);
        form.querySelector("[data-test]").disabled = !c.configured;
      }
    };
    const required = () => {
      for (const name of ["keyId", "teamId", "topic"])
        if (form.elements[name])
          form.elements[name].required = form.elements.enabled.checked;
    };
    form.elements.enabled.onchange = required;
    required();
    form.onsubmit = (event) => {
      event.preventDefault();
      run(async () => {
        const file = form.elements.credential.files[0];
        let credential;
        if (file) {
          if (file.size === 0) throw Error("凭据文件为空，请重新选择");
          if (file.size > (c.channel === "user_fcm" ? 65536 : 16384))
            throw Error("凭据文件过大，请检查选择的文件");
          credential = await file.text();
        }
        const payload = {
          expectedRevision: c.revision,
          enabled: form.elements.enabled.checked,
          ...(credential ? { credential } : {}),
        };
        if (c.channel !== "user_fcm")
          payload.config = {
            keyId: form.elements.keyId.value.trim(),
            teamId: form.elements.teamId.value.trim(),
            topic: form.elements.topic.value.trim(),
          };
        await api(path, { method: "PUT", body: JSON.stringify(payload) });
        form.elements.credential.value = "";
        toast("推送配置已保存并生效");
        await renderPushSettings(el, { api, E, toast });
      });
    };
    form.querySelector("[data-test]").onclick = () =>
      run(async () => {
        const result = await api(path + "/test", {
          method: "POST",
          body: "{}",
        });
        toast(
          result.state === "reachable"
            ? "服务可达；尚未验证设备送达"
            : "连接测试失败，请检查凭据和网络",
        );
        await renderPushSettings(el, { api, E, toast });
      });
    form.querySelector("[data-reset]")?.addEventListener("click", () =>
      run(async () => {
        if (!confirm("清除后台保存的凭据并恢复环境变量配置？")) return;
        await api(path, {
          method: "DELETE",
          body: JSON.stringify({ expectedRevision: c.revision }),
        });
        toast("已恢复环境变量配置");
        await renderPushSettings(el, { api, E, toast });
      }),
    );
  }
}
