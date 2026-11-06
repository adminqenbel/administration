// Takes screenshots of the app in headless Chrome over the DevTools protocol (no extra packages).
// Needs `vite` (dev, port 5173) and `vite preview` (port 4173) running. Output: apps/web/.screenshots/ (git-ignored).
// The dev server is used for signed-in screens because the dev sign-in stub only runs there.
// Run: node scripts/screenshots.mjs

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../.screenshots");
mkdirSync(outDir, { recursive: true });
const chromePath = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEV = "http://localhost:5173";
const PREVIEW = "http://localhost:4173";
const port = 9333;

const profile = mkdtempSync(join(tmpdir(), "qenbel-shots-"));
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await connect());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.text + " " + (msg.params.exceptionDetails.exception?.description ?? ""));
  else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") consoleErrors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ""}`);
  else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result.value);

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");

async function viewport(width, height) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
}

async function go(url) {
  await send("Page.navigate", { url });
  await sleep(900);
}

async function shot(name, { full = true } = {}) {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full, fromSurface: true });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log("wrote", name);
}

async function signedIn(pack) {
  await go(`${DEV}/sign-in`);
  await evaluate(`sessionStorage.setItem("qenbel.dev.session", JSON.stringify({displayName:"owner",businessName:"Demo business",role:"OWNER"}));` + (pack ? `localStorage.setItem("qenbel.pack", ${JSON.stringify(pack)});` : `localStorage.removeItem("qenbel.pack");`));
}

const widths = [
  ["desktop", 1280, 800],
  ["phone", 390, 844],
];

for (const [label, w, h] of widths) {
  await viewport(w, h);

  // Production build: sign-in (the dev stub is off, so it says sign-in is not set up).
  await go(`${PREVIEW}/sign-in`);
  await shot(`${label}-signin-preview`);

  // Dev server: sign-in with the dev stub on.
  await evaluate(`sessionStorage.clear(); localStorage.clear();`);
  await go(`${DEV}/sign-in`);
  await shot(`${label}-signin-dev`);

  await signedIn(null);
  await go(`${DEV}/onboarding`);
  await shot(`${label}-onboarding`);

  await signedIn("restaurant");
  for (const [name, path] of [["dashboard", "/"], ["bookings", "/bookings"], ["orders", "/orders"], ["customers", "/customers"], ["settings", "/settings"]]) {
    await go(`${DEV}${path}`);
    await shot(`${label}-restaurant-${name}`);
  }

  await signedIn("clinic");
  await go(`${DEV}/bookings`);
  await shot(`${label}-clinic-bookings`);
  await go(`${DEV}/resources`);
  await shot(`${label}-clinic-resources`);

  await signedIn("salon");
  await go(`${DEV}/catalogue`);
  await evaluate(`[...document.querySelectorAll("button")].find((b) => /^Add /.test(b.textContent))?.click()`);
  await sleep(400);
  await shot(`${label}-salon-catalogue-dialog`, { full: false });

  if (label === "phone") {
    await go(`${DEV}/`);
    await evaluate(`[...document.querySelectorAll(".qb-bottombar button")].find((b) => b.textContent.includes("More"))?.click()`);
    await sleep(400);
    await shot("phone-more-sheet", { full: false });
  }
}

// Touch target check on the phone layout and basic facts about the page.
await viewport(390, 844);
await signedIn("restaurant");
await go(`${DEV}/bookings`);
const small = await evaluate(`(() => {
  const out = [];
  for (const el of document.querySelectorAll("a, button, input, select, textarea, [role=tab]")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.height < 43.5 || r.width < 43.5) out.push((el.tagName + "." + el.className + " " + (el.textContent || el.getAttribute("aria-label") || "")).trim().slice(0, 60) + " " + Math.round(r.width) + "x" + Math.round(r.height));
  }
  return out;
})()`);
console.log("phone touch targets under 44px:", JSON.stringify(small));
const overflow = await evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
console.log("phone horizontal page overflow:", overflow);
console.log("console errors:", JSON.stringify(consoleErrors));

ws.close();
chrome.kill();
await sleep(300);
