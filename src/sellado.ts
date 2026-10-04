// Lo que necesita un documento iniciado para sellarse: el archivo cifrado y su
// clave envuelta con una clave de acceso nueva. Lo usan `crear` (servidor) y
// `cifrarDocumento` (navegador): es el mismo cifrado, cambia dónde corre.
import { encryptDocument, generateDek, wrapDek, type WrappedDek } from "./cripto/envelope";
import { PASSPHRASE_KEK_ALG, deriveKekFromPassphrase, encodeKdfParams, generatePassphrase } from "./cripto/passphrase";

export interface LlaveDeAcceso {
  kind: "passphrase";
  alg: string;
  kdfSalt: string;
  kdfParams: string;
  wrappedKey: WrappedDek;
}

export interface DocumentoCifrado {
  cifrado: Uint8Array;
  // Va a sygners: no sirve sin la clave de acceso.
  llave: LlaveDeAcceso;
  // ⚠️ La única copia: sygners nunca la ve.
  claveDeAcceso: string;
}

export async function cifrarParaSellar(p: { plaintext: Uint8Array; documentoId: string; fileHash: string }): Promise<DocumentoCifrado> {
  // El documentId entra en la AAD: sólo se puede cifrar después de iniciar.
  const dek = generateDek();
  const cifrado = await encryptDocument({ dek, plaintext: p.plaintext, documentId: p.documentoId, fileHash: p.fileHash });
  const clave = generatePassphrase();
  const kek = await deriveKekFromPassphrase(clave.phrase, clave.saltB64, clave.params);
  return {
    cifrado,
    llave: {
      kind: "passphrase",
      alg: PASSPHRASE_KEK_ALG,
      kdfSalt: clave.saltB64,
      kdfParams: encodeKdfParams(clave.params),
      wrappedKey: await wrapDek(kek, dek),
    },
    claveDeAcceso: clave.phrase,
  };
}

export async function aBytes(a: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (a instanceof Uint8Array) return a;
  if (a instanceof ArrayBuffer) return new Uint8Array(a);
  return new Uint8Array(await a.arrayBuffer());
}
