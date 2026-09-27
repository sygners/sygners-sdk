// Isomorphic envelope encryption using WebCrypto (available in the browser and
// in Node 19+ via globalThis.crypto).
//
// ⚠️ ISOMÓRFICO Y CRÍTICO PARA COMPATIBILIDAD — ver la invariante en
// `openspec/referencia/tecnico.md`. Cambiar el challenge de clave, el AAD o la derivación
// de KEK es una ROTURA DE COMPATIBILIDAD, no un refactor: no da error de tipos
// y pierde documentos. Un `alg` nuevo conviviendo con el viejo, nunca un cambio
// en el lugar.
//
// Esquema v2 (cifrado en el cliente, WIP-012):
//
//   DEK random (32B) ──AES-256-GCM(AAD = documentId|fileHash)──> ciphertext
//      │
//      ├─ KEK de acceso  = Argon2id(clave de acceso, salt, params)  → passphrase.ts
//      └─ KEK de wallet  = HKDF-SHA256(firma EIP-712 del documento)
//
// El plaintext nunca sale del browser. El servidor ve metadata, hash,
// ciphertext, salt y los DEK envueltos — nunca el archivo, el DEK ni la clave.
//
// Esquema v1 (histórico, documentos creados antes de WIP-012): el servidor
// cifraba, el DEK vivía en claro en `Document.dek` durante la fase pública, y la
// KEK era `SHA-256(personal_sign(keyChallenge(documentId)))`. Se mantiene solo
// para poder seguir abriendo esos documentos: `deriveKekV1` / `keyChallenge`.

import { signatureDomain } from "./signature";

const subtle = globalThis.crypto.subtle;

// WebCrypto's typings want ArrayBuffer-backed views; our Uint8Arrays are fine
// at runtime, so we narrow at the boundary.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// Identificadores de esquema, persistidos en DocumentKey.alg para poder
// diagnosticar y migrar. Nunca se asumen al desenvolver: se leen de la fila.
export const WALLET_KEK_ALG = "eip712-hkdf/v2";
export const WALLET_KEK_ALG_V1 = "sig-kek/v1";

// --- encoding helpers ------------------------------------------------------
export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

// --- keys ------------------------------------------------------------------

// Imports raw 32-byte key material as an AES-GCM key.
export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("raw", bs(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Generates a random 32-byte DEK.
export function generateDek(): Uint8Array {
  return randomBytes(32);
}

// --- KEK de wallet (v2): firma EIP-712 determinista + HKDF ------------------
//
// EIP-712 y no `personal_sign`: el `documentId` viaja en URLs, no es secreto. Con
// typed data el dominio {name, version, chainId} queda DENTRO de la firma, la
// wallet lo muestra estructurado, y que otro sitio consiga la misma firma a
// ciegas es mucho más difícil. Además es coherente con `signature.ts`.
//
// Una firma por documento, a propósito. La alternativa (una firma maestra por
// wallet + HKDF por documento) ahorraría un prompt, pero si esa clave maestra se
// filtra caen TODOS los documentos de esa persona y no hay forma de revocar uno
// solo. El aislamiento vale más que el prompt de menos — decisión explícita de
// WIP-012, no un default accidental.

export const KEY_ACCESS_PURPOSE = "Derivar mi clave de acceso a este documento";

export const KEY_ACCESS_TYPES: Record<string, { name: string; type: string }[]> = {
  DocumentKeyAccess: [
    { name: "documentId", type: "string" },
    { name: "purpose", type: "string" },
  ],
};

// El `primaryType` del challenge, escrito UNA sola vez.
//
// ⚠️ Existe porque hay dos formas de pedir esta firma y solo una infiere el
// primaryType: ethers lo deduce del grafo de tipos, y la API nativa de Privy
// —la que permite firmar sin ventana de confirmación— lo exige explícito. Si el
// string no coincide con lo que ethers habría inferido, el digest cambia, la
// firma cambia, y la KEK derivada deja de coincidir con la de toda fila ya
// guardada: no da error de tipos ni falla en el momento, deja documentos que no
// abren. `_e2e-firma-silenciosa.ts` afirma la igualdad de los dos digests.
export const KEY_ACCESS_PRIMARY_TYPE = "DocumentKeyAccess";

export interface KeyAccessMessage {
  documentId: string;
  purpose: string;
}

export function buildKeyAccessMessage(documentId: string): KeyAccessMessage {
  return { documentId, purpose: KEY_ACCESS_PURPOSE };
}

// Dominio EIP-712 del challenge de clave. Mismo dominio que la firma del
// documento (`signature.ts`), a propósito: un solo dominio por app.
export const keyAccessDomain = signatureDomain;

// KEK = HKDF-SHA256(ikm = bytes(firma), salt = documentId, info = "sygners:kek:v2")
//
// HKDF y no SHA-256 directo porque es lo correcto para expandir material de
// clave: extrae entropía uniformemente y el `info` separa dominios de uso, así
// que la misma firma nunca produce la misma clave para otro propósito.
export async function deriveWalletKek(
  signatureHex: string,
  documentId: string,
): Promise<CryptoKey> {
  const ikm = await subtle.importKey("raw", bs(hexToBytes(signatureHex)), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bs(utf8(documentId)),
      info: bs(utf8("sygners:kek:v2")),
    },
    ikm,
    256,
  );
  return importAesKey(new Uint8Array(bits));
}

// Tipo de la función de firma typed-data que exponen tanto ethers (`signTypedData`)
// como el provider de Privy. Se pasa como parámetro para que este módulo no
// dependa de ninguna wallet en particular.
export type SignTypedData = (
  domain: object,
  types: object,
  message: object,
) => Promise<string>;

// Pide la firma del challenge de clave y devuelve la KEK. Único lugar donde se
// arma el par (dominio, tipos) para la derivación: si la subida, la firma y el
// viewer lo armaran cada uno por su cuenta, alcanzaría con que uno se
// desalineara para perder el documento.
export async function deriveWalletKekBySigning(params: {
  documentId: string;
  chainId: number;
  signTypedData: SignTypedData;
}): Promise<CryptoKey> {
  const signature = await params.signTypedData(
    keyAccessDomain(params.chainId),
    KEY_ACCESS_TYPES,
    buildKeyAccessMessage(params.documentId),
  );
  return deriveWalletKek(signature, params.documentId);
}

// --- KEK de wallet (v1, histórico) -----------------------------------------

// Mensaje que firmaba un firmante en v1 (personal_sign). Solo para abrir
// documentos v1: los nuevos usan `buildKeyAccessMessage`.
export function keyChallenge(documentId: string): string {
  return [
    "sygners:clave-de-acceso:v1",
    `Documento: ${documentId}`,
    "Firmá para derivar tu clave de acceso a este documento privado.",
  ].join("\n");
}

// Derivación v1: SHA-256 de los bytes de la firma. No usar para documentos nuevos.
export async function deriveKekV1(signatureHex: string): Promise<CryptoKey> {
  const digest = await subtle.digest("SHA-256", bs(hexToBytes(signatureHex)));
  return subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// --- AES-GCM ---------------------------------------------------------------
export interface Sealed {
  iv: Uint8Array;
  data: Uint8Array; // ciphertext + auth tag (WebCrypto appends the tag)
}

export async function aesEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Sealed> {
  const iv = randomBytes(12);
  const params: AesGcmParams = { name: "AES-GCM", iv: bs(iv) };
  if (aad) params.additionalData = bs(aad);
  const ct = await subtle.encrypt(params, key, bs(plaintext));
  return { iv, data: new Uint8Array(ct) };
}

export async function aesDecrypt(
  key: CryptoKey,
  sealed: Sealed,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const params: AesGcmParams = { name: "AES-GCM", iv: bs(sealed.iv) };
  if (aad) params.additionalData = bs(aad);
  const pt = await subtle.decrypt(params, key, bs(sealed.data));
  return new Uint8Array(pt);
}

// --- cifrado del documento (v2) --------------------------------------------
//
// Una sola operación AES-GCM sobre el buffer completo. Alcanza porque el tope de
// archivo son 5 MB (`MAX_UPLOAD_BYTES`): entra en memoria del browser sin drama
// y no hace falta cifrado por chunks. Si algún día sube el tope, el cifrado por
// chunks vuelve al alcance — y con él un header versionado, IVs derivados de un
// prefijo y AAD por índice para que no se puedan reordenar ni truncar.
//
// Layout del blob: iv[12] || AES-GCM(ciphertext + tag).

// AAD del documento: ata el ciphertext a ESTE documento y ESTE hash, así que no
// se puede trasplantar entre documentos de la misma instalación.
//
// ⚠️ Cambiar este string vuelve indescifrable todo lo cifrado con el anterior.
export function documentAad(documentId: string, fileHash: string): Uint8Array {
  return utf8(`sygners:doc:v2|${documentId}|${fileHash.toLowerCase()}`);
}

export async function encryptDocument(params: {
  dek: Uint8Array;
  plaintext: Uint8Array;
  documentId: string;
  fileHash: string;
}): Promise<Uint8Array> {
  const key = await importAesKey(params.dek);
  const sealed = await aesEncrypt(
    key,
    params.plaintext,
    documentAad(params.documentId, params.fileHash),
  );
  const out = new Uint8Array(sealed.iv.length + sealed.data.length);
  out.set(sealed.iv, 0);
  out.set(sealed.data, sealed.iv.length);
  return out;
}

export async function decryptDocument(params: {
  dek: Uint8Array;
  blob: Uint8Array;
  documentId: string;
  fileHash: string;
}): Promise<Uint8Array> {
  const key = await importAesKey(params.dek);
  return aesDecrypt(
    key,
    { iv: params.blob.slice(0, 12), data: params.blob.slice(12) },
    documentAad(params.documentId, params.fileHash),
  );
}

// Descifrado de un blob v1 (mismo layout, sin AAD).
export async function decryptDocumentV1(
  dek: Uint8Array,
  blob: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesKey(dek);
  return aesDecrypt(key, { iv: blob.slice(0, 12), data: blob.slice(12) });
}

// --- DEK wrap / unwrap (DEK sealed under a KEK) ----------------------------
export interface WrappedDek {
  iv: string; // base64
  data: string; // base64
}

export async function wrapDek(kek: CryptoKey, dek: Uint8Array): Promise<WrappedDek> {
  const sealed = await aesEncrypt(kek, dek);
  return { iv: toB64(sealed.iv), data: toB64(sealed.data) };
}

export async function unwrapDek(kek: CryptoKey, wrapped: WrappedDek): Promise<Uint8Array> {
  return aesDecrypt(kek, { iv: fromB64(wrapped.iv), data: fromB64(wrapped.data) });
}
