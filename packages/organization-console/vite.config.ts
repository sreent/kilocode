import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"

// Same Vite setup as Kilo's other SolidJS apps on @kilocode/kilo-ui. The console is served by the
// control plane under /admin; in development, API calls are proxied to a local server.
const empty = fileURLToPath(new URL("./src/empty.css", import.meta.url))
const target = process.env.ORGANIZATION_URL ?? "http://localhost:8787"

export default defineConfig({
  base: "/admin/",
  plugins: [solidPlugin()],
  server: {
    proxy: Object.fromEntries(["/api", "/sso", "/scim"].map((path) => [path, { target, changeOrigin: false }])),
  },
  resolve: {
    // The console renders no math; keep KaTeX's stylesheet out of the bundle.
    alias: [{ find: /^katex\/dist\/katex\.min\.css$/, replacement: empty }],
    conditions: ["browser", "solid", "module", "import"],
    dedupe: ["solid-js", "solid-js/web", "solid-js/store"],
  },
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
  },
})
