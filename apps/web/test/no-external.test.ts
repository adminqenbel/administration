import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT = new Set([".ts", ".tsx", ".css", ".html", ".svg", ".json", ".webmanifest", ".js", ".mjs"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT.has(extname(full))) out.push(full);
  }
  return out;
}

// Allowed: the SVG namespace, and the React/JSX docs strings that never become requests.
function strip(text: string): string {
  return text.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "").replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "");
}

test("source, config and public files reference no external origins", () => {
  const files = [
    ...walk(join(root, "src")),
    ...walk(join(root, "public")),
    ...walk(join(root, "config")),
    join(root, "index.html"),
    join(root, "vite.config.ts"),
  ];
  assert.ok(files.length > 10);
  for (const f of files) {
    const text = strip(readFileSync(f, "utf8"));
    // A policy document is allowed to name ws://localhost for the dev server.
    const cleaned = text.replace(/ws:\/\/(localhost|127\.0\.0\.1):\*/g, "");
    assert.ok(!/https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(cleaned), `external URL in ${f}`);
    assert.ok(!/(^|[^:\w])\/\/[a-z0-9-]+\.[a-z]{2,}/i.test(cleaned.replace(/\/\/ .*$/gm, "")), `protocol-relative URL in ${f}`);
  }
});

test("no analytics, tag managers or third-party font hosts are named anywhere in source", () => {
  const banned = /(google-analytics|googletagmanager|gtag\(|fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com|cdnjs|segment\.com|mixpanel|hotjar|sentry\.io|facebook\.net|doubleclick)/i;
  for (const f of [...walk(join(root, "src")), ...walk(join(root, "public")), join(root, "index.html")]) {
    assert.ok(!banned.test(readFileSync(f, "utf8")), `third-party reference in ${f}`);
  }
});

test("the built output (when present) has no external URLs and no data: assets", { skip: !existsSync(join(root, "dist/index.html")) && "run the build first" }, () => {
  const dist = join(root, "dist");
  for (const f of walk(dist)) {
    let text = readFileSync(f, "utf8");
    text = strip(text);
    const base = f.slice(dist.length + 1).replace(/\\/g, "/");
    if (base.startsWith("assets/index-") && base.endsWith(".js")) {
      // Bundled React and router carry doc-string URLs (reactjs.org, reactrouter.com) that are never fetched.
      // Check that no network API is pointed at a remote origin instead.
      assert.ok(!/(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\(\s*["'`]https?:/.test(text), `remote request in ${base}`);
      assert.ok(!/<script[^>]+src=["']https?:/i.test(text), `remote script in ${base}`);
      continue;
    }
    if (base.startsWith("workbox-") || base === "sw.js") {
      assert.ok(!/importScripts\(\s*["']https?:/.test(text), `remote importScripts in ${base}`);
      continue;
    }
    assert.ok(!/https?:\/\//i.test(text), `external URL in dist/${base}`);
    if (base.endsWith(".css")) assert.ok(!/url\(\s*["']?data:/i.test(text), `data: url in dist/${base}`);
  }
});

test("built manifest (when present) has the required fields", { skip: !existsSync(join(root, "dist/manifest.webmanifest")) && "run the build first" }, () => {
  const m = JSON.parse(readFileSync(join(root, "dist/manifest.webmanifest"), "utf8")) as Record<string, unknown> & { icons: Array<{ src: string; sizes: string }> };
  assert.equal(m.name, "QenBel Administration");
  assert.equal(m.short_name, "QenBel");
  assert.equal(m.theme_color, "#1E55CC");
  assert.equal(m.display, "standalone");
  for (const icon of m.icons) assert.ok(existsSync(join(root, "dist", icon.src.replace(/^\//, ""))), `icon file ${icon.src}`);
  assert.ok(m.icons.some((i) => i.sizes === "192x192") && m.icons.some((i) => i.sizes === "512x512"));
});

test("built service worker (when present) precaches the shell and does not cache API calls", { skip: !existsSync(join(root, "dist/sw.js")) && "run the build first" }, () => {
  const sw = readFileSync(join(root, "dist/sw.js"), "utf8");
  assert.ok(/index\.html/.test(sw));
  assert.ok(!/StaleWhileRevalidate|NetworkFirst|CacheFirst/.test(sw), "no runtime caching strategies");
});
