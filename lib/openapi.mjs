import { parseDocument } from "yaml";
export function parseOpenapiSpec(input) {
  let spec = input;
  if (typeof input === "string") {
    if (input.length > 1000000) throw Error("OpenAPI 文档最多 1,000,000 字符");
    const doc = parseDocument(input, {
      version: "1.2",
      schema: "core",
      uniqueKeys: true,
    });
    if (doc.errors.length)
      throw Error(
        "OpenAPI JSON / YAML 语法无效：" + doc.errors[0].message.slice(0, 200),
      );
    try {
      spec = doc.toJS({ maxAliasCount: 30 });
    } catch {
      throw Error("YAML 引用展开超过限制");
    }
  }
  if (
    !spec ||
    typeof spec !== "object" ||
    Array.isArray(spec) ||
    !/^3\./.test(spec.openapi || "")
  )
    throw Error("请提供 OpenAPI 3.x JSON 或 YAML 文档");
  return spec;
}
export function resolveOpenapi(value, root) {
  let count = 0;
  function resolve(v, refs = new Set(), depth = 0) {
    if (++count > 20000 || depth > 40)
      throw Error("OpenAPI 引用或结构过于复杂");
    if (Array.isArray(v)) return v.map((x) => resolve(x, refs, depth + 1));
    if (!v || typeof v !== "object") return v;
    if (v.$ref) {
      if (typeof v.$ref !== "string" || !v.$ref.startsWith("#/"))
        throw Error("仅支持文档内 $ref，不会自动请求外部文档");
      if (refs.has(v.$ref)) throw Error("暂不支持循环 Schema 引用");
      let target = root;
      for (const key of v.$ref
        .slice(2)
        .split("/")
        .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))) {
        if (!target || !Object.hasOwn(target, key))
          throw Error("OpenAPI 引用不存在：" + v.$ref);
        target = target[key];
      }
      const next = new Set(refs);
      next.add(v.$ref);
      return resolve(target, next, depth + 1);
    }
    const result = {};
    for (const [k, x] of Object.entries(v)) {
      if (["__proto__", "constructor", "prototype"].includes(k))
        throw Error("OpenAPI 包含无效字段");
      result[k] = resolve(x, refs, depth + 1);
    }
    return result;
  }
  return resolve(value);
}
export function queryParameter(query, p, value) {
  const style = p.style || "form",
    explode = p.explode ?? style === "form";
  if (
    !["form", "spaceDelimited", "pipeDelimited", "deepObject"].includes(style)
  )
    throw Error("暂不支持查询参数序列化：" + style);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (style === "deepObject") {
      for (const [k, v] of Object.entries(value)) {
        if (v && typeof v === "object")
          throw Error("deepObject 暂不支持嵌套对象");
        query.append(p.name + "[" + k + "]", String(v));
      }
      return;
    }
    if (style !== "form") throw Error("对象参数仅支持 form 或 deepObject");
    if (explode) {
      for (const [k, v] of Object.entries(value)) query.append(k, String(v));
    } else
      query.append(
        p.name,
        Object.entries(value)
          .flatMap(([k, v]) => [k, String(v)])
          .join(","),
      );
    return;
  }
  if (Array.isArray(value)) {
    if (style === "deepObject") throw Error("deepObject 需要对象参数");
    if (style === "form" && explode) {
      for (const v of value) query.append(p.name, String(v));
    } else
      query.append(
        p.name,
        value.join(
          style === "spaceDelimited"
            ? " "
            : style === "pipeDelimited"
              ? "|"
              : ",",
        ),
      );
    return;
  }
  query.append(p.name, String(value));
}
