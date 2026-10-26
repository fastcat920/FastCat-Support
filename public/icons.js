const shapes = {
  inbox: '<path d="M4 4h16v16H4zM4 14h5l2 3h2l2-3h5M8 8h8M8 11h5"/>',
  agent:
    '<rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M2 12v4M22 12v4M9 16h6"/><circle cx="9" cy="12" r=".6"/><circle cx="15" cy="12" r=".6"/>',
  knowledge:
    '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1v15M6 8h3M15 8h3"/>',
  workflow:
    '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><rect x="3" y="15" width="6" height="6" rx="1.5"/><path d="M6 9v6M9 6h9v9"/>',
  tool: '<path d="M9 3H4v6a3 3 0 1 1 0 6v6h6a3 3 0 1 1 6 0h5v-6a3 3 0 1 1 0-6V3h-6a3 3 0 1 1-6 0Z"/>',
  channel:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  visitors:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
  model:
    '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/><rect x="10" y="10" width="4" height="4"/>',
  settings:
    '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-1 2-3-1-3 2-2-1-3-3-1-1-3Z"/><circle cx="10.5" cy="11" r="3"/>',
};
export const iconMarkup = Object.fromEntries(
  Object.entries(shapes).map(([name, shape]) => [
    name,
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`,
  ]),
);

iconMarkup.members = iconMarkup.visitors;
iconMarkup.replies =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4ZM8 8h8M8 12h5"/></svg>';
iconMarkup.tags =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h8l10 10-8 8L3 11Z"/><circle cx="7.5" cy="7.5" r="1"/></svg>';
iconMarkup.audit =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" aria-hidden="true"><path d="M4 3h16v18H4ZM8 7h8M8 12h8M8 17h5"/></svg>';

iconMarkup.reception = iconMarkup.agent;
iconMarkup.teams = iconMarkup.visitors;
