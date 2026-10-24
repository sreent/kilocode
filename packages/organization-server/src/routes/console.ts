import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import embedded from "../console.gen"

// The admin console (packages/organization-console) is a static single-page app.

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
}

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ")

// The console's built files: path within the app -> file on disk (or embedded in the binary).
export class ConsoleAssets extends Context.Service<ConsoleAssets, Readonly<Record<string, string>>>()(
  "@organization/ConsoleAssets",
) {
  // Files from a directory, such as the console's Vite build output.
  static fromDirectory(dir: string) {
    return Layer.effect(
      this,
      Effect.promise(async () => {
        const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir })).catch(() => [] as string[])
        return Object.fromEntries(files.map((file) => [file.replaceAll("\\", "/"), path.join(dir, file)]))
      }),
    )
  }
}

// Release binaries embed the console (script/build.ts); from source it is read from the package's dist.
export const node = LayerNode.make({
  service: ConsoleAssets,
  layer:
    Object.keys(embedded).length > 0
      ? Layer.succeed(ConsoleAssets, embedded)
      : ConsoleAssets.fromDirectory(path.resolve(import.meta.dirname, "../../../organization-console/dist")),
  deps: [],
})

function serve(file: string, headers: Record<string, string>) {
  return HttpServerResponse.raw(Bun.file(file), {
    headers: { "content-type": mime[path.extname(file)] ?? "application/octet-stream", ...headers },
  })
}

const missing = () => HttpServerResponse.jsonUnsafe({ _tag: "NotFoundError", message: "not found" }, { status: 404 })

export const consoleRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const files = yield* ConsoleAssets
    const app = (pathname: string) =>
      Effect.sync(() => {
        const name = pathname.replace(/^\/admin\/?/, "")
        const file = name ? files[name] : undefined
        // Content-hashed build output never changes under the same name.
        if (file)
          return serve(file, {
            "cache-control": name.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
          })
        if (path.extname(name)) return missing()
        // Anything else is a console route; the app routes it client-side.
        const index = files["index.html"]
        if (!index)
          return HttpServerResponse.text(
            "The admin console is not built. Run `bun run build` in packages/organization-console.",
            {
              status: 503,
            },
          )
        return serve(index, { "content-security-policy": csp, "cache-control": "no-store" })
      })

    // Also matches /admin itself.
    yield* router.add("GET", "/admin/*", (request) => app(new URL(request.url, "http://localhost").pathname))
    yield* router.add("GET", "/", () => Effect.succeed(HttpServerResponse.redirect("/admin")))
    yield* router.add("GET", "/favicon.ico", () =>
      Effect.succeed(
        files["favicon.ico"]
          ? serve(files["favicon.ico"], { "cache-control": "public, max-age=86400" })
          : HttpServerResponse.empty(),
      ),
    )
    yield* router.add("*", "/*", () => Effect.succeed(missing()))
  }),
)
