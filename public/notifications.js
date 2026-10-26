export function notificationDecision(
  item,
  prefs,
  { hidden = false, active = null } = {},
) {
  if (
    item.newVisitor &&
    prefs.notifyOnNewVisitor &&
    (hidden || item.conversationId !== active)
  )
    return true;
  return hidden
    ? !!prefs.notifyOnBackground
    : item.conversationId !== active && !!prefs.notifyOnOtherConversation;
}
export function createNotifications({
  api,
  getMe,
  getActive,
  openConversation,
  toast,
}) {
  let prefs = {},
    cursor = 0,
    busy = false,
    again = false,
    owner = null,
    context,
    lastSound = 0;
  const supported = () => typeof Notification !== "undefined";
  const permission = () =>
    supported() ? Notification.permission : "unsupported";
  const applyTheme = (theme) => {
    localStorage.setItem("fc_theme", theme);
    document.documentElement.dataset.theme =
      theme === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;
  };
  const tone = async () => {
    if (!context) return false;
    try {
      await context.resume();
      const o = context.createOscillator(),
        g = context.createGain();
      o.connect(g);
      g.connect(context.destination);
      o.frequency.value = 659;
      g.gain.setValueAtTime(0.12, context.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
      o.start();
      o.stop(context.currentTime + 0.2);
      return true;
    } catch {
      return false;
    }
  };
  document.addEventListener(
    "pointerdown",
    () => {
      try {
        context ||= new (window.AudioContext || window.webkitAudioContext)();
        context.resume().catch(() => {});
      } catch {}
    },
    { once: true },
  );
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (prefs.theme === "system") applyTheme("system");
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "fc-preference-change")
      try {
        const data = JSON.parse(event.newValue);
        if (data.owner === owner && data.prefs.revision > prefs.revision) {
          prefs = data.prefs;
          applyTheme(prefs.theme);
        }
      } catch {}
  });
  const show = (item, test = false) => {
    if (prefs.notificationSound && Date.now() - lastSound > 1000) {
      lastSound = Date.now();
      tone();
    }
    if (!prefs.notificationEnabled || permission() !== "granted") return false;
    try {
      const n = new Notification(
        test ? "测试通知" : item.newVisitor ? "新访客咨询" : "收到访客消息",
        {
          body: test
            ? "通知连接正常"
            : prefs.notificationPreview
              ? String(item.body).slice(0, 100)
              : "点击查看会话",
          tag: "fc-message-" + item.conversationId,
          silent: true,
        },
      );
      n.onclick = () => {
        window.focus();
        if (!test) openConversation(item.conversationId);
        n.close();
      };
      setTimeout(() => n.close(), 5000);
      return true;
    } catch {
      return false;
    }
  };
  return {
    get preferences() {
      return prefs;
    },
    permission,
    applyTheme,
    async init() {
      owner = getMe()?.id;
      if (!owner) return;
      const current = owner;
      const [p, baseline] = await Promise.all([
        api("/preferences"),
        api("/notifications"),
      ]);
      if (getMe()?.id !== current) return;
      prefs = p;
      cursor = baseline.cursor;
      applyTheme(p.theme);
    },
    async save(changes, { expectedRevision } = {}) {
      const p = await api("/preferences");
      const result = await api("/preferences", {
        method: "PUT",
        body: JSON.stringify({
          ...p,
          ...changes,
          expectedRevision: expectedRevision ?? p.revision,
        }),
      });
      prefs = result;
      localStorage.setItem(
        "fc-preference-change",
        JSON.stringify({ owner, prefs }),
      );
      applyTheme(prefs.theme);
      return result;
    },
    async request() {
      if (!supported()) return "unsupported";
      return Notification.requestPermission();
    },
    async test() {
      const sent = show({ conversationId: "test" }, true);
      toast(
        sent
          ? "测试通知已发送"
          : permission() === "granted"
            ? "浏览器未能显示通知"
            : "桌面通知未授权；声音受浏览器播放策略限制",
      );
    },
    async poll() {
      if (busy) {
        again = true;
        return;
      }
      if (!owner || getMe()?.id !== owner) return;
      busy = true;
      const current = owner;
      try {
        do {
          again = false;
          const result = await api("/notifications?after=" + cursor);
          if (getMe()?.id !== current) return;
          for (const item of result.items) {
            if (
              !notificationDecision(item, prefs, {
                hidden: document.hidden,
                active: getActive(),
              })
            )
              continue;
            const key = "fc-notified-" + current;
            try {
              const seen = JSON.parse(localStorage.getItem(key) || "[]");
              if (seen.includes(item.id)) continue;
              seen.push(item.id);
              localStorage.setItem(key, JSON.stringify(seen.slice(-512)));
            } catch {}
            if (prefs.notificationEnabled && permission() !== "granted")
              toast(
                (item.newVisitor ? "新访客咨询" : "收到访客消息") +
                  " · " +
                  item.name,
              );
            show(item);
          }
          cursor = result.cursor;
          again ||= result.hasMore;
        } while (again);
      } catch {
      } finally {
        busy = false;
      }
    },
    close() {
      owner = null;
      cursor = 0;
      prefs = {};
    },
  };
}
