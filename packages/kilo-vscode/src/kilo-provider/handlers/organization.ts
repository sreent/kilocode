/**
 * Self-hosted organization handlers: status, device sign-in and sign-out.
 *
 * The CLI owns enrollment, the device flow and the org policy; these handlers drive it through
 * `kilo serve` and refresh what the policy shapes (providers, models, agents) afterwards.
 * No vscode dependency.
 */

import { getErrorMessage } from "../../kilo-provider-utils"
import type { AuthContext } from "./auth"

/** Push the current organization status to the webview. */
export async function sendOrgStatus(ctx: AuthContext): Promise<void> {
  if (!ctx.client) return
  try {
    const { data } = await ctx.client.org.status({ directory: ctx.getWorkspaceDirectory() }, { throwOnError: true })
    ctx.postMessage({ type: "orgStatus", status: data })
  } catch (error) {
    console.error("[Kilo New] KiloProvider: organization status failed:", error)
  }
}

// The policy decides which providers, models, agents and MCP servers exist, so a sign-in or
// sign-out reloads them the way switching Kilo organizations does.
async function reload(ctx: AuthContext): Promise<void> {
  ctx.invalidateProviderUsage()
  ctx.invalidateProviders()
  await ctx.disposeGlobal()
  await Promise.all([
    ctx.fetchAndSendProviders().catch((e: unknown) => console.warn("[Kilo New] providers refresh failed:", e)),
    ctx.fetchAndSendAgents().catch((e: unknown) => console.warn("[Kilo New] agents refresh failed:", e)),
  ])
}

/**
 * Start a device sign-in, show its code, and wait for the browser approval.
 *
 * @param attempt - The current sign-in attempt (pre-incremented by the caller).
 * @param getAttempt - Returns the latest attempt; a newer one, or a cancel, supersedes this one.
 */
export async function handleOrgSignin(
  ctx: AuthContext,
  input: { url?: string; org?: string },
  attempt: number,
  getAttempt: () => number,
): Promise<void> {
  if (!ctx.client) return
  const directory = ctx.getWorkspaceDirectory()
  try {
    const { data: started } = await ctx.client.org.signin(
      { directory, url: input.url?.trim() || undefined, org: input.org?.trim() || undefined },
      { throwOnError: true },
    )
    if (attempt !== getAttempt()) return
    // The webview shows the code and the link, like the Kilo sign-in, and the person opens it.
    ctx.postMessage({ type: "orgStatus", status: started })
    const { data: done } = await ctx.client.org.wait({ directory }, { throwOnError: true })
    if (attempt !== getAttempt()) return
    await reload(ctx)
    ctx.postMessage({ type: "orgStatus", status: done })
  } catch (error) {
    if (attempt !== getAttempt()) return
    ctx.postMessage({ type: "orgSigninFailed", error: getErrorMessage(error) || "Sign-in failed" })
  }
}

/** Sign out of the organization and drop its policy. */
export async function handleOrgSignout(ctx: AuthContext): Promise<void> {
  if (!ctx.client) return
  try {
    const { data } = await ctx.client.org.signout({ directory: ctx.getWorkspaceDirectory() }, { throwOnError: true })
    await reload(ctx)
    ctx.postMessage({ type: "orgStatus", status: data })
  } catch (error) {
    ctx.postMessage({ type: "error", message: getErrorMessage(error) || "Failed to sign out" })
  }
}

export type OrgRequest =
  | { type: "requestOrgStatus" }
  | { type: "orgSignin"; url?: string; org?: string }
  | { type: "orgCancel" }
  | { type: "orgSignout" }

const requests = new Set(["requestOrgStatus", "orgSignin", "orgCancel", "orgSignout"])

export function isOrgRequest(message: { type: string }): message is OrgRequest {
  return requests.has(message.type)
}

/** Routes the webview's organization requests. A newer sign-in, or a cancel, supersedes one in flight. */
export function createOrgRouter(ctx: () => AuthContext) {
  let attempt = 0
  return async (message: OrgRequest): Promise<void> => {
    if (message.type === "requestOrgStatus") return sendOrgStatus(ctx())
    if (message.type === "orgSignout") return handleOrgSignout(ctx())
    const current = ++attempt
    if (message.type === "orgCancel") return sendOrgStatus(ctx())
    return handleOrgSignin(ctx(), message, current, () => attempt)
  }
}
