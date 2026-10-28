const CACHE = "fastcat-shell-v025-telegram-polling";
const FILES = [
  "/",
  "/widget",
  "/widget.html",
  "/widget.js",
  "/widget-entry.js",
  "/widget-preview.js",
  "/widget-chat-markup.js",
  "/chat-controls.js",
  "/message-status.js",
  "/message-days.js",
  "/app.js",
  "/ids.js",
  "/i18n.js",
  "/appearance.js",
  "/inbox-selection.js",
  "/settings.js",
  "/notifications.js",
  "/extensions.js",
  "/message-renderer.js",
  "/vendor/markdown-it.min.js",
  "/agent-editor.js",
  "/style.css",
  "/inbox.js",
  "/management.js",
  "/team-navigation.js",
  "/features.js",
  "/knowledge-jobs.js",
  "/flow-model.js",
  "/service.js",
  "/media.js",
  "/icons.js",
  "/outbox.js",
  "/providers.js",
  "/model-catalog.js",
  "/model-picker.js",
  "/retrieval.js",
  "/access.js",
  "/embed.js",
];
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(FILES))
      .then(() => self.skipWaiting()),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("fastcat-shell-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    !FILES.includes(url.pathname)
  )
    return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
