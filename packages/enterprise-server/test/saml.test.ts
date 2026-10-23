import { describe, expect, test } from "bun:test"
import { inflateRawSync } from "node:zlib"
import { SignedXml } from "xml-crypto"
import { setup, type Env } from "./fixture"

// A SAML identity provider in miniature: it reads the server's AuthnRequest from the redirect and
// signs the response a browser would post back, so the server is exercised with real XML signatures.

const fixture = (name: string) => Bun.file(new URL(`./fixtures/saml/${name}`, import.meta.url)).text()
const idp = { key: await fixture("idp.key"), cert: await fixture("idp.crt") }
const rogue = { key: await fixture("rogue.key"), cert: await fixture("rogue.crt") }
const entity = "https://idp.example.com/saml/metadata"
const entry = "https://idp.example.com/saml/sso"
const acs = "http://localhost:8787/sso/saml/acme/acs"
const audience = "http://localhost:8787/sso/saml/acme"

const base64 = (pem: string) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, "")

function metadata(certs = [idp.cert]) {
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entity}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    ${certs.map((cert) => `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${base64(cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`).join("")}
    <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${base64(rogue.cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${entry}/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${entry}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`
}

// The AuthnRequest the server sent the browser to the identity provider with.
function request(location: string) {
  const url = new URL(location)
  const xml = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")).toString()
  return { url, xml, id: xml.match(/ ID="([^"]+)"/)![1]!, relay: url.searchParams.get("RelayState") ?? undefined }
}

type Assert = {
  email?: string
  nameID?: string
  attributes?: Record<string, string>
  inResponseTo?: string
  issuer?: string
  audience?: string
  recipient?: string
  signer?: { key: string; cert: string }
  sign?: "assertion" | "response" | "none"
  issued?: Date
  id?: string
}

const sha256 = {
  signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
}
const transforms = ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"]

function sign(xml: string, element: "Assertion" | "Response", signer: { key: string; cert: string }) {
  const signature = new SignedXml({ privateKey: signer.key, publicCert: signer.cert, ...sha256 })
  signature.addReference({
    xpath: `//*[local-name(.)='${element}']`,
    transforms,
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  })
  signature.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='${element}']/*[local-name(.)='Issuer']`, action: "after" },
  })
  return signature.getSignedXml()
}

// The SAMLResponse a browser would post to the server's ACS, base64 like the HTTP-POST binding.
function respond(input: Assert) {
  const issued = input.issued ?? new Date()
  const later = new Date(issued.getTime() + 5 * 60 * 1000)
  const nameID = input.nameID ?? input.email ?? "user@acme.com"
  const answer = input.inResponseTo ? ` InResponseTo="${input.inResponseTo}"` : ""
  const attributes = Object.entries(input.attributes ?? {})
    .map(([name, value]) => `<saml:Attribute Name="${name}"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`)
    .join("")
  let assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${input.id ?? `_a${crypto.randomUUID()}`}" Version="2.0" IssueInstant="${issued.toISOString()}"><saml:Issuer>${input.issuer ?? entity}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameID}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${answer} NotOnOrAfter="${later.toISOString()}" Recipient="${input.recipient ?? acs}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${issued.toISOString()}" NotOnOrAfter="${later.toISOString()}"><saml:AudienceRestriction><saml:Audience>${input.audience ?? audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${issued.toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>${attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : ""}</saml:Assertion>`
  const mode = input.sign ?? "assertion"
  const signer = input.signer ?? idp
  if (mode === "assertion") assertion = sign(assertion, "Assertion", signer)
  let response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomUUID()}" Version="2.0" IssueInstant="${issued.toISOString()}" Destination="${input.recipient ?? acs}"${answer}><saml:Issuer>${input.issuer ?? entity}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`
  if (mode === "response") response = sign(response, "Response", signer)
  return Buffer.from(response).toString("base64")
}

const post = (env: Env, body: Record<string, string>, slug = "acme") =>
  env.server.request(`/sso/saml/${slug}/acs`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  })

const configure = (env: Env, body: Record<string, unknown> = {}, slug = "acme", token = env.owner.token) =>
  env.call("PUT", `/api/v1/orgs/${slug}/sso/saml`, { token, body: { metadata: metadata(), ...body } })

async function configured(body: Record<string, unknown> = {}) {
  const env = await setup()
  expect((await configure(env, body)).status).toBe(200)
  return env
}

// Starts a sign-in at the server, then answers it as the identity provider.
async function signin(env: Env, input: Assert & { query?: string } = {}) {
  const start = await env.server.request(`/sso/acme/start${input.query ?? ""}`)
  expect(start.status).toBe(302)
  const sent = request(start.headers.get("location")!)
  const response = await post(env, {
    SAMLResponse: respond({ inResponseTo: sent.id, ...input }),
    ...(sent.relay ? { RelayState: sent.relay } : {}),
  })
  return { response, sent }
}

describe("saml configuration", () => {
  test("imports the identity provider's metadata and shows what to register there", async () => {
    const env = await configured()
    const view = await env.call("GET", "/api/v1/orgs/acme/sso", { token: env.owner.token })
    expect(view.data).toMatchObject({
      configured: true,
      protocol: "saml",
      issuer: null,
      client_id: null,
      saml: { entity_id: entity, sso_url: entry, idp_initiated: false },
      service_provider: {
        entity_id: audience,
        acs_url: acs,
        metadata_url: "http://localhost:8787/sso/saml/acme/metadata",
      },
    })
    // Only the signing certificate, not the encryption one.
    expect(view.data.saml.certificates).toHaveLength(1)
    expect(view.data.saml.certificates[0]).toMatchObject({ subject: "CN=Kilo enterprise test idp" })
    expect(view.data.saml.certificates[0].fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(view.data.saml.certificates[0].expires).toBeGreaterThan(Date.now())

    const sp = await env.server.request("/sso/saml/acme/metadata")
    expect(sp.headers.get("content-type")).toContain("xml")
    const xml = await sp.text()
    expect(xml).toContain(`entityID="${audience}"`)
    expect(xml).toContain(`Location="${acs}"`)
    const audit = await env.store.audit.query({ org: env.owner.org.id, actions: ["sso.update"], limit: 5 })
    expect(audit[0]!.details).toMatchObject({ protocol: "saml", entity_id: entity, sso_url: entry })
  })

  test("takes typed-in settings instead of metadata, and rejects what can't work", async () => {
    const env = await setup()
    const typed = await env.call("PUT", "/api/v1/orgs/acme/sso/saml", {
      token: env.owner.token,
      body: { entity_id: entity, sso_url: entry, certificate: `${idp.cert}\n${rogue.cert}` },
    })
    expect(typed.status).toBe(200)
    const view = await env.call("GET", "/api/v1/orgs/acme/sso", { token: env.owner.token })
    expect(view.data.saml.certificates).toHaveLength(2)
    // A toggle changes without giving the certificate again.
    expect(
      (await env.call("PUT", "/api/v1/orgs/acme/sso/saml", { token: env.owner.token, body: { enforce: true } })).status,
    ).toBe(200)
    expect((await env.store.sso.get(env.owner.org.id))!).toMatchObject({ enforce: true, issuer: entity, entry })
    await env.call("DELETE", "/api/v1/orgs/acme/sso", { token: env.owner.token })
    const bad = async (body: Record<string, unknown>) =>
      (await env.call("PUT", "/api/v1/orgs/acme/sso/saml", { token: env.owner.token, body })).data.message
    expect(await bad({ entity_id: entity, sso_url: entry })).toContain("metadata")
    expect(await bad({ entity_id: entity, sso_url: entry, certificate: "not a certificate" })).toContain("certificate")
    expect(await bad({ metadata: "<not xml" })).toContain("metadata")
    expect(await bad({ metadata: metadata().replace(/<md:KeyDescriptor use="signing">.*?<\/md:KeyDescriptor>/s, "") })).toContain(
      "signing certificate",
    )
    expect(
      await bad({ metadata: metadata().replace(/<md:SingleSignOnService Binding="[^"]+HTTP-Redirect"[^>]*\/>/, "") }),
    ).toContain("HTTP-Redirect")
  })

  test("saving SAML replaces an OpenID Connect connection; removing it removes either", async () => {
    const env = await setup()
    await env.store.sso.set(env.owner.org.id, {
      protocol: "oidc",
      issuer: "https://login.example.com",
      client: "c",
      secret: "s",
      scopes: "openid email",
      enforce: false,
      provision: true,
    })
    expect((await configure(env, { enforce: true })).status).toBe(200)
    const row = (await env.store.sso.get(env.owner.org.id))!
    expect(row).toMatchObject({ protocol: "saml", issuer: entity, enforce: true })
    expect("secret" in row).toBe(false)
    expect((await env.call("DELETE", "/api/v1/orgs/acme/sso", { token: env.owner.token })).status).toBe(204)
    expect(await env.store.sso.get(env.owner.org.id)).toBeUndefined()
  })

  test("only owners and admins with sso.write configure it", async () => {
    const env = await setup()
    const member = await env.join("member@acme.com", "member")
    expect((await configure(env, {}, "acme", member.token)).status).toBe(403)
  })
})

describe("saml sign-in", () => {
  test("a member signs in to the console with a signed assertion", async () => {
    const env = await configured()
    const { response, sent } = await signin(env, { email: "owner@acme.com", attributes: { displayName: "The Owner" } })
    // The AuthnRequest names this server and where to send the answer.
    expect(sent.url.origin + sent.url.pathname).toBe(entry)
    expect(sent.xml).toContain(`AssertionConsumerServiceURL="${acs}"`)
    expect(sent.xml).toContain(`<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${audience}</saml:Issuer>`)
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/admin")
    const session = response.headers.get("set-cookie")!.match(/ent_session=([^;]+)/)![1]
    const me = await env.call("GET", "/api/v1/me", { headers: { cookie: `ent_session=${session}` } })
    expect(me.data.user.email).toBe("owner@acme.com")
    const logins = await env.store.audit.query({ org: env.owner.org.id, actions: ["user.login"], limit: 5 })
    expect(logins[0]!.details).toEqual({ method: "sso", protocol: "saml", device: false })
  })

  test("a response signed as a whole is accepted too", async () => {
    const env = await configured()
    expect((await signin(env, { email: "owner@acme.com", sign: "response" })).response.status).toBe(302)
  })

  test("the email comes from the attributes, else the NameID; names from the attributes", async () => {
    const env = await configured()
    const domain = await env.store.domain.create(env.owner.org.id, "acme.com")
    await env.store.domain.verify(domain.name)
    const { response } = await signin(env, {
      nameID: "00u1abcd",
      attributes: {
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": "New.Person@Acme.com",
        givenName: "New",
        sn: "Person",
      },
    })
    expect(response.status).toBe(302)
    const user = (await env.store.user.find("new.person@acme.com"))!
    expect(user).toMatchObject({ name: "New Person" })
    expect(
      await env.store.audit.query({ org: env.owner.org.id, actions: ["sso.auto_provision"], limit: 5 }),
    ).toHaveLength(1)
    // No email anywhere: refused.
    expect((await signin(env, { nameID: "00u1abcd" })).response.status).toBe(403)
  })

  test("strangers are refused and invites are honoured", async () => {
    const env = await configured()
    expect((await signin(env, { email: "stranger@elsewhere.io" })).response.status).toBe(403)
    await env.call("POST", "/api/v1/orgs/acme/invites", {
      token: env.owner.token,
      body: { email: "lead@partner.io", role: "admin" },
    })
    expect((await signin(env, { email: "lead@partner.io" })).response.status).toBe(302)
    const user = (await env.store.user.find("lead@partner.io"))!
    expect((await env.store.member.role(env.owner.org.id, user.id))?.role).toBe("admin")
  })

  test("refuses forged, tampered, misdirected and unsigned responses", async () => {
    const env = await configured()
    const rejected = async (input: Assert, body: (sent: ReturnType<typeof request>) => Record<string, string> = () => ({})) => {
      const start = await env.server.request("/sso/acme/start")
      const sent = request(start.headers.get("location")!)
      const response = await post(env, {
        SAMLResponse: respond({ inResponseTo: sent.id, email: "owner@acme.com", ...input }),
        RelayState: sent.relay!,
        ...body(sent),
      })
      return { status: response.status, text: await response.text() }
    }
    // Signed by a key the org doesn't trust.
    expect((await rejected({ signer: rogue })).status).toBe(403)
    // Not signed at all.
    expect((await rejected({ sign: "none" })).status).toBe(403)
    // Issued by another identity provider, for another service provider, or to another ACS.
    expect((await rejected({ issuer: "https://evil.example.com" })).status).toBe(403)
    expect((await rejected({ audience: "https://other-sp.example.com" })).status).toBe(403)
    // Answers a request this server never made.
    expect((await rejected({ inResponseTo: "_forged" })).status).toBe(403)
    // Too old: issued long before it arrived.
    expect((await rejected({ issued: new Date(Date.now() - 60 * 60 * 1000) })).status).toBe(403)
    // An email swapped into a signed assertion.
    const start = await env.server.request("/sso/acme/start")
    const sent = request(start.headers.get("location")!)
    const signed = Buffer.from(respond({ inResponseTo: sent.id, email: "member@acme.com" }), "base64").toString()
    const tampered = Buffer.from(signed.replaceAll("member@acme.com", "owner@acme.com")).toString("base64")
    const res = await post(env, { SAMLResponse: tampered, RelayState: sent.relay! })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain("not accepted")
  })

  test("a response can't be replayed, and a sign-in state is single use", async () => {
    const env = await configured()
    const start = await env.server.request("/sso/acme/start")
    const sent = request(start.headers.get("location")!)
    const body = { SAMLResponse: respond({ inResponseTo: sent.id, email: "owner@acme.com" }), RelayState: sent.relay! }
    expect((await post(env, body)).status).toBe(302)
    expect((await post(env, body)).status).toBe(400)
  })

  test("sign-ins the identity provider starts are refused unless the org allows them", async () => {
    const env = await configured()
    const unsolicited = () => respond({ email: "owner@acme.com", id: "_tile-assertion" })
    const refused = await post(env, { SAMLResponse: unsolicited() })
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain("started from Kilo")

    expect((await configure(env, { idp_initiated: true })).status).toBe(200)
    const accepted = await post(env, { SAMLResponse: unsolicited() })
    expect(accepted.status).toBe(302)
    // The same assertion again is a replay.
    const replay = await post(env, { SAMLResponse: unsolicited() })
    expect(replay.status).toBe(403)
    expect(await replay.text()).toContain("already used")
    // Even when allowed, a response that claims to answer a request must answer a real one.
    expect((await post(env, { SAMLResponse: respond({ email: "owner@acme.com", inResponseTo: "_forged" }) })).status).toBe(
      403,
    )
  })

  test("one org's identity provider can't sign in to another org", async () => {
    const env = await configured()
    const globex = await env.store.org.create({ name: "Globex", slug: "globex" })
    const boss = await env.join("boss@globex.com", "owner", globex.id)
    expect((await configure(env, {}, "globex", boss.token)).status).toBe(200)
    // A sign-in started for Globex, posted to Acme's ACS.
    const start = await env.server.request("/sso/globex/start")
    const sent = request(start.headers.get("location")!)
    const res = await post(env, { SAMLResponse: respond({ inResponseTo: sent.id, email: "owner@acme.com" }), RelayState: sent.relay! })
    expect(res.status).toBe(400)
    // Acme's own response is addressed to Acme's ACS and audience, so Globex's ACS refuses it.
    const acme = await env.server.request("/sso/acme/start")
    const ours = request(acme.headers.get("location")!)
    const crossed = await post(
      env,
      { SAMLResponse: respond({ inResponseTo: ours.id, email: "owner@acme.com" }), RelayState: ours.relay! },
      "globex",
    )
    expect(crossed.status).toBe(400)
  })
})

describe("saml device login", () => {
  test("approves a CLI or IDE device code through the identity provider", async () => {
    const env = await configured()
    const begin = await env.call("POST", "/api/v1/auth/device", { body: { org: "acme" } })
    expect(begin.status).toBe(200)
    const { response } = await signin(env, { email: "owner@acme.com", query: `?device=${begin.data.user_code}` })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("signed in")
    const done = await env.call("POST", "/api/v1/auth/device/token", { body: { device_code: begin.data.device_code } })
    expect(done.status).toBe(200)
    expect(done.data).toMatchObject({ org: { slug: "acme" }, user: { email: "owner@acme.com" } })
  })
})
