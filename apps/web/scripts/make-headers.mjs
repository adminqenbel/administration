// Regenerates public/_headers from config/csp.ts. Run: npm run headers -w @qenbel/web
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productionHeaderPolicy, SECURITY_HEADERS } from "../config/csp.ts";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../public/_headers");

const lines = [
  "# Production response headers for QenBel Administration (web).",
  "# Format: Netlify/Cloudflare Pages style _headers. The deploy target is not chosen yet; if the web app is",
  "# served by nginx, Caddy or the API itself, set these same headers there. Nothing is deployed from this repo",
  "# without the owner approving it.",
  "#",
  "# Content-Security-Policy: our own origin only. No third-party scripts, styles, fonts, images, frames or",
  "# connections. The API is reached on the same origin under /v1 (reverse proxy), so connect-src stays self.",
  "# The same policy (minus frame-ancestors, which only works as a header) is in the built index.html meta tag.",
  "# apps/web/config/csp.ts is the source; test/csp.test.ts fails if this file drifts from it.",
  "# If a later stage needs another origin (for example Clerk sign-in), add it to config/csp.ts, regenerate",
  "# this file (npm run headers -w @qenbel/web) and review the change. Do not loosen the policy here by hand.",
  "",
  "/*",
  "  Content-Security-Policy: " + productionHeaderPolicy(),
  ...Object.entries(SECURITY_HEADERS).map(([k, v]) => "  " + k + ": " + v),
  "",
  "# Hashed build files never change, so they can be cached for a long time.",
  "/assets/*",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
  "# The service worker and the HTML shell must always be revalidated.",
  "/sw.js",
  "  Cache-Control: no-cache",
  "/index.html",
  "  Cache-Control: no-cache",
  "",
];
writeFileSync(out, lines.join("\n"));
console.log("wrote public/_headers");
