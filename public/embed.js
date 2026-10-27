(() => {
  const script = document.currentScript;
  if (!script || !script.dataset.appKey) return;
  const base = new URL(script.src),
    key = script.dataset.appKey;
  const box = document.createElement("div");
  // The host page's CSS must not move or hide the launcher.
  for (const [name, value] of Object.entries({
    position: "fixed",
    right: "20px",
    bottom: "20px",
    width: "56px",
    height: "56px",
    "z-index": "2147483000",
    overflow: "visible",
    "pointer-events": "auto",
  }))
    box.style.setProperty(name, value, "important");
  const root = box.attachShadow({ mode: "open" });
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.style.cssText =
    "display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:56px;height:56px;padding:0;border:0;border-radius:50%;background:#5b4ee8;color:#fff;cursor:pointer;box-shadow:0 6px 22px #0003;outline-offset:3px";
  const frame = document.createElement("iframe");
  const url = new URL("/widget", base);
  url.searchParams.set("appKey", key);
  frame.src = url.href;
  frame.hidden = true;
  frame.style.cssText =
    "position:absolute;display:none;bottom:68px;right:0;box-sizing:border-box;width:min(420px,calc(100vw - 40px));height:min(680px,calc(100vh - 110px));border:0;border-radius:16px;box-shadow:0 8px 40px #0003;background:#fff";
  const error = document.createElement("div");
  error.hidden = true;
  error.style.cssText =
    "position:absolute;display:none;bottom:68px;right:0;box-sizing:border-box;width:min(320px,calc(100vw - 40px));padding:18px;border-radius:12px;background:#fff;color:#242531;box-shadow:0 8px 40px #0003;font:14px/1.5 system-ui,sans-serif";
  const message = document.createElement("p");
  message.style.cssText = "margin:0 0 12px";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.style.cssText =
    "border:1px solid #d5d7e0;border-radius:8px;background:#fff;color:#242531;padding:8px 12px;cursor:pointer;font:inherit";
  error.append(message, retry);
  root.append(frame, error, button);
  let config = {},
    unavailable = false,
    opened = false,
    loading = false;
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  const host = () => {
    const html = document.documentElement,
      styles = getComputedStyle(html);
    let visitor = {};
    try {
      visitor = JSON.parse(script.dataset.visitor || "{}");
    } catch {}
    if (!visitor || typeof visitor !== "object" || Array.isArray(visitor))
      visitor = {};
    if (script.dataset.email) visitor.email = script.dataset.email;
    return {
      visitor,
      type: "fastcat:appearance",
      language: script.dataset.language || html.lang || navigator.language,
      theme:
        script.dataset.theme ||
        html.dataset.theme ||
        (html.classList.contains("dark")
          ? "dark"
          : html.classList.contains("light")
            ? "light"
            : styles.colorScheme === "dark"
              ? "dark"
              : styles.colorScheme === "light"
                ? "light"
                : systemTheme.matches
                  ? "dark"
                  : "light"),
    };
  };
  const svg = (path, fill = false) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", "26");
    s.setAttribute("height", "26");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("fill", fill ? "currentColor" : "none");
    s.setAttribute("stroke", fill ? "none" : "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", path);
    s.append(p);
    return s;
  };
  const defaultIcon = () => svg("M7 4h11v3H10v4h7v3h-7v6H7z", true);
  const drawIcon = () => {
    if (opened) {
      button.replaceChildren(svg("M5 5l14 14M19 5L5 19"));
      return;
    }
    if (!config.launcherIconUrl) {
      button.replaceChildren(defaultIcon());
      return;
    }
    const image = document.createElement("img");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.style.cssText =
      "display:block;width:32px;height:32px;object-fit:contain;border-radius:6px";
    image.onerror = () => {
      if (!opened && image.parentNode === button)
        button.replaceChildren(defaultIcon());
    };
    image.src = config.launcherIconUrl;
    button.replaceChildren(image);
  };
  const sync = () => {
    const h = host(),
      en = /^en(?:-|$)/i.test(
        config.language && config.language !== "auto"
          ? config.language
          : h.language,
      );
    const label = opened
      ? en
        ? "Close support"
        : "\u5173\u95ed\u5ba2\u670d"
      : en
        ? "Contact support"
        : "\u8054\u7cfb\u5ba2\u670d";
    button.setAttribute("aria-label", label);
    button.title = label;
    frame.title = en ? "Support" : "\u5728\u7ebf\u5ba2\u670d";
    message.textContent = en
      ? "Support is unavailable. Check your connection or contact the website administrator."
      : "\u5ba2\u670d\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u6216\u8054\u7cfb\u7f51\u7ad9\u7ba1\u7406\u5458\u3002";
    retry.textContent = loading
      ? en
        ? "Connecting..."
        : "\u6b63\u5728\u8fde\u63a5\u2026"
      : en
        ? "Retry"
        : "\u91cd\u8bd5";
    retry.disabled = loading;
    frame.hidden = !opened || unavailable;
    frame.style.display = frame.hidden ? "none" : "block";
    error.hidden = !opened || !unavailable;
    error.style.display = error.hidden ? "none" : "block";
    frame.contentWindow?.postMessage(h, base.origin);
    const color = config.themeColor;
    if (/^#[0-9a-f]{6}$/i.test(color || "")) {
      const rgb = [1, 3, 5]
        .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
        .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
      button.style.background = color;
      button.style.color =
        0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.179
          ? "#000"
          : "#fff";
    }
    button.setAttribute("aria-expanded", String(opened));
    drawIcon();
  };
  const configure = async () => {
    if (loading) return;
    loading = true;
    sync();
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(
        new URL("/api/widget/config?appKey=" + encodeURIComponent(key), base),
        { credentials: "omit", signal: controller.signal },
      );
      if (!response.ok) throw Error("configuration unavailable");
      const data = await response.json();
      config = data.widget || {};
      unavailable = false;
      const position = config.position || "bottom-right",
        top = position.startsWith("top"),
        left = position.endsWith("left");
      for (const [name, value] of Object.entries({
        right: left ? "auto" : "20px",
        left: left ? "20px" : "auto",
        top: top ? "20px" : "auto",
        bottom: top ? "auto" : "20px",
      }))
        box.style.setProperty(name, value, "important");
      for (const element of [frame, error]) {
        element.style.top = top ? "68px" : "auto";
        element.style.bottom = top ? "auto" : "68px";
        element.style.left = left ? "0" : "auto";
        element.style.right = left ? "auto" : "0";
      }
    } catch {
      unavailable = true;
    } finally {
      clearTimeout(timeout);
      loading = false;
      sync();
    }
  };
  frame.addEventListener("load", sync);
  window.addEventListener("message", (event) => {
    if (
      event.source === frame.contentWindow &&
      event.origin === base.origin &&
      event.data?.type === "fastcat:ready"
    )
      sync();
  });
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["lang", "class", "style", "data-theme"],
  });
  new MutationObserver(sync).observe(script, {
    attributes: true,
    attributeFilter: [
      "data-language",
      "data-theme",
      "data-email",
      "data-visitor",
    ],
  });
  systemTheme.addEventListener("change", sync);
  window.addEventListener("languagechange", sync);
  button.onclick = () => {
    opened = !opened;
    sync();
  };
  retry.onclick = configure;
  const mount = () => {
    if (!box.isConnected) document.body.append(box);
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
  sync();
  configure();
})();
