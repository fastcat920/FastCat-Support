import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptMarkup } from "../public/message-status.js";
test("receipt symbols distinguish read from sent and retain accessible labels", () => {
  assert.match(receiptMarkup(7, { readSeq: 6, deliveredSeq: 7 }), /已发送.*✓/);
  assert.match(receiptMarkup(7, { readSeq: 7 }), /已读.*✓✓/);
});
