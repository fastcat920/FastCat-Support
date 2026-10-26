export function teamNavigation(active) {
  return `<nav class="tabs team-navigation" aria-label="团队管理"><a href="#members" ${active === "members" ? 'class="active" aria-current="page"' : ""}>团队成员</a><a href="#teams" ${active === "teams" ? 'class="active" aria-current="page"' : ""}>接待团队</a></nav>`;
}
