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
//
// brand/applied.json records the brand the tree carries. When brand.json changes a value, the old
// one is replaced wherever the tree spells it, in every tracked text file but bun.lock, which
// `bun install` rewrites.

import { Glob } from "bun"
import fs from "node:fs"
import path from "node:path"
import * as prettier from "prettier"
import brand from "./brand.json"
import { rules, spellings } from "./rules"

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

const record = path.join(root, "brand", "applied.json")
const applied: typeof brand = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, "utf8")) : brand
const next = spellings(brand)
const swaps = new Map<string, string>()
spellings(applied).forEach((old, index) => {
  const value = next.at(index)
  if (!old || value == null || old === value || swaps.has(old)) return
  swaps.set(old, value)
})
if (swaps.size > 0) {
  // One pass, longest spelling first, so a replacement is never replaced again. A spelling that
  // starts or ends with a letter must not be part of a longer name there.
  const pattern = new RegExp(
    [...swaps.keys()]
      .sort((a, b) => b.length - a.length)
      .map(
        (value) =>
          (/^\w/.test(value) ? "(?<!\\w)" : "") +
          value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          (/\w$/.test(value) ? "(?!\\w)" : ""),
      )
      .join("|"),
    "g",
  )
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root }).stdout.toString().split("\0")
  for (const file of tracked.filter(Boolean).sort()) {
    if (["brand/brand.json", "brand/applied.json", "bun.lock"].includes(file)) continue
    const target = path.join(root, file)
    if (!fs.existsSync(target)) continue
    const bytes = fs.readFileSync(target)
    if (bytes.includes(0)) continue
    const before = bytes.toString("utf8")
    const after = before.replace(pattern, (match) => swaps.get(match) ?? match)
    if (after === before) continue
    report(file, "Brand values")
    if (!check) fs.writeFileSync(target, await format(target, before, after))
  }
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

const content = JSON.stringify(brand, null, 2) + "\n"
if (!fs.existsSync(record) || fs.readFileSync(record, "utf8") !== content) {
  report("brand/applied.json", "Applied brand")
  if (!check) fs.writeFileSync(record, content)
}

console.log(
  changed === 0 ? "The tree already carries the brand." : `${changed} file(s) ${check ? "to rebrand" : "rebranded"}.`,
)
if (check && changed > 0) process.exit(1)
