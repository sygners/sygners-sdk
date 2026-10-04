// @sygners/sdk/navegador — la parte del SDK que corre en el navegador.
//
// Con esto la clave de acceso nace y se queda en el navegador de quien firma:
//
//   1. Tu servidor llama a `documentos.iniciar` y le pasa al navegador el
//      `documentoId` y el `fileHash` (nunca el `uploadToken` ni la API key).
//   2. El navegador cifra con `cifrarDocumento` y le devuelve a tu servidor
//      `cifrado` y `llave`, que no abren nada sin la clave.
//   3. Tu servidor llama a `documentos.completar`.
//   4. El navegador abre el documento en sygners con `abrirParaFirmar`: la
//      clave queda en `sessionStorage` y viaja a sygners en el fragmento de la
//      URL (`#clave=…`), que el navegador no manda a ningún servidor. sygners
//      la toma con `tomarClaveDelFragmento` y abre el documento sin pedirla.
//
// No usa la API key: no hay nada acá que dé acceso al plan.
import { sha256Hex } from "./cripto/hash";
import { aBytes, cifrarParaSellar, type DocumentoCifrado } from "./sellado";

export type { DocumentoCifrado, LlaveDeAcceso } from "./sellado";

// El parámetro del fragmento con el que la clave llega a sygners.
export const PARAMETRO_CLAVE = "clave";

const claveSesion = (documentoId: string) => `sygners:clave:${documentoId}`;

// Cifra el archivo para el documento que inició tu servidor. Antes comprueba
// que sea el mismo archivo: si no, sygners lo rechazaría al sellar.
export async function cifrarDocumento(p: {
  archivo: Uint8Array | ArrayBuffer | Blob;
  documentoId: string;
  fileHash: string;
}): Promise<DocumentoCifrado> {
  const plaintext = await aBytes(p.archivo);
  if ((await sha256Hex(plaintext)) !== p.fileHash.toLowerCase()) {
    throw new Error("El archivo no es el que se inició: el hash no coincide.");
  }
  return cifrarParaSellar({ plaintext, documentoId: p.documentoId, fileHash: p.fileHash.toLowerCase() });
}

// Guarda la clave en `sessionStorage` (de este origen y esta pestaña).
export function guardarClave(documentoId: string, claveDeAcceso: string): void {
  try {
    sessionStorage.setItem(claveSesion(documentoId), claveDeAcceso);
  } catch {
    // Storage bloqueado: la clave igual viaja en el fragmento.
  }
}

export function leerClave(documentoId: string): string | null {
  try {
    return sessionStorage.getItem(claveSesion(documentoId));
  } catch {
    return null;
  }
}

// La URL del documento con la clave en el fragmento. `urlDocumento` es la
// página del documento en sygners, sin fragmento.
export function urlParaFirmar(urlDocumento: string, claveDeAcceso: string): string {
  const url = new URL(urlDocumento);
  url.hash = `${PARAMETRO_CLAVE}=${encodeURIComponent(claveDeAcceso)}`;
  return url.toString();
}

// Guarda la clave y lleva a sygners en esta pestaña.
export function abrirParaFirmar(p: { urlDocumento: string; documentoId: string; claveDeAcceso: string }): void {
  guardarClave(p.documentoId, p.claveDeAcceso);
  location.assign(urlParaFirmar(p.urlDocumento, p.claveDeAcceso));
}

// Del lado de sygners: toma la clave del fragmento, la pasa a `sessionStorage`
// y la saca de la URL (y del historial). Si no vino en el fragmento, devuelve
// la que haya en `sessionStorage` de una visita anterior en esta pestaña.
export function tomarClaveDelFragmento(documentoId: string): string | null {
  const params = new URLSearchParams(location.hash.slice(1));
  const clave = params.get(PARAMETRO_CLAVE);
  if (!clave) return leerClave(documentoId);
  guardarClave(documentoId, clave);
  params.delete(PARAMETRO_CLAVE);
  const resto = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${location.search}${resto ? `#${resto}` : ""}`);
  return clave;
}
