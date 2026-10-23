#!/usr/bin/env bun

// Builds the single-file server binary with the admin console embedded. The console's Vite build
// is turned into a module of `with { type: "file" }` imports (the same technique upstream uses for
// its embedded web UI), which replaces the src/console.gen.ts stub in the bundle.

import { $ } from "bun"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")
const app = path.resolve(root, "../enterprise-console")
const dist = path.join(app, "dist")
const outfile = process.argv[2] ?? path.join(root, "dist/enterprise-server")

await $`bun run build`.cwd(app)
const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
  .map((file) => file.replaceAll("\\", "/"))
  .filter((file) => !file.endsWith(".map"))
  .sort()
if (!files.includes("index.html")) throw new Error(`console build produced no index.html in ${dist}`)
const embedded = [
  ...files.map((file, i) => `import file_${i} from ${JSON.stringify(path.join(dist, file))} with { type: "file" }`),
  `export default {`,
  ...files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`),
  `} as Record<string, string>`,
].join("\n")

const result = await Bun.build({
  entrypoints: [path.join(root, "src/index.ts")],
  minify: true,
  compile: {
    outfile,
    // A bunfig.toml in the directory the binary is started from must not change its behaviour.
    autoloadBunfig: false,
    autoloadDotenv: false,
  },
  files: { [path.join(root, "src/console.gen.ts")]: embedded },
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`built ${path.relative(process.cwd(), outfile)} with ${files.length} console files`)
