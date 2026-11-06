import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { developmentMetaPolicy, productionMetaPolicy } from "./config/csp.ts";

// Puts the Content Security Policy <meta> tag into index.html.
// The dev server gets the looser dev policy, builds get the strict production one.
function cspMeta(): Plugin {
  return {
    name: "qenbel-csp-meta",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const policy = ctx.server ? developmentMetaPolicy() : productionMetaPolicy();
        return html.replace("<!--csp-->", `<meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    cspMeta(),
    VitePWA({
      // The offline shell only: precache the built files so the app frame opens without a network.
      // No runtime caching of API calls or any tenant data, ever.
      registerType: "autoUpdate",
      injectRegister: "script", // a separate registerSW.js file, so no inline script is needed
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "QenBel Administration",
        short_name: "QenBel",
        description: "Bookings, orders and customers for your business.",
        lang: "en",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: "#1E55CC",
        background_color: "#FFFFFF",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff2,svg,png,webmanifest}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/v1\//, /^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [],
      },
    }),
  ],
  build: {
    assetsInlineLimit: 0, // never inline assets as data: URIs (the CSP does not allow them)
    sourcemap: false,
  },
  server: { host: "localhost", port: 5173, strictPort: false },
  preview: { host: "localhost", port: 4173 },
});
