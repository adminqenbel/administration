// Test helpers: schema walkers and a small structural OpenAPI 3.1 checker (no network, no extra deps).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Node = { [k: string]: unknown };

/** Visits every schema-like object in a JSON Schema tree. */
export function walkSchema(node: unknown, visit: (n: Node, path: string) => void, path = "#"): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walkSchema(n, visit, `${path}/${i}`));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Node;
  visit(obj, path);
  for (const [k, v] of Object.entries(obj)) {
    if (k === "properties" && v && typeof v === "object") {
      for (const [pk, pv] of Object.entries(v as Node)) walkSchema(pv, visit, `${path}/properties/${pk}`);
    } else {
      walkSchema(v, visit, `${path}/${k}`);
    }
  }
}

/** Every property name that appears under any `properties` object, at any depth. */
export function collectPropertyNames(schema: unknown): string[] {
  const names: string[] = [];
  walkSchema(schema, (n) => {
    const props = n["properties"];
    if (props && typeof props === "object" && !Array.isArray(props)) names.push(...Object.keys(props));
  });
  return names;
}

/** Lower-cases and removes `_` and `-` so tenant_id, tenantId and TENANT-ID all compare equal. */
export const normaliseKey = (k: string) => k.toLowerCase().replace(/[_-]/g, "");

export const FORBIDDEN_INPUT_KEYS = [
  "tenantid",
  "tenant",
  "organisationid",
  "organizationid",
  "organisation",
  "organization",
  "orgid",
  "role",
  "idempotencykey",
];

export function forbiddenKeysIn(schema: unknown): string[] {
  return collectPropertyNames(schema).filter((k) => FORBIDDEN_INPUT_KEYS.includes(normaliseKey(k)));
}

/** Paths to every string leaf in a value, for mutation tests. */
export function stringLeafPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value === "string") return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeafPaths(v, [...path, i]));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => stringLeafPaths(v, [...path, k]));
  return [];
}

export function setAtPath(root: unknown, path: (string | number)[], value: unknown): unknown {
  const copy = structuredClone(root) as Record<string | number, unknown>;
  let cur: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) cur = cur[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (last === undefined) return value;
  cur[last] = value;
  return copy;
}

// ---- OpenAPI 3.1 structural check --------------------------------------------------------------

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Returns a list of problems. Empty means the document passed every structural expectation. */
export function checkOpenApi31(doc: unknown): string[] {
  const problems: string[] = [];
  const d = doc as Node;
  if (typeof d["openapi"] !== "string" || !/^3\.1\.\d+$/.test(d["openapi"])) problems.push("openapi must be 3.1.x");
  const info = d["info"] as Node | undefined;
  if (!info || typeof info["title"] !== "string" || !info["title"] || typeof info["version"] !== "string" || !info["version"]) {
    problems.push("info.title and info.version are required");
  }
  const servers = d["servers"];
  if (!Array.isArray(servers) || servers.length === 0 || servers.some((s) => typeof (s as Node)["url"] !== "string")) {
    problems.push("servers[].url is required");
  }

  const components = (d["components"] ?? {}) as Node;
  const schemes = (components["securitySchemes"] ?? {}) as Node;
  const bearer = schemes["bearerAuth"] as Node | undefined;
  if (!bearer || bearer["type"] !== "http" || bearer["scheme"] !== "bearer") problems.push("components.securitySchemes.bearerAuth must be http bearer");
  const security = d["security"];
  if (!Array.isArray(security) || !security.some((s) => s && typeof s === "object" && "bearerAuth" in s)) problems.push("top-level security must require bearerAuth");

  // The shared error shape: { error: { code, message, details } }.
  const errorSchema = ((components["schemas"] ?? {}) as Node)["Error"] as Node | undefined;
  const errorProps = (((errorSchema?.["properties"] as Node | undefined)?.["error"] as Node | undefined)?.["properties"] ?? {}) as Node;
  for (const k of ["code", "message", "details"]) if (!(k in errorProps)) problems.push(`Error schema is missing error.${k}`);

  // Every $ref resolves; every `type` is a JSON Schema type.
  walkAll(doc, (n, path) => {
    const ref = n["$ref"];
    if (typeof ref === "string" && resolvePointer(doc, ref) === undefined) problems.push(`dangling $ref ${ref} at ${path}`);
  });
  walkSchema(components["schemas"], (n, path) => {
    const t = n["type"];
    const list = Array.isArray(t) ? t : t === undefined ? [] : [t];
    for (const x of list) if (typeof x !== "string" || !JSON_TYPES.has(x)) problems.push(`bad type ${String(x)} at ${path}`);
  });

  const paths = (d["paths"] ?? {}) as Record<string, Node>;
  if (Object.keys(paths).length === 0) problems.push("paths is empty");
  const operationIds = new Set<string>();
  for (const [p, item] of Object.entries(paths)) {
    if (!p.startsWith("/")) problems.push(`path ${p} must start with /`);
    for (const [method, opRaw] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) {
        problems.push(`${p}: unexpected key ${method}`);
        continue;
      }
      const op = opRaw as Node;
      const where = `${method.toUpperCase()} ${p}`;
      const id = op["operationId"];
      if (typeof id !== "string" || !id) problems.push(`${where}: operationId missing`);
      else if (operationIds.has(id)) problems.push(`${where}: duplicate operationId ${id}`);
      else operationIds.add(id);
      const responses = op["responses"] as Node | undefined;
      if (!responses || Object.keys(responses).length === 0) problems.push(`${where}: responses missing`);
      else {
        if (!("200" in responses)) problems.push(`${where}: no 200 response`);
        for (const code of Object.keys(responses)) if (!/^[1-5]\d\d$|^default$/.test(code)) problems.push(`${where}: bad response code ${code}`);
      }
      if (method === "post" && !op["requestBody"]) problems.push(`${where}: requestBody missing`);
      for (const param of (op["parameters"] ?? []) as Node[]) {
        const resolved = (typeof param["$ref"] === "string" ? resolvePointer(doc, param["$ref"]) : param) as Node | undefined;
        if (!resolved || typeof resolved["name"] !== "string" || !["query", "header", "path", "cookie"].includes(resolved["in"] as string)) {
          problems.push(`${where}: invalid parameter`);
        } else if (resolved["in"] === "path" && resolved["required"] !== true) problems.push(`${where}: path parameter must be required`);
      }
    }
  }
  return problems;
}

function walkAll(node: unknown, visit: (n: Node, path: string) => void, path = "#"): void {
  if (Array.isArray(node)) return node.forEach((n, i) => walkAll(n, visit, `${path}/${i}`));
  if (node === null || typeof node !== "object") return;
  visit(node as Node, path);
  for (const [k, v] of Object.entries(node)) walkAll(v, visit, `${path}/${k}`);
}
