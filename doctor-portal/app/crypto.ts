// Signing scheme shared with the patient app: ECDSA P-256 + SHA-256.
// Keys are exchanged as base64 text so they can be copy-pasted.
const SIGNING_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const HASH_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

export function bufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  new Uint8Array(buffer).forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function concatArrayBuffers(...buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  buffers.forEach((buffer) => {
    combined.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  });
  return combined.buffer;
}

export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(SIGNING_ALGORITHM, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

export async function exportPublicKeyBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bufferToBase64(raw);
}

export async function exportPrivateKeyBase64(key: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key);
  return bufferToBase64(pkcs8);
}

export async function importPublicKeyBase64(base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBuffer(base64), SIGNING_ALGORITHM, true, ["verify"]);
}

// hash.txt actually holds the ECDSA signature over the signed bytes, not a
// raw digest — WebCrypto hashes internally as part of sign/verify, which is
// the correct way to do this rather than hand-rolling a hash-then-encrypt
// step ourselves. signedBytes must be built the same way the patient app
// built it: AnalyticalReport.pdf bytes followed by Raw data.csv bytes.
export async function verifyReportSignature(
  publicKey: CryptoKey,
  signatureBase64: string,
  signedBytes: ArrayBuffer,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(HASH_ALGORITHM, publicKey, base64ToBuffer(signatureBase64), signedBytes);
  } catch {
    return false;
  }
}
