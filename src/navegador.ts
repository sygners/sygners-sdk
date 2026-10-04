// @sygners/sdk/navegador — la parte del SDK que corre en el navegador.
//
// Con esto la clave de acceso nace y se queda en el navegador de quien firma:
//
//   1. Al tocar "Firmar", el navegador abre la pestaña de sygners con
//      `abrirVentanaDeFirma` (tiene que ser en el mismo click, o el navegador
//      la bloquea).
//   2. Tu servidor llama a `documentos.iniciar` y le pasa al navegador el
//      `documentoId` y el `fileHash` (nunca el `uploadToken` ni la API key).
//   3. El navegador cifra con `cifrarDocumento` y le devuelve a tu servidor
//      `cifrado` y `llave`, que no abren nada sin la clave.
//   4. Tu servidor llama a `documentos.completar` con `firmaEnElNavegador`, y
//      le pasa al navegador la `urlFirma` de ese firmante.
//   5. `ventana.entregar` lleva la pestaña a `urlFirma` y, cuando sygners
//      avisa que está lista, le pasa la clave con `postMessage`: nunca va en
//      una URL ni pasa por un servidor. sygners la guarda en su
//      `sessionStorage` y abre el documento sin pedirla.
//
// No usa la API key: no hay nada acá que dé acceso al plan.
import { sha256Hex } from "./cripto/hash";
import { aBytes, cifrarParaSellar, type DocumentoCifrado } from "./sellado";

export type { DocumentoCifrado, LlaveDeAcceso } from "./sellado";

// El protocolo con `/sign/[token]` de sygners (`useClaveRecibida` allá).
export const MENSAJE_LISTO = "sygners:listo-para-clave";
export const MENSAJE_CLAVE = "sygners:clave";

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

export interface VentanaDeFirma {
  // Lleva la pestaña a `urlFirma` y le entrega la clave cuando sygners la
  // pide. Se resuelve al entregarla.
  entregar(p: { urlFirma: string; claveDeAcceso: string }): Promise<void>;
  // Si algo falla antes de entregar.
  cerrar(): void;
}

export class VentanaBloqueadaError extends Error {
  constructor() {
    super("El navegador bloqueó la pestaña de sygners. Permití las ventanas emergentes de este sitio y probá de nuevo.");
    this.name = "VentanaBloqueadaError";
  }
}

// Abre la pestaña de sygners en blanco. Llamala en el handler del click, antes
// de cualquier `await`: si no, el navegador la toma por un popup y la bloquea.
export function abrirVentanaDeFirma(opts: { texto?: string } = {}): VentanaDeFirma {
  const ventana = window.open("", "_blank");
  if (!ventana) throw new VentanaBloqueadaError();
  try {
    ventana.document.title = "sygners";
    ventana.document.body.textContent = opts.texto ?? "Preparando el documento…";
    ventana.document.body.style.cssText = "font:16px system-ui,sans-serif;color:#475569;padding:32px";
  } catch {
    // Si no se puede escribir en la pestaña en blanco, queda vacía: no importa.
  }

  return {
    entregar({ urlFirma, claveDeAcceso }) {
      const origen = new URL(urlFirma).origin;
      return new Promise<void>((resolver) => {
        function alPedir(e: MessageEvent) {
          if (e.source !== ventana || e.origin !== origen) return;
          if ((e.data as { tipo?: unknown } | null)?.tipo !== MENSAJE_LISTO) return;
          // Dirigida al origen de sygners: si la pestaña ya está en otro lado,
          // el navegador no la entrega.
          ventana!.postMessage({ tipo: MENSAJE_CLAVE, clave: claveDeAcceso }, origen);
          removeEventListener("message", alPedir);
          resolver();
        }
        addEventListener("message", alPedir);
        ventana!.location.href = urlFirma;
      });
    },
    cerrar() {
      ventana.close();
    },
  };
}
