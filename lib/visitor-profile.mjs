import { HttpError, validateEmail } from "./management.mjs";
const fields = [
  "externalId",
  "displayName",
  "phone",
  "company",
  "jobTitle",
  "source",
  "timezone",
  "platform",
  "device",
  "os",
  "appVersion",
  "browser",
  "language",
  "location",
];
export function cleanVisitorProfile(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "访客资料格式无效");
  const result = {};
  for (const key of fields)
    if (Object.hasOwn(value, key)) {
      if (typeof value[key] !== "string" || value[key].length > 200)
        throw new HttpError(400, "访客资料字段无效");
      result[key] = value[key].trim();
    }
  if (Object.hasOwn(value, "custom")) {
    const custom = value.custom;
    if (
      !custom ||
      typeof custom !== "object" ||
      Array.isArray(custom) ||
      Object.keys(custom).length > 20
    )
      throw new HttpError(400, "自定义资料无效");
    result.custom = {};
    for (const [key, item] of Object.entries(custom)) {
      if (
        ["__proto__", "constructor", "prototype"].includes(key) ||
        !key.trim() ||
        key.length > 60 ||
        !["string", "number", "boolean"].includes(typeof item) ||
        String(item).length > 500
      )
        throw new HttpError(400, "自定义资料无效");
      result.custom[key] = item;
    }
  }
  return result;
}
export function visitorIdentity(input) {
  const email = validateEmail(input.email);
  return {
    email,
    name: email,
    profile: cleanVisitorProfile(input.profile ?? {}),
  };
}
