export function createMediaUI({ E, modal, getSession = () => null }) {
  const urls = new Map();
  function endpoint(id) {
    const s = getSession();
    return s
      ? "/api/widget/attachments/" +
          id +
          "?id=" +
          encodeURIComponent(s.id) +
          (s.appKey ? "&appKey=" + encodeURIComponent(s.appKey) : "")
      : "/api/attachments/" + id;
  }
  const headers = () =>
    getSession() ? { Authorization: "Bearer " + getSession().token } : {};
  async function blobFor(id) {
    const response = await fetch(endpoint(id), { headers: headers() });
    if (!response.ok) {
      let msg = "附件暂不可访问";
      try {
        msg = (await response.json()).error || msg;
      } catch {}
      throw Error(msg);
    }
    return response.blob();
  }
  const size = (n) =>
    n < 1024
      ? n + " B"
      : n < 1048576
        ? (n / 1024).toFixed(1) + " KB"
        : (n / 1048576).toFixed(1) + " MB";
  function render(a) {
    if (!a) return "";
    return `<div class="message-attachment">${a.mime.startsWith("image/") ? `<button type="button" class="attachment-image-button" data-image-open="${a.id}" data-filename="${E(a.filename)}"><img class="attachment-image" data-image="${a.id}" alt="${E(a.filename)}" loading="lazy"></button>` : ""}<button type="button" class="attachment-download" data-download="${a.id}" data-filename="${E(a.filename)}"><span class="attachment-icon">${a.mime.startsWith("image/") ? "▧" : "▤"}</span><span><strong>${E(a.filename)}</strong><small>${size(a.size)} · 点击下载</small></span><span>↧</span></button></div>`;
  }
  function bind(root) {
    if (!root) return;
    for (const img of root.querySelectorAll("[data-image]")) {
      const id = img.dataset.image;
      if (!getSession()) img.src = endpoint(id);
      else {
        if (!urls.has(id))
          urls.set(
            id,
            blobFor(id)
              .then((blob) => URL.createObjectURL(blob))
              .catch((error) => {
                urls.delete(id);
                return "";
              }),
          );
        urls.get(id).then((url) => {
          if (img.isConnected && url) img.src = url;
        });
      }
    }
    for (const button of root.querySelectorAll("[data-download]"))
      button.onclick = async () => {
        button.disabled = true;
        try {
          const blob = await blobFor(button.dataset.download),
            url = URL.createObjectURL(blob),
            link = document.createElement("a");
          link.href = url;
          link.download = button.dataset.filename;
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
          showError(error.message);
        } finally {
          button.disabled = false;
        }
      };
    for (const button of root.querySelectorAll("[data-image-open]"))
      button.onclick = async () => {
        try {
          const id = button.dataset.imageOpen;
          let url;
          if (getSession()) {
            if (!urls.has(id))
              urls.set(
                id,
                blobFor(id).then((blob) => URL.createObjectURL(blob)),
              );
            url = await urls.get(id);
          } else url = endpoint(id);
          if (!url) throw Error("图片暂不可访问");
          if (modal)
            modal(
              button.dataset.filename,
              `<img class="media-preview" src="${E(url)}" alt="${E(button.dataset.filename)}">`,
              "关闭",
            );
          else {
            const overlay = document.createElement("div");
            overlay.className = "image-lightbox";
            overlay.innerHTML = `<button type="button" aria-label="关闭图片预览">×</button><img src="${E(url)}" alt="${E(button.dataset.filename)}">`;
            const close = () => {
                overlay.remove();
                document.removeEventListener("keydown", onKey);
                button.focus();
              },
              onKey = (e) => {
                if (e.key === "Escape") close();
              };
            overlay.onclick = (e) => {
              if (e.target === overlay || e.target.tagName === "BUTTON")
                close();
            };
            document.addEventListener("keydown", onKey);
            document.body.append(overlay);
            overlay.querySelector("button").focus();
          }
        } catch (error) {
          showError(error.message);
        }
      };
  }
  function showError(message) {
    if (modal) modal("附件", `<p class="error">${E(message)}</p>`, "关闭");
    else {
      const error = document.querySelector(".error");
      if (error) error.textContent = message;
    }
  }
  function clear() {
    for (const url of urls.values())
      Promise.resolve(url).then((value) => {
        if (value) URL.revokeObjectURL(value);
      });
    urls.clear();
  }
  return { render, bind, clear };
}
