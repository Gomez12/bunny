/** SHA-256 hex digest using Bun's native CryptoHasher (synchronous). */
export function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}
