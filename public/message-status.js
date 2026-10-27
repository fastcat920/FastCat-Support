export function receiptMarkup(seq, receipts = {}) {
  const read = Number(seq) <= Number(receipts.readSeq || 0);
  return `<span class="message-receipt ${read ? "read" : ""}" role="img" aria-label="${read ? "已读" : "已发送"}" title="${read ? "已读" : "已发送"}">${read ? "✓✓" : "✓"}</span>`;
}
