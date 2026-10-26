import { test } from "node:test";
import assert from "node:assert/strict";
import {
  McpConnection,
  integrationUrl,
  openapiOperations,
  callOpenapi,
} from "../lib/integrations.mjs";
import { chunkText, searchChunks, htmlToText } from "../lib/knowledge.mjs";
test("chunk index preserves overlap, ranks relevant Chinese passages and strips active HTML", () => {
  assert.deepEqual(chunkText("abcdefghij", 6, 2), ["abcdef", "efghij"]);
  assert.deepEqual(chunkText("   "), []);
  const result = searchChunks(
    [
      { name: "售后", content: "退款退款退款退货申请", id: "a" },
      { name: "物流", content: "物流订单发货配送状态", id: "b" },
    ],
    "如何申请退款",
  );
  assert.equal(result[0].id, "a");
  assert.equal(
    htmlToText("<h1>服务</h1><script>secret()</script><p>退货 &amp; 换货</p>"),
    "服务\n 退货 & 换货",
  );
});
test("integration target allowlist and redirects block unintended requests", () => {
  assert.throws(
    () => integrationUrl("http://127.0.0.1:1/admin", "https://safe.example"),
    /INTEGRATION_ALLOWED_ORIGINS/,
  );
  assert.throws(
    () =>
      integrationUrl("https://user:pass@example.com", "https://example.com"),
    /凭据/,
  );
});
test("MCP negotiates session and protocol, accepts SSE and validates before call", async () => {
  const methods = [];
  const fetcher = async (url, o) => {
    if (o.method === "DELETE") return new Response(null, { status: 204 });
    const b = JSON.parse(o.body);
    methods.push(b.method);
    if (b.method === "initialize")
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: b.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "test" },
          },
        }),
        {
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "session-test",
          },
        },
      );
    assert.equal(o.headers["Mcp-Session-Id"], "session-test");
    assert.equal(o.headers["MCP-Protocol-Version"], "2025-06-18");
    if (b.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    const result =
      b.method === "tools/list"
        ? {
            tools: [
              {
                name: "lookup",
                inputSchema: {
                  type: "object",
                  properties: { order: { type: "string" } },
                  required: ["order"],
                  additionalProperties: false,
                },
              },
            ],
          }
        : { content: [{ type: "text", text: "已发货" }] };
    return new Response(
      "data: " + JSON.stringify({ jsonrpc: "2.0", id: b.id, result }) + "\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const c = new McpConnection(
    { endpoint: "https://tools.example/mcp" },
    { fetcher, allowed: "https://tools.example" },
  );
  await c.open();
  await assert.rejects(() => c.call("lookup", {}), /参数无效/);
  assert.equal(methods.includes("tools/call"), false);
  const result = await c.call("lookup", { order: "FC100" });
  assert.equal(result.content[0].text, "已发货");
  await c.close();
});
test("OpenAPI generates typed parameter schema and executes encoded paths and query", async () => {
  const spec = {
    openapi: "3.0.3",
    paths: {
      "/orders/{id}": {
        get: {
          operationId: "order",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            { name: "detail", in: "query", schema: { type: "boolean" } },
          ],
        },
      },
    },
  };
  assert.equal(openapiOperations(spec)[0].inputSchema.required[0], "id");
  const result = await callOpenapi(
    { endpoint: "https://api.example/v1", spec },
    "order",
    { id: "FC/100", detail: true },
    {
      allowed: "https://api.example",
      fetcher: async (url, o) => {
        assert.equal(
          String(url),
          "https://api.example/v1/orders/FC%2F100?detail=true",
        );
        assert.equal(o.method, "GET");
        return new Response('{"status":"delivered"}');
      },
    },
  );
  assert.equal(result.status, "delivered");
});

test("OpenAPI YAML resolves local parameter and schema references and serializes arrays and objects", async () => {
  const spec = `openapi: 3.0.3
paths:
  /orders/{id}:
    parameters:
      - $ref: '#/components/parameters/OrderId'
    get:
      operationId: orders
      parameters:
        - name: tags
          in: query
          schema: {type: array, items: {type: string}}
        - name: filter
          in: query
          style: deepObject
          schema:
            $ref: '#/components/schemas/Filter'
components:
  parameters:
    OrderId:
      name: id
      in: path
      required: true
      schema: {type: string}
  schemas:
    Filter:
      type: object
      properties:
        state: {type: string}
`;
  const ops = openapiOperations(spec);
  assert.equal(ops[0].inputSchema.properties.filter.type, "object");
  let called = false;
  await callOpenapi(
    { endpoint: "https://tools.example", spec },
    "orders",
    { id: "FC/1", tags: ["a", "b"], filter: { state: "待发货" } },
    {
      allowed: "https://tools.example",
      fetcher: async (url) => {
        called = true;
        assert.equal(url.pathname, "/orders/FC%2F1");
        assert.deepEqual(url.searchParams.getAll("tags"), ["a", "b"]);
        assert.equal(url.searchParams.get("filter[state]"), "待发货");
        return Response.json({ ok: true });
      },
    },
  );
  assert.equal(called, true);
  assert.throws(
    () => openapiOperations("openapi: 3.0.3\nopenapi: 3.1.0"),
    /语法/,
  );
  assert.throws(
    () =>
      openapiOperations({
        openapi: "3.0.3",
        paths: {
          "/": {
            get: { parameters: [{ $ref: "https://other.example/schema" }] },
          },
        },
      }),
    /文档内/,
  );
  assert.throws(
    () =>
      openapiOperations({
        openapi: "3.0.3",
        components: {
          schemas: { Loop: { $ref: "#/components/schemas/Loop" } },
        },
        paths: {
          "/": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Loop" },
                  },
                },
              },
            },
          },
        },
      }),
    /循环/,
  );
});
