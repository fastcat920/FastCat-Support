import { widgetChatMarkup } from "./widget-chat-markup.js";
import { resolveAppearance, applyAppearance } from "./appearance.js";
import { setLanguage, observeLanguage } from "./i18n.js";
import { bindComposer } from "./chat-controls.js";

const root = document.querySelector("#widget-content");
root.innerHTML = widgetChatMarkup;
document.querySelector("#widget-service-status").textContent = "预览模式";
document.querySelector("#widget-sound").disabled = true;
document.querySelector("#upload-file").disabled = true;
const messages = root.querySelector("#messages");
const welcome = document.createElement("div");
welcome.className = "message";
const bubble = document.createElement("div");
bubble.className = "bubble";
welcome.append(bubble);
const sample = document.createElement("div");
sample.className = "message agent";
sample.innerHTML = '<div class="bubble">你好，我想咨询一个问题</div>';
messages.append(welcome, sample);
const form = root.querySelector("form");
form.onsubmit = (event) => {
  event.preventDefault();
  const input = form.elements.body;
  if (!input.value.trim()) return;
  const message = document.createElement("div");
  message.className = "message agent";
  const content = document.createElement("div");
  content.className = "bubble";
  content.textContent = input.value;
  message.append(content);
  messages.append(message);
  input.value = "";
  messages.scrollTop = messages.scrollHeight;
};
bindComposer(form);
observeLanguage();
window.addEventListener("message", (event) => {
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    event.data?.type !== "fastcat:preview-config"
  )
    return;
  const value = event.data.config || {};
  const appearance = resolveAppearance(
    value,
    { language: value.hostLanguage, theme: value.hostTheme },
    {
      language: navigator.language,
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
    },
  );
  setLanguage(appearance.language);
  applyAppearance(appearance);
  document.querySelector(".widget-shell header h2").textContent =
    typeof value.title === "string" ? value.title.slice(0, 150) : "";
  bubble.textContent =
    typeof value.welcomeMessage === "string"
      ? value.welcomeMessage.slice(0, 3000)
      : "";
  welcome.hidden = !bubble.textContent;
  document.querySelector(".widget-logo")?.remove();
  if (
    typeof value.logoUrl === "string" &&
    /^(https:\/\/|data:image\/(?:png|jpeg|webp);base64,)/i.test(value.logoUrl)
  ) {
    const image = document.createElement("img");
    image.className = "widget-logo";
    image.alt = "";
    image.width = image.height = 36;
    image.referrerPolicy = "no-referrer";
    image.onerror = () => image.remove();
    image.src = value.logoUrl;
    document.querySelector(".widget-shell header").prepend(image);
  }
});
if (parent !== window)
  parent.postMessage({ type: "fastcat:preview-ready" }, location.origin);
