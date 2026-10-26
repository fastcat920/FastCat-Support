export function chunkText(content, size = 700, overlap = 100) {
  const text = String(content).replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  if (size <= overlap || overlap < 0) throw Error("分块参数无效");
  const chunks = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}
export function terms(value) {
  const s = String(value).toLowerCase();
  const result = s.match(/[a-z0-9]+|[\p{Script=Han}]+/gu) || [];
  return result.flatMap((t) =>
    /\p{Script=Han}/u.test(t)
      ? [
          ...t,
          ...Array.from({ length: Math.max(0, t.length - 1) }, (_, i) =>
            t.slice(i, i + 2),
          ),
        ]
      : [t],
  );
}
export function searchChunks(rows, query, limit = 8) {
  const q = [...new Set(terms(query))];
  if (!q.length || !rows.length) return [];
  const documents = rows.map((row) => {
      const tokens = terms(row.name + " " + row.content),
        counts = new Map();
      for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
      return { row, counts, length: tokens.length };
    }),
    average =
      documents.reduce((s, d) => s + d.length, 0) / documents.length || 1,
    df = new Map(
      q.map((t) => [t, documents.filter((d) => d.counts.has(t)).length]),
    );
  return documents
    .map((d) => {
      let score = 0;
      for (const term of q) {
        const tf = d.counts.get(term) || 0;
        if (!tf) continue;
        const idf = Math.log(
          1 + (documents.length - df.get(term) + 0.5) / (df.get(term) + 0.5),
        );
        score +=
          (idf * (tf * 2.2)) /
          (tf + 1.2 * (0.25 + (0.75 * d.length) / average));
      }
      return { ...d.row, score: Number(score.toFixed(4)) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
export function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/(p|div|section|h[1-6]|li|tr|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(
      /&(nbsp|amp|lt|gt|quot|apos);/g,
      (_, e) =>
        ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e],
    )
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const code =
        n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}
