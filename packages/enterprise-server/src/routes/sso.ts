import { Clock, Effect, Exit } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { cookie } from "@enterprise/protocol/middleware"
import * as Crypto from "../crypto"
import { ServerConfig } from "../config"
import { Oidc } from "../oidc"
import { failure, page } from "../pages"
import { RequestContext } from "../request"
import { Store, type User } from "../store"

const minute = 60 * 1000
const hour = 60 * minute

const params = (request: HttpServerRequest.HttpServerRequest) => new URL(request.url, "http://localhost").searchParams

// OpenID Connect sign-in for the admin console and for device logins. Every failure is a page the
// user can read, never a JSON error in their browser.
export const ssoRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const oidc = yield* Oidc.Service
    const redirect = `${config.base}/sso/callback`
    const record = Effect.fn(function* (input: {
      org: string
      action: string
      user: User
      details: Record<string, unknown>
    }) {
      yield* store.audit.record({
        org: input.org,
        action: input.action,
        actor: { id: input.user.id, email: input.user.email },
        target: input.user.id,
        details: input.details,
        ip: yield* RequestContext.address(config),
      })
    })

    yield* router.add("GET", "/sso/:org/start", (request) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.params
        const search = params(request)
        const org = yield* store.org.get(route.org ?? "")
        if (!org) return failure("Unknown organization", "This organization does not exist.", 404)
        const sso = yield* store.sso.get(org.id)
        if (!sso) return failure("SSO not configured", "Single sign-on is not configured for this organization.", 404)
        const code = search.get("device")?.trim().toUpperCase()
        if (code) {
          const row = yield* store.device.code(code)
          if (!row || row.org !== org.id || row.status !== "pending" || row.expires < (yield* Clock.currentTimeMillis))
            return failure("Code expired", "This device code is invalid or has expired. Start the login again.", 404)
        }
        const doc = yield* oidc.discover(sso.issuer).pipe(Effect.exit)
        if (Exit.isFailure(doc))
          return failure("Sign-in unavailable", "The identity provider cannot be reached. Try again later.", 502)
        const verifier = Crypto.secret(32)
        const nonce = Crypto.secret(16)
        const state = yield* store.login.create({ org: org.id, verifier, nonce, device: code })
        const url = new URL(doc.value.authorization_endpoint)
        url.searchParams.set("response_type", "code")
        url.searchParams.set("client_id", sso.client)
        url.searchParams.set("redirect_uri", redirect)
        url.searchParams.set("scope", sso.scopes)
        url.searchParams.set("state", state)
        url.searchParams.set("nonce", nonce)
        url.searchParams.set("code_challenge", yield* Crypto.challenge(verifier))
        url.searchParams.set("code_challenge_method", "S256")
        const hint = search.get("login_hint")
        if (hint) url.searchParams.set("login_hint", hint)
        return HttpServerResponse.redirect(url)
      }),
    )

    yield* router.add("GET", "/sso/callback", (request) =>
      Effect.gen(function* () {
        const search = params(request)
        const state = search.get("state")
        const row = state ? yield* store.login.take(state) : undefined
        if (!row || (yield* Clock.currentTimeMillis) - row.created > 10 * minute)
          return failure("Sign-in expired", "This sign-in attempt is invalid or has expired. Please try again.")
        const denied = search.get("error")
        if (denied) return failure("Sign-in failed", search.get("error_description") ?? denied, 403)
        const code = search.get("code")
        if (!code) return failure("Sign-in failed", "The identity provider did not return an authorization code.")
        const org = (yield* store.org.get(row.org))!
        const sso = yield* store.sso.get(org.id)
        if (!sso || !config.secret)
          return failure("SSO not configured", "Single sign-on is not configured for this organization.", 404)

        const result = yield* Effect.gen(function* () {
          const doc = yield* oidc.discover(sso.issuer)
          const tokens = yield* oidc.exchange({
            doc,
            client: sso.client,
            secret: yield* Crypto.unseal(config.secret!, sso.secret),
            code,
            verifier: row.verifier,
            redirect,
          })
          return { doc, tokens }
        }).pipe(Effect.exit)
        if (Exit.isFailure(result)) {
          const message = result.cause.reasons.find((reason) => reason._tag === "Fail")?.error
          return failure("Sign-in failed", message?.message ?? "The identity provider could not be reached.", 502)
        }
        const { doc, tokens } = result.value
        const verified = yield* oidc.verify(doc, tokens.id_token, sso.client).pipe(Effect.exit)
        if (Exit.isFailure(verified)) {
          const message = verified.cause.reasons.find((reason) => reason._tag === "Fail")?.error
          return failure("Sign-in failed", message?.message ?? "Invalid ID token.", 403)
        }
        const claims = verified.value
        if (claims.nonce !== row.nonce) return failure("Sign-in failed", "ID token nonce mismatch.", 403)

        const profile: Record<string, unknown> =
          typeof claims.email === "string" || !tokens.access_token
            ? claims
            : { ...claims, ...(yield* oidc.userinfo(doc, tokens.access_token, claims.sub)) }
        const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : undefined
        if (!email) return failure("Sign-in failed", "The identity provider did not share an email address.", 403)
        if (profile.email_verified === false)
          return failure("Sign-in failed", "Your email address is not verified with the identity provider.", 403)
        const name = typeof profile.name === "string" ? profile.name : null

        const known = yield* store.user.find(email)
        if (known && !known.active) return failure("Account deactivated", "Your account has been deactivated.", 403)
        const access = known ? yield* store.member.role(org.id, known.id) : undefined
        const membership = known ? yield* store.member.get(org.id, known.id) : undefined
        if (membership?.suspended)
          return failure("Access suspended", "Your access to this organization is suspended.", 403)

        const user = yield* Effect.gen(function* () {
          if (access) return known
          const pending = (yield* store.invite.pending(org.id, email)).at(0)
          if (pending && (yield* store.invite.accept(pending.id))) {
            const created = yield* store.user.ensure({ email, name, external: String(claims.sub) })
            yield* store.member.add(org.id, created.id, pending.role)
            yield* record({
              org: org.id,
              action: "user.accept_invite",
              user: created,
              details: { role: pending.role, invite: pending.id, method: "sso" },
            })
            return created
          }
          // Just-in-time provisioning for people whose email domain this org has verified.
          if (sso.provision && (yield* store.domain.owner(email)) === org.id) {
            const created = yield* store.user.ensure({ email, name, external: String(claims.sub) })
            yield* store.member.add(org.id, created.id, "member")
            yield* record({
              org: org.id,
              action: "sso.auto_provision",
              user: created,
              details: { domain: email.split("@").at(-1) },
            })
            return created
          }
          return undefined
        })
        if (!user)
          return failure(
            "Not a member",
            `${email} is not a member of ${org.name}. Ask an administrator to invite you.`,
            403,
          )
        if (!user.name && name) yield* store.user.update(user.id, { name })
        yield* record({
          org: org.id,
          action: "user.login",
          user,
          details: { method: "sso", device: row.device != null },
        })

        if (row.device) {
          if (!(yield* store.device.decide(row.device, "approved", user.id)))
            return failure("Code expired", "This device code expired before sign-in finished. Start the login again.")
          return page(
            "Device approved",
            `<h1>You're signed in</h1><p>Return to your terminal or IDE. You can close this window.</p>`,
          )
        }

        const session = yield* store.token.issue({
          kind: "user",
          user: user.id,
          org: org.id,
          name: "Web session",
          ttl: 8 * hour,
        })
        return HttpServerResponse.redirect("/admin").pipe(
          HttpServerResponse.setCookieUnsafe(cookie, session.value, {
            path: "/",
            httpOnly: true,
            secure: config.base.startsWith("https://"),
            sameSite: "lax",
            maxAge: `${8 * 60 * 60} seconds`,
          }),
        )
      }),
    )
  }),
)
