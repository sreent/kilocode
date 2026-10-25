#!/usr/bin/env bun
// Rewrites what users see from Kilo Code's names to the ones in brand.json: the product name, the
// command, package and extension identities, logos and the managed config path. Internal names stay
// (KILO_* variables, kilo.json, .kilo folders, code identifiers), so merges from Kilo stay small.
//
// Run it from the repository root after every merge from Kilo upstream, which brings new strings
// in Kilo's name:
//
//   bun brand/apply.ts          rewrite the tree
//   bun brand/apply.ts --check  list what would change, and exit 1 if anything would

import { Glob } from "bun"
import fs from "node:fs"
import path from "node:path"
import * as prettier from "prettier"
import brand from "./brand.json"
import { rules } from "./rules"

const root = path.resolve(import.meta.dir, "..")
const check = process.argv.includes("--check")

// A longer name can push a line past the print width. A file Prettier had formatted is formatted
// again after the rewrite; any other file keeps the layout upstream gave it.
const ignore = [path.join(root, ".gitignore"), path.join(root, ".prettierignore")]
async function format(file: string, before: string, after: string) {
  const info = await prettier.getFileInfo(file, { ignorePath: ignore })
  if (info.ignored || !info.inferredParser) return after
  const options = { ...(await prettier.resolveConfig(file)), filepath: file }
  return (await prettier.check(before, options)) ? prettier.format(after, options) : after
}

// Paths no rule touches, whatever its globs match.
const skipped = [/(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)\.git\//, /(^|\/)\.gradle\//]

let changed = 0
const report = (file: string, rule: string) => {
  changed++
  console.log(`${check ? "would change" : "changed"} ${file} (${rule})`)
}

for (const rule of rules(brand)) {
  if ("generated" in rule) {
    for (const [target, content] of Object.entries(rule.generated)) {
      const file = path.join(root, target)
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) continue
      report(target, rule.name)
      if (check) continue
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
    continue
  }
  if ("assets" in rule) {
    for (const [target, source] of Object.entries(rule.assets)) {
      const content = fs.readFileSync(path.join(root, source))
      const file = path.join(root, target)
      if (fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), content) === 0) continue
      report(target, rule.name)
      if (check) continue
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
    continue
  }
  const files = new Set<string>()
  for (const pattern of rule.files)
    for (const file of new Glob(pattern).scanSync({ cwd: root, dot: true }))
      if (!skipped.some((skip) => skip.test(file))) files.add(file)
  for (const file of [...files].sort()) {
    const target = path.join(root, file)
    const before = fs.readFileSync(target, "utf8")
    const after = rule.apply(before, file)
    if (after === before) continue
    report(file, rule.name)
    if (!check) fs.writeFileSync(target, await format(target, before, after))
  }
}

console.log(
  changed === 0 ? "The tree already carries the brand." : `${changed} file(s) ${check ? "to rebrand" : "rebranded"}.`,
)
if (check && changed > 0) process.exit(1)
