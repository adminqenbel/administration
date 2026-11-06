import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { developmentMetaPolicy, productionHeaderPolicy, productionMetaPolicy } from "../config/csp.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("production policy is self-only, with no inline or eval and no third-party origins", () => {
  const p = productionHeaderPolicy();
  assert.ok(!/unsafe-inline|unsafe-eval/.test(p));
  assert.ok(!/https?:|wss?:|\*/.test(p), "no remote origins or wildcards");
  assert.match(p, /default-src 'self'/);
  assert.match(p, /script-src 'self'(;|$)/);
  assert.match(p, /object-src 'none'/);
  assert.match(p, /frame-ancestors 'none'/);
  assert.match(p, /base-uri 'self'/);
  assert.ok(!/frame-ancestors/.test(productionMetaPolicy()), "frame-ancestors is header-only");
});

test("dev policy only loosens inline script/style and local websockets", () => {
  const p = developmentMetaPolicy();
  assert.ok(!/https?:/.test(p));
  assert.ok(!/unsafe-eval/.test(p));
  const remote = p.match(/wss?:\/\/[^\s;]+/g) ?? [];
  for (const r of remote) assert.match(r, /^ws:\/\/(localhost|127\.0\.0\.1):\*$/);
});

test("public/_headers carries the production policy", () => {
  const headers = readFileSync(join(root, "public/_headers"), "utf8");
  assert.ok(headers.includes(`Content-Security-Policy: ${productionHeaderPolicy()}`), "run: npm run headers -w @qenbel/web");
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});

test("index.html has the CSP placeholder and no inline script or style", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  assert.ok(html.includes("<!--csp-->"));
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "inline script");
  assert.ok(!/<style/i.test(html), "inline style");
  assert.ok(!/\sstyle=/i.test(html), "inline style attribute");
  assert.ok(!/\son[a-z]+=/i.test(html), "inline event handler");
});

test("built index.html (when present) carries the strict meta policy", { skip: !existsSync(join(root, "dist/index.html")) && "run the build first" }, () => {
  const html = readFileSync(join(root, "dist/index.html"), "utf8");
  assert.ok(html.includes(`content="${productionMetaPolicy()}"`));
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "built html has an inline script");
});
