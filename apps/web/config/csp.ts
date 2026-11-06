// Content Security Policy for @qenbel/web. One source of truth: vite.config.ts injects the
// <meta> tag from here, public/_headers documents the production header, and test/csp.test.ts
// checks that the two agree.
//
// Production: our own origin only. No third-party origins, no inline script, no inline style,
// no eval. The API is reached on the same origin (reverse proxy at /v1), so connect-src is 'self'.
// React is bundled by Vite, fonts and icons are files we serve, the service worker is /sw.js.

export const PRODUCTION_DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'"],
  "img-src": ["'self'"],
  "font-src": ["'self'"],
  "connect-src": ["'self'"],
  "manifest-src": ["'self'"],
  "worker-src": ["'self'"],
  "form-action": ["'self'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
} as const;

// A <meta> policy cannot carry frame-ancestors (browsers ignore it there), so it is header-only.
export const HEADER_ONLY_DIRECTIVES = {
  "frame-ancestors": ["'none'"],
} as const;

type Directives = Readonly<Record<string, ReadonlyArray<string>>>;

function serialise(d: Directives): string {
  return Object.entries(d)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** Policy for the production <meta> tag. */
export function productionMetaPolicy(): string {
  return serialise(PRODUCTION_DIRECTIVES);
}

/** Policy for the production HTTP header (public/_headers). */
export function productionHeaderPolicy(): string {
  return serialise({ ...PRODUCTION_DIRECTIVES, ...HEADER_ONLY_DIRECTIVES });
}

/**
 * Policy for the Vite dev server only. The React refresh preamble is an inline script, Vite injects
 * CSS through style tags, and hot reload uses a websocket back to the dev server on this machine.
 * Nothing outside localhost is allowed even in dev.
 */
export function developmentMetaPolicy(): string {
  return serialise({
    ...PRODUCTION_DIRECTIVES,
    "script-src": ["'self'", "'unsafe-inline'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "connect-src": ["'self'", "ws://localhost:*", "ws://127.0.0.1:*"],
  });
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};
