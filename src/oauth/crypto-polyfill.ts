import { webcrypto } from "node:crypto";

let applied = false;

export function ensureWebCrypto(): void {
  if (applied) return;

  if (typeof globalThis.crypto === "undefined") {
    (globalThis as Record<string, unknown>).crypto = webcrypto as unknown as Crypto;
  }

  applied = true;
}
