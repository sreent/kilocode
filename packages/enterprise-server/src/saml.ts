import { X509Certificate } from "node:crypto"
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from "@node-saml/node-saml"
import { DOMParser } from "@xmldom/xmldom"
import { Effect, Schema } from "effect"
import { escape } from "./pages"
import type { SamlConnection } from "./store"

// SAML 2.0 single sign-on, with this server as the service provider: its metadata, the
// AuthnRequests it sends, and checking the identity provider's responses. node-saml does the XML
// signature work; everything here is local, no request leaves the server.

const minute = 60 * 1000
const md = "urn:oasis:names:tc:SAML:2.0:metadata"
const ds = "http://www.w3.org/2000/09/xmldsig#"
const redirect = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
const post = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"

// Responses are accepted for ten minutes after the identity provider issues them; assertions that
// were used are remembered a little longer than that, so none can be used twice.
export const maxAge = 10 * minute
export const remember = 15 * minute

export class SamlError extends Schema.TaggedErrorClass<SamlError>()("SamlError", { message: Schema.String }) {}

export type ServiceProvider = { readonly entity_id: string; readonly acs_url: string; readonly metadata_url: string }

/** What this server is called at the identity provider, per org, and where responses come back. */
export function provider(base: string, slug: string): ServiceProvider {
  const entity = `${base}/sso/saml/${slug}`
  return { entity_id: entity, acs_url: `${entity}/acs`, metadata_url: `${entity}/metadata` }
}

/** This server's metadata, for identity providers that import it instead of typing in the URLs. */
export function metadata(sp: ServiceProvider) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="${md}" entityID="${escape(sp.entity_id)}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService Binding="${post}" Location="${escape(sp.acs_url)}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>
`
}

// ---- configuration: the identity provider's metadata and certificates ----------------------

const fail = (message: string) => new SamlError({ message })

/** One or more certificates, as PEM blocks or the bare base64 that metadata and admin pages show. */
export function certificates(input: string): string[] {
  const blocks = input.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
  const bodies = blocks ? blocks.map((block) => block.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")) : [input]
  return bodies.map((body) => {
    const base64 = body.replace(/\s+/g, "")
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw fail("the certificate must be PEM or base64")
    const pem = `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`
    try {
      new X509Certificate(pem)
    } catch {
      throw fail("the certificate is not a valid X.509 certificate")
    }
    return pem
  })
}

/** Subject, SHA-256 fingerprint and expiry, so admins can match a certificate to their IdP. */
export function describe(pem: string) {
  const cert = new X509Certificate(pem)
  return {
    subject: cert.subject.replaceAll("\n", ", "),
    fingerprint: cert.fingerprint256,
    expires: Date.parse(cert.validTo),
  }
}

const children = (parent: Element, ns: string, name: string) => Array.from(parent.getElementsByTagNameNS(ns, name))

/** The entity ID, sign-in URL and signing certificates from an identity provider's metadata. */
export function idp(xml: string) {
  const invalid = (message: string) => {
    throw fail(`the metadata is not valid XML: ${message.split("\n")[0]}`)
  }
  const doc = new DOMParser({ errorHandler: { error: invalid, fatalError: invalid } }).parseFromString(xml, "text/xml")
  const entities = children(doc.documentElement!, md, "EntityDescriptor")
  if (doc.documentElement?.localName === "EntityDescriptor") entities.unshift(doc.documentElement)
  const found = entities.filter((entity) => children(entity, md, "IDPSSODescriptor").length > 0)
  if (found.length === 0) throw fail("the metadata does not describe an identity provider")
  if (found.length > 1) throw fail("the metadata describes several identity providers; use the one for this app")
  const entity = found[0]!
  const descriptor = children(entity, md, "IDPSSODescriptor")[0]!
  const service = children(descriptor, md, "SingleSignOnService").find(
    (element) => element.getAttribute("Binding") === redirect,
  )
  if (!service) throw fail("the identity provider does not accept sign-in requests by redirect (HTTP-Redirect binding)")
  const signing = children(descriptor, md, "KeyDescriptor")
    .filter((key) => !key.getAttribute("use") || key.getAttribute("use") === "signing")
    .flatMap((key) => children(key, ds, "X509Certificate").map((cert) => cert.textContent ?? ""))
  if (signing.length === 0) throw fail("the metadata has no signing certificate")
  return {
    entity: entity.getAttribute("entityID") ?? "",
    entry: service.getAttribute("Location") ?? "",
    certificates: signing.flatMap(certificates),
  }
}

/**
 * The connection settings from metadata, typed-in fields, or both (fields win). What neither gives
 * stays as the current connection has it, so changing a toggle doesn't need the certificate again.
 */
export const settings = Effect.fn("Saml.settings")(function* (
  input: {
    readonly metadata?: string
    readonly entity_id?: string
    readonly sso_url?: string
    readonly certificate?: string
  },
  current?: SamlConnection,
) {
  return yield* Effect.try({
    try: () => {
      const meta = input.metadata ? idp(input.metadata) : undefined
      const entity = input.entity_id?.trim() || meta?.entity || current?.issuer
      const entry = input.sso_url?.trim() || meta?.entry || current?.entry
      const certs = input.certificate ? certificates(input.certificate) : (meta?.certificates ?? current?.certificates)
      if (!entity || !entry || !certs)
        throw fail("give the identity provider's metadata, or its entity ID, sign-in URL and certificate")
      if (!/^https?:\/\/\S+$/.test(entry)) throw fail("the sign-in URL must be an http(s) URL")
      return { entity, entry, certificates: [...certs] }
    },
    catch: (error) => (error instanceof SamlError ? error : fail(String(error))),
  })
})

// ---- signing in -----------------------------------------------------------------------------

/** The request a response answers: its ID and when this server sent it. */
export type Request = { readonly id: string; readonly sent: number }

// node-saml checks a response's InResponseTo against this cache, whose values are when each request
// was sent. The sign-in row this server keeps for each request is the real record, so the cache only
// knows the one request a response may answer.
function cache(expected?: Request): CacheProvider {
  const known = (key: string) =>
    expected !== undefined && key === expected.id ? new Date(expected.sent).toISOString() : null
  return {
    saveAsync: async (_key, value) => ({ value, createdAt: Date.now() }),
    getAsync: async (key) => known(key),
    removeAsync: async (key) => known(key ?? ""),
  }
}

function client(sso: SamlConnection, sp: ServiceProvider, options: { id?: string; expected?: Request }) {
  return new SAML({
    entryPoint: sso.entry,
    issuer: sp.entity_id,
    audience: sp.entity_id,
    callbackUrl: sp.acs_url,
    idpCert: [...sso.certificates],
    idpIssuer: sso.issuer,
    // The identity provider's signature must cover the assertion: on the response or the assertion.
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: false,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    // Let the identity provider pick the NameID format and authentication context, so it never
    // refuses a request over them; the email comes from the attributes or the NameID.
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 2 * minute,
    maxAssertionAgeMs: maxAge,
    validateInResponseTo: sso.unsolicited ? ValidateInResponseTo.ifPresent : ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: maxAge,
    cacheProvider: cache(options.expected),
    generateUniqueId: () => options.id ?? `_${crypto.randomUUID()}`,
  })
}

/** The identity provider URL that starts a sign-in; its response must answer request `id`. */
export const authorize = (sso: SamlConnection, sp: ServiceProvider, state: string, id: string) =>
  Effect.tryPromise({
    try: () => client(sso, sp, { id }).getAuthorizeUrlAsync(state, undefined, {}),
    catch: (error) => fail(error instanceof Error ? error.message : String(error)),
  })

/**
 * Check a response posted back by the identity provider. `expected` is the request it answers, or
 * undefined for a sign-in the identity provider started itself.
 */
export const validate = (sso: SamlConnection, sp: ServiceProvider, response: string, expected?: Request) =>
  Effect.tryPromise({
    try: async () => {
      const { profile } = await client(sso, sp, { expected }).validatePostResponseAsync({ SAMLResponse: response })
      if (!profile) throw fail("the response has no assertion")
      // node-saml checks the issuer only on logout messages. Checked here, so an identity provider
      // that shares a signing key with another (one key for every tenant) can't sign in for it.
      if (profile.issuer !== sso.issuer)
        throw fail(`it was issued by ${profile.issuer || "an unnamed identity provider"}, not ${sso.issuer}`)
      return profile
    },
    catch: (error) =>
      error instanceof SamlError ? error : fail(error instanceof Error ? error.message : String(error)),
  })

// ---- who signed in ----------------------------------------------------------------------------

const keys = {
  email: [
    "email",
    "mail",
    "emailAddress",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "urn:oid:0.9.2342.19200300.100.1.3",
    "urn:oid:1.2.840.113549.1.9.1",
  ],
  name: [
    "displayName",
    "http://schemas.microsoft.com/identity/claims/displayname",
    "urn:oid:2.16.840.1.113730.3.1.241",
  ],
  given: [
    "givenName",
    "firstName",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    "urn:oid:2.5.4.42",
  ],
  family: [
    "sn",
    "surname",
    "lastName",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
    "urn:oid:2.5.4.4",
  ],
}

function attribute(profile: Profile, names: ReadonlyArray<string>) {
  const attributes = (profile.attributes ?? {}) as Record<string, unknown>
  for (const name of names) {
    const raw = attributes[name] ?? profile[name]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

/** The email the identity provider vouches for: an email attribute, else an email-shaped NameID. */
export function email(profile: Profile) {
  const value = attribute(profile, keys.email) ?? (profile.nameID?.includes("@") ? profile.nameID : undefined)
  return value?.trim().toLowerCase()
}

export function name(profile: Profile) {
  const full = attribute(profile, keys.name)
  if (full) return full
  const parts = [attribute(profile, keys.given), attribute(profile, keys.family)].filter(Boolean)
  return parts.length > 0 ? parts.join(" ") : null
}

/** The assertion's ID, which a sign-in uses up. */
export function assertion(profile: Profile) {
  const parsed = profile.getAssertion?.() as { Assertion?: { $?: { ID?: string } } } | undefined
  return parsed?.Assertion?.$?.ID
}
