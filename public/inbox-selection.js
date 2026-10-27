// Keep queue order, advance forward, then wrap to the first actionable item.
export function nextConversation(items, completedId, excluded = []) {
  const index = items.findIndex((item) => item.id === completedId);
  const ordered =
    index < 0 ? items : [...items.slice(index + 1), ...items.slice(0, index)];
  return (
    ordered.find(
      (item) =>
        item.id !== completedId &&
        item.status !== "closed" &&
        !excluded.includes(item.id),
    )?.id || null
  );
}
