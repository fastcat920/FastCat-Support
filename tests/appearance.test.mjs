import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAppearance } from "../public/appearance.js";
import { normalizeLanguage } from "../public/i18n.js";
test("appearance follows host language, brightness and accent; fixed configuration wins", () => {
  assert.deepEqual(
    resolveAppearance(
      {},
      { language: "en-US", theme: "dark", color: "#114466" },
    ),
    { language: "en", theme: "dark", color: "#114466" },
  );
  assert.deepEqual(
    resolveAppearance(
      {
        language: "zh-CN",
        theme: "light",
        followHostColor: false,
        themeColor: "#abcdef",
      },
      { language: "en", theme: "dark", color: "#114466" },
    ),
    { language: "zh-CN", theme: "light", color: "#abcdef" },
  );
  assert.deepEqual(
    resolveAppearance(
      {},
      { color: "url(javascript:bad)", theme: "invalid" },
      { language: "en-GB", dark: true },
    ),
    { language: "en", theme: "dark", color: "#5b4ee8" },
  );
  assert.equal(normalizeLanguage("zh-Hans"), "zh-CN");
});

import { nextConversation } from "../public/inbox-selection.js";
test("closing follows queue order, wraps, skips completed or excluded items and handles an empty queue", () => {
  const items = [
    { id: "a", status: "open" },
    { id: "b", status: "closed" },
    { id: "c", status: "pending" },
    { id: "d", status: "open" },
  ];
  assert.equal(nextConversation(items, "a"), "c");
  assert.equal(nextConversation(items, "d"), "a");
  assert.equal(nextConversation(items, "removed"), "a");
  assert.equal(nextConversation(items, "a", ["c"]), "d");
  assert.equal(nextConversation(items, "a", ["c", "d"]), null);
  assert.equal(nextConversation([], "a"), null);
});

import { translateEnglish } from "../public/i18n.js";
test("UI localization preserves dynamic names and only translates known status metadata", () => {
  assert.equal(
    translateEnglish("customer@example.com · 管理员"),
    "customer@example.com · Administrator",
  );
  assert.equal(
    translateEnglish("AI 助手 · 已读 · 10:40"),
    "AI assistant · Read · 10:40",
  );
  assert.equal(translateEnglish("version_custom_123"), "version_custom_123");
  assert.equal(
    translateEnglish("选择 Customer 123 的会话"),
    "Select conversation: Customer 123",
  );
});
