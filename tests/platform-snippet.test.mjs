import { test } from "node:test";
import assert from "node:assert/strict";
import { platformSnippet } from "../public/access.js";

test("platform examples preserve real line breaks and the selected platform key", () => {
  const sdk = platformSnippet("sdk", "https://support.example.test", "sdk-key");
  assert.match(sdk, /FastCatClient\(\n/);
  assert.ok(!sdk.includes("\\n"));
  assert.ok(sdk.includes("appKey: 'sdk-key'"));
  const web = platformSnippet("web", "https://support.example.test", "web-key");
  assert.ok(web.includes('data-app-key="web-key"'));
  assert.ok(web.includes('src="https://support.example.test/embed.js"'));
});
