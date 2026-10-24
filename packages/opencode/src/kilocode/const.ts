import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Brand } from "@/tucode/brand"

// How TU Code introduces itself to providers that attribute apps, such as OpenRouter.
export const DEFAULT_HEADERS = {
  "HTTP-Referer": Brand.repository,
  "X-Title": Brand.name,
  "User-Agent": `${Brand.name.replaceAll(" ", "-")}/${InstallationVersion}`,
}
