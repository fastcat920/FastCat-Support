(() => {
  const script = document.currentScript;
  if (!script) return;
  const base = new URL(script.src),
    key = script.dataset.appKey;
  if (!key) return;
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;right:20px;bottom:20px;z-index:2147483000";
  const button = document.createElement("button");
  button.textContent = "联系客服";
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.style.cssText =
    "border:0;border-radius:24px;padding:14px 22px;background:#5b4ee8;color:white;cursor:pointer;font:15px system-ui";
  const frame = document.createElement("iframe");
  const url = new URL("/widget", base);
  url.searchParams.set("appKey", key);
  frame.src = url.href;
  frame.title = "在线客服";
  frame.hidden = true;
  frame.style.cssText =
    "display:none;width:min(420px,calc(100vw - 40px));height:min(680px,calc(100dvh - 110px));border:0;border-radius:16px;box-shadow:0 8px 40px #0003;margin-bottom:12px";
  button.onclick = () => {
    frame.hidden = !frame.hidden;
    frame.style.display = frame.hidden ? "none" : "block";
    button.textContent = frame.hidden ? "联系客服" : "关闭客服";
    button.setAttribute("aria-expanded", String(!frame.hidden));
  };
  fetch(new URL("/api/widget/config?appKey=" + encodeURIComponent(key), base), {
    credentials: "omit",
  })
    .then((r) => {
      if (!r.ok) throw Error("unavailable");
      return r.json();
    })
    .then((c) => {
      const w = c.widget || {};
      if (/^#[0-9a-f]{6}$/i.test(w.themeColor || "")) {
        const rgb = [1, 3, 5]
          .map((i) => parseInt(w.themeColor.slice(i, i + 2), 16) / 255)
          .map((n) =>
            n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4,
          );
        button.style.background = w.themeColor;
        button.style.color =
          0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.179
            ? "#000"
            : "#fff";
      }
      const position = w.position || "bottom-right";
      box.style.right = position.endsWith("right") ? "20px" : "auto";
      box.style.left = position.endsWith("left") ? "20px" : "auto";
      box.style.bottom = position.startsWith("bottom") ? "20px" : "auto";
      box.style.top = position.startsWith("top") ? "20px" : "auto";
      if (position.startsWith("top")) {
        box.replaceChildren(button, frame);
        frame.style.marginTop = "12px";
        frame.style.marginBottom = "0";
      }
    })
    .catch(() => {
      button.disabled = true;
      button.textContent = "客服暂不可用";
    });
  box.append(frame, button);
  document.body.append(box);
})();
