import { configurationKey, readConfiguration } from "./configuration-cache.js";
const params = new URL(location.href).searchParams;
const preview = params.get("preview") === "1";
if (!preview) {
  const key = params.get("appKey") || "";
  const url = new URL("/api/widget/config", location.origin);
  if (key) url.searchParams.set("appKey", key);
  try {
    window.__fastcatCachedConfiguration = readConfiguration(
      configurationKey(location.origin, key),
    );
  } catch {}
  // Start network work before loading the chat's module graph.
  window.__fastcatConfigurationRequest = fetch(url, {
    signal: AbortSignal.timeout(15000),
  }).then((response) => {
    if (!response.ok) throw Error("Configuration unavailable");
    return response.json();
  });
  window.__fastcatConfigurationRequest.catch(() => {});
}
await import(preview ? "./widget-preview.js" : "./widget.js");
if (preview) {
  document.body.classList.remove("widget-loading");
  document.querySelector("#widget-loading-status")?.remove();
}
