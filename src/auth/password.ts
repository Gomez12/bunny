/**
 * Thin wrapper around Bun.password (argon2id).
 */

export function hashPassword(plaintext: string): Promise<string> {
  return Bun.password.hash(plaintext, { algorithm: "argon2id" });
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plaintext, hash);
}
