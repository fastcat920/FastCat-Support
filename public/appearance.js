import { normalizeLanguage } from "./i18n.js";
export function resolveAppearance(config = {}, host = {}, system = {}) {
  const validTheme = (value) => ["light", "dark"].includes(value);
  const color = (value) => /^#[0-9a-f]{6}$/i.test(value || "");
  return {
    language:
      config.language && config.language !== "auto"
        ? normalizeLanguage(config.language)
        : normalizeLanguage(host.language || system.language),
    theme: validTheme(config.theme)
      ? config.theme
      : validTheme(host.theme)
        ? host.theme
        : system.dark
          ? "dark"
          : "light",
    color: color(config.themeColor) ? config.themeColor : "#5b4ee8",
  };
}
export function applyAppearance({ theme, color }) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty("--brand", color);
  document.documentElement.style.setProperty(
    "--brand-soft",
    "color-mix(in srgb, var(--brand) 12%, var(--surface))",
  );
  const rgb = [1, 3, 5]
    .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  root.style.setProperty(
    "--brand-fg",
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.179
      ? "#000"
      : "#fff",
  );
}
