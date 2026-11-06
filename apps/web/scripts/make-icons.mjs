// Makes the PWA icons locally, with no network and no extra packages. It draws the favicon design
// (rounded square, blue to navy, white "Q" in Hanken Grotesk from our own font file) in headless Chrome
// and saves PNGs into public/. Run: npm run icons -w @qenbel/web
// Needs Chrome at the default Windows path or CHROME_PATH. The PNGs are committed, so this only
// needs re-running if the design changes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../public");
const fontUrl = pathToFileURL(resolve(here, "../../../packages/ui/fonts/hanken-grotesk.woff2")).href;
const chrome = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!existsSync(chrome)) {
  console.error("Chrome not found. Set CHROME_PATH.");
  process.exit(1);
}

// kind "rounded": transparent corners like favicon.svg. "full": full-bleed square (maskable, Apple touch icon).
// "scale" is the Q size relative to the favicon, smaller for maskable icons so the Q stays in the safe zone.
const icons = [
  { file: "icon-192.png", size: 192, kind: "rounded", scale: 1 },
  { file: "icon-512.png", size: 512, kind: "rounded", scale: 1 },
  { file: "icon-maskable-512.png", size: 512, kind: "full", scale: 0.8 },
  { file: "apple-touch-icon.png", size: 180, kind: "full", scale: 0.9 },
];

function html({ size, kind, scale }) {
  const radius = kind === "rounded" ? 15 : 0;
  const fontSize = 42 * scale;
  const y = 32 + (47 - 32) * scale + (kind === "full" ? 0 : 0);
  return `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:"Hanken Grotesk";font-weight:300 800;src:url("${fontUrl}") format("woff2")}
html,body{margin:0;background:transparent}svg{display:block}
text{font-family:"Hanken Grotesk",sans-serif}
</style><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4C8DFF"/><stop offset="1" stop-color="#0B2A6B"/></linearGradient></defs>
<rect width="64" height="64" rx="${radius}" fill="url(#g)"/>
<text x="32" y="${y}" text-anchor="middle" font-weight="700" font-size="${fontSize}" fill="#fff">Q</text></svg>`;
}

const work = mkdtempSync(join(tmpdir(), "qenbel-icons-"));
mkdirSync(publicDir, { recursive: true });

for (const icon of icons) {
  const page = join(work, `${icon.file}.html`);
  const out = join(work, icon.file);
  writeFileSync(page, html(icon));
  const r = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--default-background-color=00000000",
      `--window-size=${icon.size},${icon.size}`,
      "--virtual-time-budget=3000",
      `--screenshot=${out}`,
      pathToFileURL(page).href,
    ],
    { stdio: "pipe" },
  );
  if (!existsSync(out)) {
    console.error(`Chrome did not write ${icon.file}`, r.stderr?.toString());
    process.exit(1);
  }
  const png = readFileSync(out);
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (w !== icon.size || h !== icon.size) {
    console.error(`${icon.file} is ${w}x${h}, expected ${icon.size}x${icon.size}`);
    process.exit(1);
  }
  writeFileSync(join(publicDir, icon.file), png);
  console.log(`wrote public/${icon.file} (${w}x${h})`);
}
