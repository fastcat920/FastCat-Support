import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQaImport } from "../lib/qa-import.mjs";

test("JSON and quoted CSV imports preserve questions, answers and categories", () => {
  const expected = [
    { question: "How?", answer: "First, then\nnext", category: "Support" },
  ];
  assert.deepEqual(parseQaImport("json", JSON.stringify(expected)), expected);
  assert.deepEqual(
    parseQaImport(
      "csv",
      'question,answer,category\r\nHow?,"First, then\nnext",Support\r\n',
    ),
    expected,
  );
  assert.throws(() => parseQaImport("csv", 'question,answer\n"bad,answer'));
  assert.throws(() =>
    parseQaImport(
      "json",
      '[{"question":"valid","answer":"ok"},{"question":"","answer":"bad"}]',
    ),
  );
});
