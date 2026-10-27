import { HttpError } from "./management.mjs";

export function parseQaImport(format, input) {
  if (typeof input !== "string" || input.length > 500000)
    throw new HttpError(400, "导入内容过大或格式无效");
  let items;
  if (format === "json") {
    try {
      items = JSON.parse(input);
    } catch {
      throw new HttpError(400, "JSON 格式无效");
    }
  } else if (format === "csv") {
    const rows = [],
      row = [];
    let field = "",
      quoted = false,
      afterQuote = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quoted) {
        if (ch === '"' && input[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          quoted = false;
          afterQuote = true;
        } else field += ch;
      } else if (ch === '"' && !field && !afterQuote) quoted = true;
      else if (ch === "," || ch === "\n" || ch === "\r") {
        row.push(field);
        field = "";
        afterQuote = false;
        if (ch !== ",") {
          rows.push([...row]);
          row.length = 0;
          if (ch === "\r" && input[i + 1] === "\n") i++;
        }
      } else if (afterQuote || ch === '"')
        throw new HttpError(400, "CSV 引号格式无效");
      else field += ch;
    }
    if (quoted) throw new HttpError(400, "CSV 引号未闭合");
    if (field || row.length) {
      row.push(field);
      rows.push(row);
    }
    const header = (rows.shift() || []).map((v) =>
      v
        .replace(/^\uFEFF/, "")
        .trim()
        .toLowerCase(),
    );
    const q = header.indexOf("question"),
      a = header.indexOf("answer"),
      c = header.indexOf("category");
    if (q < 0 || a < 0)
      throw new HttpError(400, "CSV 首行须包含 question 和 answer 列");
    items = rows
      .filter((r) => r.some((v) => v.trim()))
      .map((r) => ({
        question: r[q],
        answer: r[a],
        category: c < 0 ? "" : r[c],
      }));
  } else throw new HttpError(400, "仅支持 JSON 或 CSV");
  if (!Array.isArray(items) || !items.length || items.length > 100)
    throw new HttpError(400, "每次导入须包含 1–100 条问答");
  return items.map((item, i) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.question !== "string" ||
      typeof item.answer !== "string" ||
      (item.category != null && typeof item.category !== "string")
    )
      throw new HttpError(400, `第 ${i + 1} 条问答格式无效`);
    const question = item.question.trim(),
      answer = item.answer.trim(),
      category = (item.category || "").trim();
    if (
      !question ||
      question.length > 200 ||
      !answer ||
      answer.length > 10000 ||
      category.length > 100
    )
      throw new HttpError(400, `第 ${i + 1} 条问答内容无效`);
    return { question, answer, category };
  });
}
