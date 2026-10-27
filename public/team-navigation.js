export function teamNavigation(active) {
  return `<nav class="tabs team-navigation" aria-label="团队管理"><a href="#members" ${active === "members" ? 'class="active" aria-current="page"' : ""}>团队成员</a><a href="#team-hours" ${active === "team-hours" ? 'class="active" aria-current="page"' : ""}>工作时间</a></nav>`;
}
