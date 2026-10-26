import { test } from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import { createMessageRenderer } from "../public/message-renderer.js";
import { notificationDecision } from "../public/notifications.js";
const r = createMessageRenderer(MarkdownIt);
test("Markdown renders headings tables code and links while HTML and script URL injection remain inert", () => {
  const html = r.render(
    "# 标题\n\n**重点**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nalert(1)\n```\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n[x](https://example.com)",
  );
  assert.match(html, /<h1>标题/);
  assert.match(html, /<strong>重点/);
  assert.match(html, /<table>/);
  assert.match(html, /data-copy-code/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /noopener noreferrer/);
  assert.equal(r.render("**text**", { plain: true }), "**text**");
});
test("structured cards preserve text, form controls and message actions but cannot inject markup or URL schemes", () => {
  const html = r.render(
    JSON.stringify({
      type: "json_render",
      spec: {
        root: "card",
        elements: {
          card: {
            type: "Card",
            children: ["text", "field", "button", "image"],
          },
          text: { type: "Text", props: { text: "<img onerror=alert(1)>" } },
          field: { type: "Input", props: { name: "order", label: "订单号" } },
          button: {
            type: "Button",
            props: { label: "查询", message: "查询 {{order}}" },
          },
          image: { type: "Image", props: { url: "javascript:alert(1)" } },
        },
      },
    }),
  );
  assert.match(html, /structured-card/);
  assert.match(html, /data-structured-field="order"/);
  assert.match(html, /data-message-action=/);
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img/);
  const cycle = r.render(
    JSON.stringify({
      type: "json_render",
      spec: { root: "a", elements: { a: { type: "Card", children: ["a"] } } },
    }),
  );
  assert.match(cycle, /无法完整显示/);
});
test("rich messages reject unsafe images and files and unknown structured components degrade visibly", () => {
  const html = r.render(
    JSON.stringify({
      type: "rich_text",
      content: "**hello**",
      images: [
        { url: "data:image/svg+xml,x" },
        { url: "https://example.com/a.png", alt: '" onerror="x' },
      ],
      file: { url: "javascript:alert(1)", name: "bad" },
    }),
  );
  assert.match(html, /<strong>hello/);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.ok(!html.includes('href="javascript:'));
  assert.match(
    r.render(
      JSON.stringify({
        type: "json_render",
        spec: { type: "Unknown", children: [] },
      }),
    ),
    /暂不支持的组件/,
  );
});
test("notification scenarios distinguish current foreground, other conversations and background switches", () => {
  const p = {
    notifyOnBackground: true,
    notifyOnOtherConversation: true,
    notifyOnNewVisitor: false,
  };
  const item = { conversationId: "one", newVisitor: false };
  assert.equal(notificationDecision(item, p, { active: "one" }), false);
  assert.equal(notificationDecision(item, p, { active: "two" }), true);
  assert.equal(
    notificationDecision(item, p, { active: "one", hidden: true }),
    true,
  );
  assert.equal(
    notificationDecision(
      item,
      { ...p, notifyOnBackground: false },
      { hidden: true },
    ),
    false,
  );
  assert.equal(
    notificationDecision(
      { ...item, newVisitor: true },
      { ...p, notifyOnNewVisitor: true },
      { active: "two" },
    ),
    true,
  );
});
