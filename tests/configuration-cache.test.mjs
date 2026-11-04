import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configurationKey,
  readConfiguration,
  saveConfiguration,
} from "../public/configuration-cache.js";
function memory() {
  const data = new Map();
  return { getItem: (k) => data.get(k), setItem: (k, v) => data.set(k, v) };
}
test("appearance cache isolates origins and channels, expires, and tolerates blocked storage", () => {
  const storage = memory(),
    key = configurationKey("https://support.example", "web");
  const data = { widget: { themeColor: "#123456", showHandoffButton: false } };
  saveConfiguration(key, data, storage, 100);
  assert.deepEqual(readConfiguration(key, storage, 101), data);
  assert.equal(
    readConfiguration(
      configurationKey("https://other.example", "web"),
      storage,
      101,
    ),
    null,
  );
  assert.equal(
    readConfiguration(
      configurationKey("https://support.example", "sdk"),
      storage,
      101,
    ),
    null,
  );
  assert.equal(readConfiguration(key, storage, 86400101), null);
  assert.equal(readConfiguration(key, storage, 99), null);
  const blocked = {
    getItem() {
      throw Error("blocked");
    },
    setItem() {
      throw Error("blocked");
    },
  };
  assert.equal(readConfiguration(key, blocked), null);
  assert.doesNotThrow(() => saveConfiguration(key, data, blocked));
  saveConfiguration("invalid", { widget: { themeColor: "bad" } }, storage, 100);
  assert.equal(readConfiguration("invalid", storage, 101), null);
});
