export function withMessageDays(messages, render) {
  let previous = "";
  return messages
    .map((message) => {
      const date = new Date(message.created);
      const valid = !Number.isNaN(date.getTime());
      const key = valid
        ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
        : "";
      const separator =
        key && key !== previous
          ? `<div class="message-day" role="separator">${date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</div>`
          : "";
      previous = key;
      return separator + render(message);
    })
    .join("");
}
