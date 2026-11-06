import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const theme = read("src/theme.css");
const components = read("src/components.css");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ---- contrast helpers (WCAG 2.x) ----
type RGB = [number, number, number];
function hex(h: string): RGB {
  const v = h.replace("#", "");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
function over(fg: RGB, alpha: number, bg: RGB): RGB {
  return [0, 1, 2].map((i) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as RGB;
}
function lum([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a: RGB, b: RGB): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
function token(name: string): string {
  const m = theme.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(m, `token --${name} missing`);
  return m[1]!.trim();
}

const WHITE: RGB = [255, 255, 255];

test("brand tokens match docs/BRAND.md exactly", () => {
  assert.equal(token("ink"), "#071A44");
  assert.equal(token("ink-2"), "rgba(7, 26, 68, 0.76)");
  assert.equal(token("blue"), "#1E55CC");
  assert.equal(token("blue-dark"), "#17449F");
  assert.equal(token("navy"), "#0B2A6B");
  assert.equal(token("pale"), "#F2F7FE");
  assert.equal(token("hair"), "rgba(7, 26, 68, 0.14)");
});

test("Hanken Grotesk is self-hosted with relative urls that exist", () => {
  const faces = theme.match(/@font-face[^}]+}/g) ?? [];
  assert.equal(faces.length, 2);
  for (const face of faces) {
    const m = face.match(/url\("([^"]+)"\)/);
    assert.ok(m, "font-face has a url");
    const url = m[1]!;
    assert.ok(url.startsWith("../fonts/"), `relative url: ${url}`);
    assert.ok(existsSync(join(root, "src", url)), `font file exists: ${url}`);
  }
  assert.ok(/font-style:\s*italic/.test(theme));
  assert.ok(/font-weight:\s*300 800/.test(theme));
  assert.ok(existsSync(join(root, "favicon.svg")));
});

test("no external URLs in CSS, components or favicon", () => {
  const files = [...walk(join(root, "src")), join(root, "favicon.svg")];
  for (const f of files) {
    const text = readFileSync(f, "utf8").replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
    assert.ok(!/https?:\/\//i.test(text), `external url in ${f}`);
    assert.ok(!/(^|[^:])\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(text.replace(/\/\/ .*/g, "")), `protocol-relative url in ${f}`);
    assert.ok(!/@import/.test(text), `@import in ${f}`);
  }
  for (const css of [theme, components]) {
    for (const m of css.matchAll(/url\(\s*["']?([^)"']+)/g)) {
      assert.ok(!/^(https?:|\/\/|data:)/i.test(m[1]!), `bad url() ${m[1]}`);
    }
  }
});

test("flat: no gradients, shadows or glass in CSS or components", () => {
  for (const css of [theme, components]) {
    assert.ok(!/gradient\(/i.test(css), "gradient");
    assert.ok(!/box-shadow|text-shadow|drop-shadow/i.test(css), "shadow");
    assert.ok(!/backdrop-filter|filter:\s*blur/i.test(css), "glass");
  }
  for (const f of walk(join(root, "src")).filter((p) => p.endsWith(".tsx"))) {
    assert.ok(!/style=\{/.test(readFileSync(f, "utf8")), `inline style in ${f} would break a strict CSP`);
  }
  // The favicon is the one gradient exception.
  assert.ok(/linearGradient/.test(read("favicon.svg")));
});

test("focus ring is 3px blue with 3px offset, reduced motion is handled", () => {
  assert.match(theme, /:focus-visible\s*{\s*outline:\s*3px solid var\(--blue\);\s*outline-offset:\s*3px/);
  assert.match(theme, /prefers-reduced-motion:\s*reduce/);
});

test("pill buttons and 44px touch target", () => {
  assert.match(theme, /--pill:\s*999px/);
  assert.match(theme, /--target:\s*2\.75rem/);
  assert.match(components, /\.qb-btn\s*{[^}]*border-radius:\s*var\(--pill\)/);
  assert.match(components, /\.qb-btn\s*{[^}]*min-height:\s*var\(--target\)/);
});

test("text contrast is at least 4.5:1, control borders at least 3:1", () => {
  const pale = hex("#F2F7FE");
  const ink = hex("#071A44");
  const ink2 = (bg: RGB) => over(ink, 0.76, bg);
  const ink3 = (bg: RGB) => over(ink, 0.68, bg);
  const checks: Array<[string, RGB, RGB, number]> = [
    ["ink on white", ink, WHITE, 4.5],
    ["ink-2 on white", ink2(WHITE), WHITE, 4.5],
    ["ink-2 on pale", ink2(pale), pale, 4.5],
    ["ink-3 (placeholder) on white", ink3(WHITE), WHITE, 4.5],
    ["blue on white", hex("#1E55CC"), WHITE, 4.5],
    ["blue on pale", hex("#1E55CC"), pale, 4.5],
    ["white on blue (button)", WHITE, hex("#1E55CC"), 4.5],
    ["white on blue-dark (hover)", WHITE, hex("#17449F"), 4.5],
    ["white on navy (toast)", WHITE, hex("#0B2A6B"), 4.5],
    ["blue-dark on pale (info badge)", hex("#17449F"), pale, 4.5],
    ["success on success-bg", hex(token("success")), hex(token("success-bg")), 4.5],
    ["warning on warning-bg", hex(token("warning")), hex(token("warning-bg")), 4.5],
    ["danger on danger-bg", hex(token("danger")), hex(token("danger-bg")), 4.5],
    ["danger on white", hex(token("danger")), WHITE, 4.5],
    ["white on success (toast)", WHITE, hex(token("success")), 4.5],
    ["white on danger (toast, danger button)", WHITE, hex(token("danger")), 4.5],
    ["white on #7F1817 (danger hover)", WHITE, hex("#7F1817"), 4.5],
    ["line-strong on white (control border)", over(ink, 0.5, WHITE), WHITE, 3],
  ];
  for (const [name, fg, bg, min] of checks) {
    const r = ratio(fg, bg);
    assert.ok(r >= min, `${name}: ${r.toFixed(2)} < ${min}`);
  }
});

test("components cover the required set", () => {
  const index = read("src/index.ts");
  for (const name of ["Logo", "Button", "Chip", "Field", "Input", "Select", "Textarea", "Table", "Tabs", "Dialog", "ToastProvider", "PageHeader", "EmptyState", "StatusBadge", "Skeleton", "AppShell"]) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(index), `${name} exported`);
  }
});
