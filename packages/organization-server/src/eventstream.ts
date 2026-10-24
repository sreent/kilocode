export * as EventStream from "./eventstream"

// Amazon's binary event stream encoding, which Bedrock streams responses in. Each message is
//   [total length u32][headers length u32][prelude CRC32 u32][headers][payload][message CRC32 u32]
// with big-endian integers, and each header is
//   [name length u8][name][value type u8][value]
// https://docs.aws.amazon.com/AmazonS3/latest/API/RESTSelectObjectAppendix.html

export type Message = { readonly headers: Readonly<Record<string, string>>; readonly payload: Uint8Array }

// Bedrock's chunks are a few kilobytes; a length beyond this means the stream is corrupt.
const longest = 16 * 1024 * 1024

const crc32 = (bytes: Uint8Array) => Bun.hash.crc32(bytes) >>> 0
const text = new TextDecoder()

// Values of types other than string are skipped: Bedrock only sends strings.
const widths: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }

function headers(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const result: Record<string, string> = {}
  let at = 0
  while (at < bytes.length) {
    const size = view.getUint8(at)
    const name = text.decode(bytes.subarray(at + 1, at + 1 + size))
    at += 1 + size
    const type = view.getUint8(at)
    at += 1
    if (type === 6 || type === 7) {
      const length = view.getUint16(at)
      if (type === 7) result[name] = text.decode(bytes.subarray(at + 2, at + 2 + length))
      at += 2 + length
      continue
    }
    const width = widths[type]
    if (width === undefined) throw new Error(`unknown event stream header type ${type}`)
    at += width
  }
  return result
}

// Takes a byte stream in arbitrary chunks and returns the messages each chunk completes.
export function decoder() {
  let buffer: Uint8Array = new Uint8Array(0)
  return (chunk: Uint8Array): Message[] => {
    if (buffer.length === 0) buffer = chunk
    else {
      const joined = new Uint8Array(buffer.length + chunk.length)
      joined.set(buffer)
      joined.set(chunk, buffer.length)
      buffer = joined
    }
    const messages: Message[] = []
    while (buffer.length >= 12) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      const total = view.getUint32(0)
      const size = view.getUint32(4)
      if (total < 16 || total > longest || size > total - 16) throw new Error("malformed event stream message")
      if (crc32(buffer.subarray(0, 8)) !== view.getUint32(8)) throw new Error("event stream prelude checksum mismatch")
      if (buffer.length < total) break
      if (crc32(buffer.subarray(0, total - 4)) !== view.getUint32(total - 4))
        throw new Error("event stream message checksum mismatch")
      messages.push({ headers: headers(buffer.subarray(12, 12 + size)), payload: buffer.slice(12 + size, total - 4) })
      buffer = buffer.subarray(total)
    }
    return messages
  }
}
