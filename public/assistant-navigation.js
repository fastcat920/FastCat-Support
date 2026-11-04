export function assistantNavigation(page) {
  const items = [
    ["agent", "智能体"],
    ["workflow", "工作流"],
    ["tool", "工具集成"],
    ["extensions", "技能与设备"],
  ];
  if (!items.some(([id]) => id === page)) return "";
  return `<nav class="tabs assistant-navigation" aria-label="AI助手功能">${items.map(([id, label]) => `<a href="#${id}" class="${page === id ? "active" : ""}" ${page === id ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}
