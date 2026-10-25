# Brand

tucode's identity: its name, command, package and extension IDs, container image, managed config folder, repository, and logos. Kilo Code's names come in with every upstream merge, so the rename is a script you re-run, not a one-time edit.

| File | What it holds |
|---|---|
| `brand.json` | The names. Every other file in the tree reads them from here or is rewritten from here. |
| `rules.ts` | What `apply.ts` rewrites, file by file. |
| `apply.ts` | The script that applies the rules. |
| `applied.json` | The names the tree carries now, which `apply.ts` records. Don't edit it. |
| `icons.py` | Draws the logo and the icons. |
| `logo.svg`, `mark.svg`, `icons/` | The logo, the mark, and the sizes and formats the IDEs and the admin console use. `icons/svg.ts` holds them as markup for the sign-in pages the CLI and the organization server serve. |

## Run it

From the repository root:

```sh
bun brand/apply.ts           # rewrite the tree
bun brand/apply.ts --check   # list what would change, and exit 1 if anything would
```

Run it after every merge from Kilo upstream, then review the diff. It's safe to run again: a tree that already carries the brand doesn't change.

## What it changes

What users see:

- The product name in text people read: CLI help and tips, agent prompts, VS Code and JetBrains strings in every language, and release notes (changesets).
- Identities: the VS Code manifest (publisher, name, display name, repository), the extension ID in code, and the JetBrains plugin's ID, name, vendor and description.
- The Dockerfile, the installer script, and the icons in VS Code, JetBrains and the admin console.
- Generated constants, for code that can't import `brand.json` itself:
  - `packages/kilo-vscode/src/brand.ts`
  - `packages/kilo-jetbrains/shared/src/main/kotlin/ai/kilocode/Brand.kt`
  - `packages/kilo-jetbrains/build-tasks/src/main/kotlin/Brand.kt`

The CLI imports `brand.json` directly (`@/tucode/brand`), so it needs no rewriting.

What stays Kilo's: internal names (`KILO_*` variables, `kilo.json`, `.kilo` folders, code identifiers, setting keys), and the names of Kilo's own services where they're still mentioned ("Kilo Gateway", "Kilo account"). Keeping these keeps upstream merges small. Any other "Kilo" becomes tucode, so text that means Kilo itself, such as a release note, names the service.

## Change a name

Edit `brand.json`, then run `apply.ts` and `bun install`. `apply.ts` compares `brand.json` with `applied.json`, and replaces each value that changed wherever a tracked text file has it, docs, comments and tests included. `bun install` updates `bun.lock` when the VS Code extension's name changes.

The command and the managed config folder are the exception: `tucode` also names folders, imports and files that keep the name (`src/tucode`, `tucode-logo.svg`), so `apply.ts` doesn't replace it. If you change either, replace their mentions in docs by hand.

## Before publishing

tucode publishes under its own name everywhere. Claim these names before the first release:

- the npm organization `tucode`, for `@tucode/cli` and its platform packages
- the VS Code Marketplace publisher `tucode`, which the extension's ID `tucode.tucode` starts with
- the Open VSX namespace `tucode`
- the JetBrains Marketplace vendor `tucode`

Four values are placeholders until the repository moves to the company's GitHub organization:

- the repository
- the container image, `ghcr.io/<organization>/tucode`
- the JetBrains plugin ID
- the macOS managed-settings domain

The last two are reverse-DNS names under a domain the company owns (`com.example.tucode`), and can't change after the first release. Set all four in `brand.json` and run `apply.ts`.

## Change the icons

The mark is "tu" over a prompt, `>_`, in four pixel letters whose outlines are in `icons.py`. After changing them, draw the icons again and copy them into the packages:

```sh
pip install pillow fonttools brotli
python3 brand/icons.py
bun brand/apply.ts
```
