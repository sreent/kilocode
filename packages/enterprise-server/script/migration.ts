#!/usr/bin/env bun

// Generates TypeScript database migrations from src/db/schema.sql.ts, the same way core does:
// drizzle-kit diffs the schema against the last snapshot, and the SQL it emits becomes an
// append-only migration plus a regenerated registry. `--check` fails when either is stale.

import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { parseArgs } from "util"

const root = path.resolve(import.meta.dirname, "..")
const snapshot = path.join(root, "schema.json")
const dir = path.join(root, "src/db/migration")
const registry = path.join(root, "src/db/migration.gen.ts")
const args = parseArgs({
  args: process.argv.slice(2),
  options: { check: { type: "boolean" }, name: { type: "string" } },
})

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "enterprise-migration-"))
try {
  const out = path.join(temporary, "out")
  await fs.mkdir(out)
  if (await Bun.file(snapshot).exists()) {
    await fs.mkdir(path.join(out, "baseline"))
    await fs.copyFile(snapshot, path.join(out, "baseline/snapshot.json"))
  }
  const config = path.join(temporary, "drizzle.config.ts")
  await Bun.write(
    config,
    `import config from ${JSON.stringify(pathToFileURL(path.join(root, "drizzle.config.ts")).href)}

export default { ...config, out: ${JSON.stringify(out)} }
`,
  )
  await $`bun drizzle-kit generate --config ${config} ${args.values.name ? ["--name", args.values.name] : []}`.cwd(root)
  const generated = (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: out })))
    .map((file) => file.split("/")[0])
    .sort()
  if (generated.length > 1) throw new Error(`Expected one generated migration, found ${generated.length}.`)
  const name = generated[0]

  if (args.values.check) {
    if (name) throw new Error("The schema has ungenerated migrations. Run `bun run migration`.")
    if ((await Bun.file(registry).text()) !== (await format(render(await names()))))
      throw new Error("The migration registry is stale. Run `bun run migration`.")
    process.exit(0)
  }

  if (name) {
    const target = path.join(dir, `${name}.ts`)
    if (await Bun.file(target).exists()) throw new Error(`Migration already exists: ${name}`)
    await Bun.write(target, await format(migration(name, await Bun.file(path.join(out, name, "migration.sql")).text())))
    await fs.copyFile(path.join(out, name, "snapshot.json"), snapshot)
    console.log(`created src/db/migration/${name}.ts`)
  }
  await Bun.write(registry, await format(render(await names())))
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}

async function names() {
  return (await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: dir })))
    .map((file) => path.basename(file, ".ts"))
    .sort()
}

function migration(name: string, source: string) {
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map(
      (statement) =>
        `      yield* tx.run(\`\n${statement
          .split("\n")
          .map((line) => `        ${escape(line.replaceAll("\t", "  "))}`)
          .join("\n")}\n      \`)`,
    )
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: ${JSON.stringify(name)},
  up(tx) {
    return Effect.gen(function* () {
${statements.join("\n")}
    })
  },
} satisfies DatabaseMigration.Migration
`
}

function render(list: string[]) {
  return `import type { DatabaseMigration } from "./migration"

export const migrations = (
  await Promise.all([
${list.map((name) => `    import("./migration/${name}"),`).join("\n")}
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]
`
}

function escape(line: string) {
  return line.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")
}

async function format(input: string) {
  const prettier = await import("prettier")
  const typescript = await import("prettier/plugins/typescript")
  const estree = await import("prettier/plugins/estree")
  return prettier.format(input, {
    parser: "typescript",
    plugins: [typescript.default, estree.default],
    semi: false,
    printWidth: 120,
  })
}
