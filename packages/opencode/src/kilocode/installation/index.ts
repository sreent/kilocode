import { Brand } from "@/tucode/brand"

const owner = new URL(Brand.repository).pathname.split("/")[1]

// tucode's packages, from brand/brand.json. It is published only as an npm package; the Homebrew,
// Chocolatey and Scoop names are the command's, so they match nothing Kilo publishes and find TU
// Code only where someone has packaged it under that name.
export const Npm = {
  name: Brand.npm.cli,
  path: Brand.npm.cli.replace("/", "%2f"),
}

export const Brew = {
  name: Brand.command,
  tap: `${owner}/tap`,
  formula: `${owner}/tap/${Brand.command}`,
  api: `https://formulae.brew.sh/api/formula/${Brand.command}.json`,
}

export const Choco = {
  name: Brand.command,
  api: `https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27${Brand.command}%27%20and%20IsLatestVersion&$select=Version`,
}

export const Scoop = {
  name: Brand.command,
  manifest: `https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/${Brand.command}.json`,
}

export const Release = {
  install: `${Brand.repository.replace("https://github.com/", "https://raw.githubusercontent.com/")}/main/install`,
}
