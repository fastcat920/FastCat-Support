import { parentPort, workerData } from "node:worker_threads";
import { extname } from "node:path";
const data = Buffer.from(workerData.data),
  extension = extname(workerData.filename).toLowerCase();
async function validateDocx() {
  const yauzl = (await import("yauzl")).default;
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(Error("DOCX 压缩结构无效"));
      let size = 0,
        actualSize = 0,
        count = 0,
        document = false,
        done = false;
      const fail = (message) => {
        if (done) return;
        done = true;
        zip.close();
        reject(Error(message));
      };
      zip.on("error", () => fail("DOCX 压缩结构无效"));
      zip.on("entry", (entry) => {
        size += entry.uncompressedSize;
        count++;
        if (
          size > 20 * 1024 * 1024 ||
          count > 1000 ||
          entry.generalPurposeBitFlag & 1
        )
          return fail("DOCX 内容过大或已加密");
        if (entry.fileName === "word/document.xml") document = true;
        if (entry.fileName.endsWith("/")) return zip.readEntry();
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail("DOCX 内容无法读取");
          stream.on("data", (chunk) => {
            actualSize += chunk.length;
            if (actualSize > 20 * 1024 * 1024) {
              stream.destroy();
              fail("DOCX 解压内容过大");
            }
          });
          stream.on("error", () => fail("DOCX 内容大小校验失败"));
          stream.on("end", () => {
            if (!done) zip.readEntry();
          });
        });
      });
      zip.on("end", () => {
        if (done) return;
        done = true;
        document ? resolve() : reject(Error("未找到 Word 文档正文"));
      });
      zip.readEntry();
    });
  });
}
try {
  let text = "",
    pages = null;
  if (extension === ".pdf") {
    if (data.subarray(0, 5).toString() !== "%PDF-")
      throw Error("文件内容不是有效 PDF");
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({
      data: new Uint8Array(data),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    try {
      const info = await parser.getInfo();
      pages = info.total;
      if (pages > 100) throw Error("PDF 最多支持 100 页");
      text = (await parser.getText()).pages.map((p) => p.text).join("\n\n");
    } finally {
      await parser.destroy();
    }
  } else if (extension === ".docx") {
    await validateDocx();
    const mammoth = (await import("mammoth")).default;
    text = (
      await mammoth.extractRawText(
        { buffer: data },
        { externalFileAccess: false },
      )
    ).value;
  } else if ([".txt", ".md"].includes(extension)) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw Error("文本文件必须为 UTF-8 编码");
    }
    if (text.includes("\0")) throw Error("文本包含无效内容");
  } else throw Error("仅支持 PDF、DOCX、TXT 和 Markdown");
  text = text.trim();
  if (!text) throw Error("未提取到可检索文本；扫描件需要 OCR");
  if (text.length > 200000) throw Error("正文超过 200,000 字符，请拆分文档");
  parentPort.postMessage({ ok: true, text, pages });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error:
      error.name === "PasswordException"
        ? "PDF 已加密，请先解密"
        : error.message,
  });
}
