const key = new URL(location.href).searchParams.get("appKey");
if (key) {
  const script = document.createElement("script");
  script.src = "/embed.js";
  script.dataset.appKey = key;
  document.body.append(script);
} else
  document.querySelector("main").textContent =
    "请从接入平台的配置中打开嵌入演示。";

const syncHost = () => {
  document.documentElement.lang =
    document.querySelector("#host-language").value;
  document.documentElement.dataset.theme =
    document.querySelector("#host-theme").value;
  document.documentElement.style.setProperty(
    "--fastcat-primary",
    document.querySelector("#host-color").value,
  );
};
for (const id of ["host-language", "host-theme", "host-color"])
  document.querySelector("#" + id).addEventListener("input", syncHost);
syncHost();
