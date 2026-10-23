import { describe, expect, test } from "bun:test"
import { setup } from "./fixture"

async function scim() {
  const env = await setup()
  const created = await env.call("POST", "/api/v1/orgs/acme/scim/tokens", {
    token: env.owner.token,
    body: { name: "okta" },
  })
  const token: string = created.data.token
  const call = (method: string, path: string, body?: unknown) =>
    env.call(method, `/scim/v2${path}`, {
      token,
      body,
      headers: body === undefined ? {} : { "content-type": "application/scim+json" },
    })
  return { ...env, token, scim: call }
}

const alice = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
  userName: "Alice@Acme.com",
  externalId: "okta-123",
  name: { givenName: "Alice", familyName: "Liddell" },
  emails: [{ value: "Alice@Acme.com", primary: true, type: "work" }],
  active: true,
}

describe("scim auth", () => {
  test("user tokens are not SCIM tokens and vice versa", async () => {
    const env = await scim()
    expect((await env.call("GET", "/scim/v2/Users", { token: env.owner.token })).status).toBe(401)
    expect((await env.call("GET", "/api/v1/me", { token: env.token })).status).toBe(401)
    const res = await env.call("GET", "/scim/v2/Users", { token: "ents_bogus" })
    expect(res.status).toBe(401)
    expect(res.headers.get("content-type")).toContain("application/scim+json")
    expect(res.data.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"])
  })

  test("discovery endpoints describe capabilities", async () => {
    const env = await scim()
    const config = await env.scim("GET", "/ServiceProviderConfig")
    expect(config.data.patch.supported).toBe(true)
    expect(config.data.bulk.supported).toBe(false)
  })
})

describe("scim users", () => {
  test("provisions, finds by filter, and rejects duplicates with uniqueness", async () => {
    const env = await scim()
    const created = await env.scim("POST", "/Users", alice)
    expect(created.status).toBe(201)
    expect(created.data).toMatchObject({
      userName: "alice@acme.com",
      externalId: "okta-123",
      displayName: "Alice Liddell",
      active: true,
    })
    const found = await env.scim("GET", `/Users?filter=${encodeURIComponent('userName eq "ALICE@acme.com"')}`)
    expect(found.data.totalResults).toBe(1)
    expect(found.data.Resources[0].id).toBe(created.data.id)
    const missing = await env.scim("GET", `/Users?filter=${encodeURIComponent('userName eq "bob@acme.com"')}`)
    expect(missing.data.totalResults).toBe(0)
    const dup = await env.scim("POST", "/Users", alice)
    expect(dup.status).toBe(409)
    expect(dup.data.scimType).toBe("uniqueness")
    expect((await env.store.member.role(env.owner.org.id, created.data.id))?.role).toBe("member")
  })

  test("Entra-style string booleans suspend and restore access in this org", async () => {
    const env = await scim()
    const created = await env.scim("POST", "/Users", alice)
    const token = (
      await env.store.token.issue({
        kind: "user",
        user: created.data.id,
        org: env.owner.org.id,
        name: "cli",
      })
    ).value
    expect((await env.call("GET", "/api/v1/orgs/acme", { token })).status).toBe(200)
    const off = await env.scim("PATCH", `/Users/${created.data.id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    })
    expect(off.status).toBe(200)
    expect(off.data.active).toBe(false)
    expect((await env.call("GET", "/api/v1/orgs/acme", { token })).status).toBe(404)
    // A deactivated user is still visible to the IdP so it can reactivate them later.
    expect((await env.scim("GET", `/Users/${created.data.id}`)).data.active).toBe(false)
    const on = await env.scim("PATCH", `/Users/${created.data.id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", value: { active: true } }],
    })
    expect(on.data.active).toBe(true)
    expect((await env.call("GET", "/api/v1/orgs/acme", { token })).status).toBe(200)
    const actions = (await env.store.audit.query({ org: env.owner.org.id, limit: 20 }))
      .map((event) => event.action)
      .filter((action) => action.startsWith("scim.user"))
    expect(actions).toEqual([
      "scim.user_update",
      "scim.user_activate",
      "scim.user_update",
      "scim.user_deactivate",
      "scim.user_create",
    ])
  })

  test("PATCH and PUT update identity attributes", async () => {
    const env = await scim()
    const created = await env.scim("POST", "/Users", alice)
    const patched = await env.scim("PATCH", `/Users/${created.data.id}`, {
      Operations: [
        { op: "replace", path: 'emails[type eq "work"].value', value: "alice.l@acme.com" },
        { op: "replace", path: "name.givenName", value: "Alicia" },
        { op: "replace", path: "name.familyName", value: "L" },
      ],
    })
    expect(patched.data).toMatchObject({ userName: "alice.l@acme.com", displayName: "Alicia L" })
    const put = await env.scim("PUT", `/Users/${created.data.id}`, {
      ...alice,
      userName: "alice@acme.com",
      displayName: "Alice",
    })
    expect(put.data).toMatchObject({ userName: "alice@acme.com", displayName: "Alice" })
  })

  test("never rewrites the identity of someone another org depends on", async () => {
    const env = await scim()
    const other = await env.store.org.create({ name: "Globex", slug: "globex" })
    const shared = await env.store.user.ensure({ email: "shared@acme.com", name: "Shared" })
    await env.store.member.add(other.id, shared.id, "owner")
    const created = await env.scim("POST", "/Users", { userName: "shared@acme.com", displayName: "Renamed by Acme" })
    expect(created.status).toBe(201)
    await env.scim("PATCH", `/Users/${created.data.id}`, {
      Operations: [{ op: "replace", path: "userName", value: "hijack@evil.com" }],
    })
    expect(await env.store.user.get(shared.id)).toMatchObject({ email: "shared@acme.com", name: "Shared" })
  })

  test("DELETE removes the membership and deactivates people left with none", async () => {
    const env = await scim()
    const created = await env.scim("POST", "/Users", alice)
    const token = (
      await env.store.token.issue({
        kind: "user",
        user: created.data.id,
        org: env.owner.org.id,
        name: "cli",
      })
    ).value
    expect((await env.scim("DELETE", `/Users/${created.data.id}`)).status).toBe(204)
    expect((await env.scim("GET", `/Users/${created.data.id}`)).status).toBe(404)
    expect((await env.store.user.get(created.data.id))?.active).toBe(false)
    expect(await env.store.token.verify(token)).toBeUndefined()
  })

  test("only sees users provisioned into its own org", async () => {
    const env = await scim()
    const other = await env.store.org.create({ name: "Globex", slug: "globex" })
    const outsider = await env.store.user.ensure({ email: "outsider@globex.com" })
    await env.store.member.add(other.id, outsider.id, "member")
    expect((await env.scim("GET", `/Users/${outsider.id}`)).status).toBe(404)
    expect((await env.scim("DELETE", `/Users/${outsider.id}`)).status).toBe(404)
  })
})

describe("scim groups", () => {
  test("create with members, then add, remove and rename via PATCH", async () => {
    const env = await scim()
    const a = (await env.scim("POST", "/Users", alice)).data.id
    const b = (await env.scim("POST", "/Users", { userName: "bob@acme.com" })).data.id
    const group = await env.scim("POST", "/Groups", {
      displayName: "Engineering",
      externalId: "g-1",
      members: [{ value: a }],
    })
    expect(group.status).toBe(201)
    expect(group.data.members.map((member: { value: string }) => member.value)).toEqual([a])
    const added = await env.scim("PATCH", `/Groups/${group.data.id}`, {
      Operations: [{ op: "add", path: "members", value: [{ value: b }] }],
    })
    expect(added.data.members).toHaveLength(2)
    const removed = await env.scim("PATCH", `/Groups/${group.data.id}`, {
      Operations: [
        { op: "remove", path: `members[value eq "${a}"]` },
        { op: "replace", path: "displayName", value: "Platform" },
      ],
    })
    expect(removed.data.displayName).toBe("Platform")
    expect(removed.data.members.map((member: { value: string }) => member.value)).toEqual([b])
    const found = await env.scim(
      "GET",
      `/Groups?filter=${encodeURIComponent('displayName eq "Platform"')}&excludedAttributes=members`,
    )
    expect(found.data.Resources).toHaveLength(1)
    expect(found.data.Resources[0].members).toBeUndefined()
    // SCIM groups are the same groups that carry model access policies.
    const policy = await env.call("PATCH", `/api/v1/orgs/acme/groups/${group.data.id}`, {
      token: env.owner.token,
      body: { models: { mode: "selected", items: ["anthropic"] } },
    })
    expect(policy.status).toBe(200)
  })

  test("rejects members that were never provisioned", async () => {
    const env = await scim()
    const res = await env.scim("POST", "/Groups", { displayName: "X", members: [{ value: "usr_ghost" }] })
    expect(res.status).toBe(400)
    expect(res.data.scimType).toBe("invalidValue")
  })

  test("unsupported filters return invalidFilter", async () => {
    const env = await scim()
    const res = await env.scim("GET", `/Users?filter=${encodeURIComponent('name.familyName co "x"')}`)
    expect(res.status).toBe(400)
    expect(res.data.scimType).toBe("invalidFilter")
  })
})

describe("scim errors", () => {
  test("malformed and invalid bodies answer in SCIM's error format", async () => {
    const env = await scim()
    const raw = await env.server.request("/scim/v2/Users", {
      method: "POST",
      headers: { authorization: `Bearer ${env.token}`, "content-type": "application/scim+json" },
      body: "{",
    })
    expect(raw.status).toBe(400)
    expect(raw.headers.get("content-type")).toContain("application/scim+json")
    expect((await raw.json()).scimType).toBe("invalidSyntax")
    const invalid = await env.scim("POST", "/Users", { userName: "" })
    expect(invalid.status).toBe(400)
    expect(invalid.data).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "400",
      scimType: "invalidValue",
    })
    expect(invalid.data._tag).toBeUndefined()
  })
})
