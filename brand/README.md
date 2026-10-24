# Brand

TU Code's identity: its name, command, package and extension IDs, container image, managed config folder, repository, and logos. Kilo Code's names come in with every upstream merge, so the rename is a script you re-run, not a one-time edit.

| File | What it holds |
|---|---|
| `brand.json` | The names. Every other file in the tree reads them from here or is rewritten from here. |
| `rules.ts` | What `apply.ts` rewrites, file by file. |
| `apply.ts` | The script that applies the rules. |
| `logo.svg`, `mark.svg`, `icons/` | The logo and the icon sizes the IDEs and the admin console use. |
| `icon-font.py` | Builds `icons/icon-font.woff2`, the VS Code status bar icon, from `mark.svg`. |

## Run it

From the repository root:

```sh
bun brand/apply.ts           # rewrite the tree
bun brand/apply.ts --check   # list what would change, and exit 1 if anything would
```

Run it after every merge from Kilo upstream, then review the diff. It's safe to run again: a tree that already carries the brand doesn't change.

## What it changes

What users see:

- The product name in text people read: CLI help and tips, agent prompts, VS Code and JetBrains strings in every language.
- Identities: the VS Code manifest (publisher, name, display name, repository) and the extension ID in code.
- The Dockerfile, the installer script, and the icons in VS Code, JetBrains and the admin console.
- Generated constants, for code that can't import `brand.json` itself:
  - `packages/kilo-vscode/src/brand.ts`
  - `packages/kilo-jetbrains/shared/src/main/kotlin/ai/kilocode/Brand.kt`
  - `packages/kilo-jetbrains/build-tasks/src/main/kotlin/Brand.kt`

The CLI imports `brand.json` directly (`@/tucode/brand`), so it needs no rewriting.

What stays Kilo's: internal names (`KILO_*` variables, `kilo.json`, `.kilo` folders, code identifiers, setting keys), and the names of Kilo's own services where they're still mentioned ("Kilo Gateway"). Keeping these keeps upstream merges small.

## Before publishing

The values in `brand.json` are placeholders. Replace them with ones you control before you publish anything, then run `apply.ts` again:

- the npm scope
- the VS Code publisher
- the JetBrains plugin ID and vendor
- the container image
- the repository

Rebuild `icons/icon-font.woff2` with `icon-font.py` if you change `mark.svg`. It needs fontTools and brotli: `pip install fonttools brotli`.
