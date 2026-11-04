// Public appearance only. Cache keys isolate support origins and app keys.
const MAX_AGE = 24 * 60 * 60 * 1000;
export function configurationKey(origin, appKey) {
  return `fc_appearance:v1:${origin}:${appKey}`;
}
export function readConfiguration(key, storage, now = Date.now()) {
  try {
    storage ??= globalThis.localStorage;
    const record = JSON.parse(storage.getItem(key));
    if (
      !record ||
      !Number.isFinite(record.saved) ||
      now < record.saved ||
      now - record.saved > MAX_AGE ||
      !validConfiguration(record.data)
    )
      return null;
    return record.data;
  } catch {
    return null;
  }
}
export function validConfiguration(data) {
  const w = data?.widget;
  return !!(
    w &&
    typeof w === "object" &&
    !Array.isArray(w) &&
    /^#[0-9a-f]{6}$/i.test(w.themeColor || "") &&
    (w.language == null || ["auto", "zh-CN", "en"].includes(w.language)) &&
    (w.theme == null || ["auto", "light", "dark"].includes(w.theme)) &&
    (w.showHandoffButton == null || typeof w.showHandoffButton === "boolean")
  );
}
export function saveConfiguration(key, data, storage, now = Date.now()) {
  try {
    storage ??= globalThis.localStorage;
    if (validConfiguration(data))
      storage.setItem(key, JSON.stringify({ saved: now, data }));
  } catch {}
}
