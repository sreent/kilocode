import brand from "../../brand/brand.json"

/**
 * Where a release publishes besides its GitHub release. A store publishes only once the repository
 * has its credentials (see FORK.md, "Releasing"), so a release can start with GitHub alone and add
 * stores as their names are claimed.
 */
export const Channels = {
  /** npm, with a token, or through trusted publishing once the packages exist. */
  npm: !!process.env.NODE_AUTH_TOKEN || process.env.NPM_TRUSTED_PUBLISHING === "true",
  /**
   * npm provenance, which npm accepts only from a public repository. The release workflow turns it
   * off for a private one.
   */
  provenance: process.env.NPM_CONFIG_PROVENANCE !== "false",
  /** The VS Code Marketplace. */
  vscode: !!process.env.VSCE_PAT,
  /** Open VSX. */
  openvsx: !!process.env.OPENVSX_TOKEN,
  /**
   * Kilo's own listings: @kilocode/sdk and @kilocode/plugin on npm, the AUR package and the
   * Homebrew tap. Only a build carrying Kilo's identity updates them.
   */
  kilo: brand.repository === "https://github.com/Kilo-Org/kilocode",
}
