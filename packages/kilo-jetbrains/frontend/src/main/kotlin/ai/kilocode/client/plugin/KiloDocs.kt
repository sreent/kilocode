package ai.kilocode.client.plugin

import ai.kilocode.Brand

/** Central place for documentation links so settings pages do not hardcode URLs. The pages live in this repository. */
object KiloDocs {
    const val BASE = Brand.DOCS
    const val AGENTS = "$BASE/customize/custom-modes.md"
    const val MCP = "$BASE/automate/mcp/overview.md"
    const val SKILLS = "$BASE/customize/skills.md"
    const val COMMANDS = "$BASE/customize/workflows.md"
    const val RULES = "$BASE/customize/custom-rules.md"
}
