// Signing scheme shared with the doctor portal: ECDSA P-256 + SHA-256.
// Keys are exchanged as base64 text so they can be copy-pasted.
const SIGNING_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const HASH_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  new Uint8Array(buffer).forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
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

export async function importSigningPrivateKeyBase64(base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", base64ToBuffer(base64), SIGNING_ALGORITHM, false, ["sign"]);
}

// The returned string is what goes in hash.txt: an ECDSA signature over the
// report bytes. WebCrypto hashes with SHA-256 internally as part of signing,
// so this is the "hash the report and encrypt the hash" step from a single
// correctly-padded primitive rather than a hand-rolled hash-then-encrypt.
export async function signReportBytes(privateKey: CryptoKey, reportBytes: ArrayBuffer): Promise<string> {
  const signature = await crypto.subtle.sign(HASH_ALGORITHM, privateKey, reportBytes);
  return bufferToBase64(signature);
}

// A cheap sanity check that a pasted string is plausibly a base64-encoded
// PKCS8 EC private key before we store it — full validation happens the
// first time it's actually used to sign.
export async function isValidPrivateKeyBase64(base64: string): Promise<boolean> {
  try {
    await importSigningPrivateKeyBase64(base64);
    return true;
  } catch {
    return false;
  }
}

export async function isValidPublicKeyBase64(base64: string): Promise<boolean> {
  try {
    await crypto.subtle.importKey("raw", base64ToBuffer(base64), SIGNING_ALGORITHM, false, ["verify"]);
    return true;
  } catch {
    return false;
  }
}
