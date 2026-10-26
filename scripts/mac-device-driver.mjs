import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);
const swift = async (source, args = []) => {
  if (process.platform !== "darwin")
    throw Error("内置驱动仅支持 macOS，请指定其他平台驱动");
  await exec(
    "/usr/bin/swift",
    [
      "-e",
      "import CoreGraphics\nimport Foundation\n" + source,
      ...args.map(String),
    ],
    { timeout: 30000, maxBuffer: 100000 },
  );
  return { ok: true };
};
const coordinate = (v) => {
  if (!Number.isInteger(v) || v < 0 || v > 20000) throw Error("坐标无效");
  return v;
};
export const commands = {
  screenshot: async () => {
    if (process.platform !== "darwin") throw Error("内置驱动仅支持 macOS");
    const dir = await mkdtemp(join(tmpdir(), "fastcat-screen-"));
    try {
      await exec(
        "/usr/sbin/screencapture",
        ["-x", "-D", "1", join(dir, "screen.png")],
        {
          timeout: 10000,
        },
      );
      await exec(
        "/usr/bin/sips",
        [
          "-s",
          "format",
          "jpeg",
          "-Z",
          "1280",
          join(dir, "screen.png"),
          "--out",
          join(dir, "screen.jpg"),
        ],
        { timeout: 10000 },
      );
      const bytes = await readFile(join(dir, "screen.jpg"));
      if (bytes.length > 450000) throw Error("截图过大");
      const meta = await exec(
        "/usr/bin/swift",
        [
          "-e",
          'import CoreGraphics; let r=CGDisplayBounds(CGMainDisplayID()); print("\\(Int(r.width)) \\(Int(r.height))")',
        ],
        { timeout: 30000 },
      );
      const [screenWidth, screenHeight] = meta.stdout
        .trim()
        .split(" ")
        .map(Number);
      return {
        screenWidth,
        screenHeight,
        image: "data:image/jpeg;base64," + bytes.toString("base64"),
        coordinateSpace: "截图已缩放；click 使用原始屏幕坐标",
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  click: async ({ x, y }) =>
    swift(
      "let point=CGPoint(x:Double(CommandLine.arguments[1])!,y:Double(CommandLine.arguments[2])!)\nCGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)\nCGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)",
      [coordinate(x), coordinate(y)],
    ),
  typeText: async ({ text }) => {
    if (typeof text !== "string" || text.length > 2000) throw Error("文本过长");
    if (!text) return { ok: true };
    return swift(
      "let units=Array(CommandLine.arguments[1].utf16)\nlet event=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true)!\nunits.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength:units.count,unicodeString:$0.baseAddress!) }\nevent.post(tap:.cghidEventTap)\nevent.type = .keyUp\nevent.post(tap:.cghidEventTap)",
      [text],
    );
  },
  keyPress: async ({ key }) => {
    const codes = {
      enter: 36,
      tab: 48,
      escape: 53,
      backspace: 51,
      left: 123,
      right: 124,
      down: 125,
      up: 126,
    };
    if (!Object.hasOwn(codes, key)) throw Error("按键未授权");
    return swift(
      "let code=CGKeyCode(Int(CommandLine.arguments[1])!)\nCGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:true)?.post(tap:.cghidEventTap)\nCGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false)?.post(tap:.cghidEventTap)",
      [codes[key]],
    );
  },
  scroll: async ({ pixels }) => {
    if (!Number.isInteger(pixels) || Math.abs(pixels) > 2000)
      throw Error("滚动范围无效");
    return swift(
      "CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:1,wheel1:Int32(CommandLine.arguments[1])!,wheel2:0,wheel3:0)?.post(tap:.cghidEventTap)",
      [pixels],
    );
  },
};
