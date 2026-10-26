const key = new URL(location.href).searchParams.get("appKey");
if (key) {
  const script = document.createElement("script");
  script.src = "/embed.js";
  script.dataset.appKey = key;
  document.body.append(script);
} else
  document.querySelector("main").textContent =
    "请从接入平台的配置中打开嵌入演示。";
