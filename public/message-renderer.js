export const escapeMessage = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function safeMessageURL(raw) {
  try {
    const u = new URL(String(raw));
    return ["https:", "http:", "mailto:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
export function createMessageRenderer(MarkdownIt) {
  const E = escapeMessage,
    md = MarkdownIt
      ? new MarkdownIt({
          html: false,
          linkify: false,
          breaks: true,
          typographer: false,
        })
      : null;
  if (md) {
    md.renderer.rules.link_open = (tokens, i, options, env, self) => {
      const t = tokens[i];
      const href = t.attrGet("href") || "";
      if (href.startsWith("msg://")) {
        t.attrSet("href", "#");
        let message = href.slice(6);
        try {
          message = decodeURIComponent(message);
        } catch {}
        t.attrSet("data-message-action", message.slice(0, 1000));
      } else {
        t.attrSet("href", safeMessageURL(href) || "#");
        t.attrSet("target", "_blank");
        t.attrSet("rel", "noopener noreferrer");
      }
      return self.renderToken(tokens, i, options);
    };
    md.renderer.rules.image = (tokens, i) => {
      const t = tokens[i],
        url = safeMessageURL(t.attrGet("src"));
      return url && /^https?:/.test(url)
        ? `<img src="${E(url)}" alt="${E(t.content)}" loading="lazy" referrerpolicy="no-referrer">`
        : E(t.content);
    };
    const fence = md.renderer.rules.fence;
    md.renderer.rules.fence = (...args) =>
      '<div class="message-code"><button type="button" data-copy-code>复制代码</button>' +
      fence(...args) +
      "</div>";
  }
  const markdown = (text) =>
    md ? md.render(String(text).slice(0, 20000)) : E(text);
  function render(body, { plain = false } = {}) {
    const text = String(body ?? "");
    if (plain) return E(text);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const m = text.match(/^```(?:spec|json-render)\s*\n([\s\S]*?)\n```$/);
      if (m)
        try {
          data = { type: "json_render", spec: JSON.parse(m[1]) };
        } catch {}
    }
    try {
      if (data?.type === "rich_text")
        return `<div class="message-rich">${markdown(data.content || "")}<div class="message-image-grid">${(Array.isArray(
          data.images,
        )
          ? data.images
          : []
        )
          .slice(0, 9)
          .map((i) => {
            const url = safeMessageURL(typeof i === "string" ? i : i.url);
            return url && /^https?:/.test(url)
              ? `<a href="${E(url)}" target="_blank" rel="noopener noreferrer"><img loading="lazy" referrerpolicy="no-referrer" src="${E(url)}" alt="${E(i.alt || "图片")}"></a>`
              : "";
          })
          .join(
            "",
          )}</div>${data.file && safeMessageURL(data.file.url) ? `<a href="${E(safeMessageURL(data.file.url))}" target="_blank" rel="noopener noreferrer">附件：${E(data.file.name || "下载文件")}</a>` : ""}</div>`;
      if (data?.type === "json_render" && data.spec)
        return '<div class="message-structured">' + spec(data.spec) + "</div>";
    } catch {
      return (
        '<p class="small">结构化内容无法完整显示，以下为原文：</p>' + E(text)
      );
    }
    return '<div class="message-markdown">' + markdown(text) + "</div>";
  }
  function spec(tree) {
    let count = 0;
    const path = new Set();
    const node = (id, depth = 0) => {
      if (++count > 200 || depth > 12) throw Error("结构过大");
      const element =
        typeof id === "string"
          ? Object.hasOwn(tree.elements || {}, id)
            ? tree.elements[id]
            : null
          : id;
      if (!element || typeof element !== "object") throw Error("节点无效");
      if (path.has(element)) throw Error("结构循环");
      path.add(element);
      const p = element.props || {},
        text = p.text ?? p.content ?? p.label ?? p.value ?? "",
        children = (Array.isArray(element.children) ? element.children : [])
          .map((c) => node(c, depth + 1))
          .join("");
      path.delete(element);
      const type = element.type;
      const box = (tag, cls, value) =>
        `<${tag} class="${cls}">${value}</${tag}>`;
      if (type === "Text") return box("div", "structured-text", E(text));
      if (["Card", "Section", "SectionCard"].includes(type))
        return box(
          "section",
          "structured-card",
          (p.title ? "<strong>" + E(p.title) + "</strong>" : "") + children,
        );
      if (["Row", "Column", "List", "ButtonGroup", "Actions"].includes(type))
        return box(
          "div",
          type === "Row" ? "structured-row" : "structured-column",
          children,
        );
      if (["KV", "KeyValue", "PriceRow", "AmountRow"].includes(type))
        return box(
          "div",
          "structured-row",
          "<span>" +
            E(p.label ?? p.key ?? "") +
            "</span><strong>" +
            E(p.value ?? p.amount ?? "") +
            "</strong>",
        );
      if (["OrderItem", "LineItem"].includes(type))
        return box(
          "div",
          "structured-card",
          "<strong>" +
            E(p.name ?? p.title ?? "商品") +
            "</strong><p>" +
            E(p.description ?? "") +
            "</p><span>" +
            E(p.quantity ?? p.qty ?? 1) +
            " × " +
            E(p.price ?? p.amount ?? "") +
            "</span>" +
            children,
        );
      if (["Badge", "StatusBadge"].includes(type))
        return box("span", "badge neutral", E(text));
      if (type === "Divider") return "<hr>";
      if (type === "Image") {
        const url = safeMessageURL(p.url ?? p.src);
        return url && /^https?:/.test(url)
          ? `<img loading="lazy" referrerpolicy="no-referrer" src="${E(url)}" alt="${E(p.alt || "图片")}">`
          : "";
      }
      if (type === "Button") {
        const action = element.on?.press || p.action;
        const message =
          p.message ??
          (action?.action === "send_message" ? action.params?.message : null);
        const url = safeMessageURL(p.url || p.href);
        if (url)
          return `<a class="button" href="${E(url)}" target="_blank" rel="noopener noreferrer">${E(p.label || p.text || "打开")}</a>`;
        return `<button type="button" ${message && !p.disabled ? `data-message-action="${E(message)}"` : "disabled"}>${E(p.label || p.text || "提交")}</button>`;
      }
      const name = String(p.name ?? p.label ?? "field").slice(0, 100);
      if (["Input", "TextField", "DateTimeInput"].includes(type))
        return `<label>${E(p.label || "")}<input data-structured-field="${E(name)}" maxlength="1000" type="${type === "DateTimeInput" ? "datetime-local" : "text"}" value="${E(p.value ?? "")}"></label>`;
      if (["Checkbox", "CheckBox"].includes(type))
        return `<label class="retrieval-checkbox"><input data-structured-field="${E(name)}" type="checkbox" ${p.checked ? "checked" : ""}>${E(p.label || "")}</label>`;
      if (type === "MultipleChoice")
        return `<label>${E(p.label || "")}<select data-structured-field="${E(name)}">${(Array.isArray(
          p.options,
        )
          ? p.options
          : []
        )
          .slice(0, 50)
          .map(
            (x) =>
              `<option value="${E(typeof x === "string" ? x : x.value)}">${E(typeof x === "string" ? x : x.label)}</option>`,
          )
          .join("")}</select></label>`;
      return box(
        "div",
        "structured-unknown",
        E("暂不支持的组件：" + String(type)) + children,
      );
    };
    return node(tree.root || tree);
  }
  return { render, markdown };
}
let renderer;
export function renderMessage(body, options) {
  renderer ||= createMessageRenderer(globalThis.markdownit);
  return renderer.render(body, options);
}
export function bindMessageActions(root, onMessage) {
  root.querySelectorAll("[data-message-action]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.preventDefault();
        let message = b.dataset.messageAction;
        const container = b.closest(".message-structured") || root;
        const values = {};
        container
          .querySelectorAll("[data-structured-field]")
          .forEach(
            (i) =>
              (values[i.dataset.structuredField] =
                i.type === "checkbox" ? String(i.checked) : i.value),
          );
        message = message.replace(
          /\{\{([^{}]+)\}\}/g,
          (_, k) => values[k.trim()] ?? "",
        );
        onMessage?.(message.slice(0, 10000));
      }),
  );
  root.querySelectorAll("[data-copy-code]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(
            b.parentElement.querySelector("code").textContent,
          );
          b.textContent = "已复制";
        } catch {
          b.textContent = "复制失败";
        }
      }),
  );
}
