import { HttpError } from "./management.mjs";
const fail = (status, message) => {
  throw new HttpError(status, message);
};
export const defaultHours = {
  enabled: false,
  timeZone: "Asia/Shanghai",
  weekdays: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
  offlineMessage: "当前不在服务时间，您可以留言，我们会尽快回复。",
};
export function migrateWorkingHours(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS team_working_hours(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0)",
  );
  const legacy = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='service_settings'",
    )
    .get();
  let value = defaultHours;
  if (legacy) {
    try {
      value = validateHours(
        JSON.parse(
          db.prepare("SELECT value FROM service_settings WHERE id=1").get()
            ?.value || "{}",
        ).hours,
      );
    } catch {}
  }
  db.prepare(
    "INSERT OR IGNORE INTO team_working_hours(id,value) VALUES(1,?)",
  ).run(JSON.stringify(value));
}
export function workingHours(db) {
  const row = db.prepare("SELECT * FROM team_working_hours WHERE id=1").get();
  return { ...JSON.parse(row.value), revision: row.revision };
}
export function inServiceHours(hours, date = new Date()) {
  if (!hours.enabled) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: hours.timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date),
    get = (k) => parts.find((p) => p.type === k)?.value,
    day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      get("weekday"),
    ),
    minute = Number(get("hour")) * 60 + Number(get("minute")),
    parse = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)),
    start = parse(hours.start),
    end = parse(hours.end);
  return start < end
    ? hours.weekdays.includes(day) && minute >= start && minute < end
    : (hours.weekdays.includes(day) && minute >= start) ||
        (hours.weekdays.includes((day + 6) % 7) && minute < end);
}
export function validateHours(value) {
  const h = structuredClone(value);
  if (
    !h ||
    typeof h.enabled !== "boolean" ||
    typeof h.timeZone !== "string" ||
    !h.timeZone.trim() ||
    h.timeZone.length > 100 ||
    !Array.isArray(h.weekdays) ||
    h.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(h.start) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(h.end) ||
    h.start === h.end ||
    typeof h.offlineMessage !== "string" ||
    h.offlineMessage.length > 3000
  )
    fail(400, "工作时间设置无效");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: h.timeZone });
  } catch {
    fail(400, "时区无效");
  }
  return {
    enabled: h.enabled,
    timeZone: h.timeZone,
    weekdays: [...new Set(h.weekdays)],
    start: h.start,
    end: h.end,
    offlineMessage: h.offlineMessage,
  };
}
