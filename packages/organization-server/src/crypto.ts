import { Effect } from "effect"

const encoder = new TextEncoder()

export function id(prefix: string) {
  return `${prefix}_${Bun.randomUUIDv7().replaceAll("-", "")}`
}

export function secret(bytes = 32) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")
}

export function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

// Bearer tokens carry a recognisable prefix so leaked ones are easy to find with secret scanners.
export function token(kind: "user" | "scim") {
  return `${kind === "user" ? "korg" : "korgs"}_${secret()}`
}

// RFC 8628 user codes: 8 chars from an alphabet without ambiguous characters, shown as XXXX-XXXX.
const alphabet = "BCDFGHJKLMNPQRSTVWXZ"
export function code() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length])
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`
}

// PKCE S256 code challenge (RFC 7636).
export const challenge = (verifier: string) =>
  Effect.promise(async () =>
    Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))).toString("base64url"),
  )

async function key(material: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(material))
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"])
}

// Encrypts secrets at rest (e.g. OIDC client secrets) with AES-256-GCM keyed from ORGANIZATION_SECRET.
export const seal = (material: string, value: string) =>
  Effect.promise(async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(material), encoder.encode(value))
    return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(data).toString("base64url")}`
  })

// A value sealed under another ORGANIZATION_SECRET cannot be opened; that is a deployment defect.
export const unseal = (material: string, value: string) =>
  Effect.promise(async () => {
    const [version, iv, data] = value.split(".")
    if (version !== "v1" || !iv || !data) throw new Error("unsupported sealed value")
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(iv, "base64url") },
      await key(material),
      Buffer.from(data, "base64url"),
    )
    return new TextDecoder().decode(plain)
  })
