// @sygners/sdk — cliente de la API de integración de sygners.
//
// Hace del lado de tu sistema lo mismo que hace el navegador en sygners.com:
// calcula el hash del archivo, genera la clave de acceso, cifra el archivo y
// envuelve su clave. sygners recibe SOLO el archivo cifrado y la clave del
// documento envuelta: nunca el archivo en claro ni la clave de acceso.
//
// ⚠️ Los módulos de `./cripto` son COPIA TEXTUAL de los de sygners
// (`src/lib/{envelope,passphrase,hash,signature}.ts`). No se editan acá: una
// diferencia pierde documentos. `test/vectores.test.ts` lo comprueba.
import { sha256Hex } from "./cripto/hash";
import { encryptDocument, generateDek, wrapDek } from "./cripto/envelope";
import { PASSPHRASE_KEK_ALG, deriveKekFromPassphrase, encodeKdfParams, generatePassphrase } from "./cripto/passphrase";

export const AVISO_CLAVE =
  "Entregá la clave de acceso a los firmantes por un canal distinto del email de invitación (WhatsApp, SMS, en persona). Si viajan juntos, el cifrado deja de proteger el documento.";

export type MetodoIdentidad = "partes" | "didit";
export type Idioma = "es-AR" | "es-ES" | "en-US" | "pt-BR";
export type Paso = "iniciar" | "subir" | "sellar" | "estado" | "constancia" | "anular";

export class SygnersError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codigo: string | null,
    readonly paso: Paso,
  ) {
    super(message);
    this.name = "SygnersError";
  }
}

export interface OpcionesCliente {
  // `sgn_live_…` en producción, `sgn_test_…` en stage. Se genera en "Mi plan".
  apiKey: string;
  // Default: https://sygners.com
  baseUrl?: string;
  // Idioma de los mensajes de error de la API (Accept-Language).
  idiomaErrores?: Idioma;
  fetch?: typeof fetch;
  // La key da acceso al cupo del plan: en un navegador queda expuesta. Sólo
  // para pruebas locales.
  permitirNavegador?: boolean;
}

export interface NuevoDocumento {
  archivo: Uint8Array | ArrayBuffer | Blob;
  nombre: string;
  tipo?: string;
  titulo?: string;
  firmantes: string[];
  // Una cuenta del plan. Default: el dueño (obligatorio en planes sin dueño).
  emisor?: string;
  metodoIdentidad?: MetodoIdentidad;
  // Idioma de las invitaciones y de la constancia.
  idioma?: Idioma;
}

export interface DocumentoCreado {
  documentoId: string;
  // ⚠️ La única copia: sygners nunca la ve. Ver `aviso`.
  claveDeAcceso: string;
  fileHash: string;
  venceEl: string | null;
  firmantes: { email: string; estado: string }[];
  aviso: string;
}

export interface EstadoDocumento {
  id: string;
  titulo: string;
  estado: "PENDING" | "PARTIAL" | "COMPLETED" | "REJECTED" | "CANCELLED" | string;
  proteccion: "protegido" | "privado";
  sellado: boolean;
  venceEl: string | null;
  metodoIdentidad: string;
  emisor: string;
  firmantes: { email: string; estado: string; firmadoEl: string | null }[];
  constanciaDisponible: boolean;
}

export type EventoWebhook =
  | "firma.registrada"
  | "documento.completado"
  | "documento.rechazado"
  | "documento.anulado"
  | "documento.vencido";

export interface AvisoWebhook {
  id: string;
  evento: EventoWebhook;
  creado: string;
  documento: { id: string; estado: string };
  firmante?: string;
}

const FORMA_KEY = /^sgn_(live|test)_[A-Za-z0-9_-]{43}$/;

export class Sygners {
  readonly documentos: Documentos;
  readonly webhooks = { verificar: verificarWebhook };

  constructor(opts: OpcionesCliente) {
    if (!FORMA_KEY.test(opts.apiKey ?? "")) throw new Error("La API key no tiene la forma sgn_live_… / sgn_test_…");
    if (typeof window !== "undefined" && !opts.permitirNavegador) {
      throw new Error("@sygners/sdk no se usa desde un navegador: la API key quedaría expuesta. Usalo desde tu servidor.");
    }
    this.documentos = new Documentos({
      apiKey: opts.apiKey,
      baseUrl: (opts.baseUrl ?? "https://sygners.com").replace(/\/+$/, ""),
      idioma: opts.idiomaErrores,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    });
  }
}

interface Config {
  apiKey: string;
  baseUrl: string;
  idioma?: Idioma;
  fetch: typeof fetch;
}

class Documentos {
  constructor(private readonly c: Config) {}

  private async llamar(paso: Paso, metodo: string, ruta: string, cuerpo?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const binario = cuerpo instanceof Uint8Array;
    const r = await this.c.fetch(`${this.c.baseUrl}/api/v1${ruta}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${this.c.apiKey}`,
        ...(this.c.idioma ? { "Accept-Language": this.c.idioma } : {}),
        ...(cuerpo === undefined ? {} : { "Content-Type": binario ? "application/octet-stream" : "application/json" }),
        ...extra,
      },
      body: cuerpo === undefined ? undefined : binario ? (cuerpo as unknown as BodyInit) : JSON.stringify(cuerpo),
    });
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { error?: string; codigo?: string };
      throw new SygnersError(d.error ?? `HTTP ${r.status}`, r.status, d.codigo ?? null, paso);
    }
    return r;
  }

  // Inicia, sube el cifrado y sella: al volver, los firmantes ya tienen su
  // invitación por email. Si un paso falla, el error dice cuál (`paso`); un
  // documento iniciado y no sellado no cobra nada y vence solo.
  async crear(n: NuevoDocumento): Promise<DocumentoCreado> {
    const plaintext = await aBytes(n.archivo);
    const fileHash = await sha256Hex(plaintext);

    const ini = (await (
      await this.llamar("iniciar", "POST", "/documentos", {
        fileName: n.nombre,
        mimeType: n.tipo ?? "application/octet-stream",
        fileSize: plaintext.length,
        fileHash,
        titulo: n.titulo,
        firmantes: n.firmantes,
        emisor: n.emisor,
        metodoIdentidad: n.metodoIdentidad,
        idioma: n.idioma,
      })
    ).json()) as { documentoId: string; uploadToken: string };

    // El documentId entra en la AAD: recién ahora se puede cifrar.
    const dek = generateDek();
    const blob = await encryptDocument({ dek, plaintext, documentId: ini.documentoId, fileHash });
    await this.llamar("subir", "PUT", `/documentos/${ini.documentoId}/cifrado`, blob, { "X-Upload-Token": ini.uploadToken });

    const clave = generatePassphrase();
    const kek = await deriveKekFromPassphrase(clave.phrase, clave.saltB64, clave.params);
    const sellado = (await (
      await this.llamar("sellar", "POST", `/documentos/${ini.documentoId}/sellar`, {
        uploadToken: ini.uploadToken,
        keys: [
          {
            kind: "passphrase",
            alg: PASSPHRASE_KEK_ALG,
            kdfSalt: clave.saltB64,
            kdfParams: encodeKdfParams(clave.params),
            wrappedKey: await wrapDek(kek, dek),
          },
        ],
      })
    ).json()) as { venceEl: string | null; firmantes: { email: string; estado: string }[] };

    return {
      documentoId: ini.documentoId,
      claveDeAcceso: clave.phrase,
      fileHash,
      venceEl: sellado.venceEl,
      firmantes: sellado.firmantes,
      aviso: AVISO_CLAVE,
    };
  }

  async estado(id: string): Promise<EstadoDocumento> {
    return (await (await this.llamar("estado", "GET", `/documentos/${encodeURIComponent(id)}`)).json()) as EstadoDocumento;
  }

  // El PDF de la constancia. Sólo existe con el documento completo (409 si no).
  async constancia(id: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.llamar("constancia", "GET", `/documentos/${encodeURIComponent(id)}/constancia`)).arrayBuffer());
  }

  // Anula un documento todavía no completo. El motivo es obligatorio y queda en
  // el rastro de la operación.
  async anular(id: string, motivo: string): Promise<{ id: string; estado: string }> {
    return (await (await this.llamar("anular", "POST", `/documentos/${encodeURIComponent(id)}/anular`, { motivo })).json()) as {
      id: string;
      estado: string;
    };
  }
}

async function aBytes(a: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (a instanceof Uint8Array) return a;
  if (a instanceof ArrayBuffer) return new Uint8Array(a);
  return new Uint8Array(await a.arrayBuffer());
}

// Verifica un aviso de webhook: `Sygners-Signature: t=<unix>,v1=<hex>`, con
// HMAC-SHA256(secreto, t + "." + cuerpo). Pasale el cuerpo CRUDO, tal como
// llegó (antes de parsear el JSON). Devuelve el aviso, o lanza si la firma no
// corresponde o es más vieja que `toleranciaSeg`.
export async function verificarWebhook(
  cuerpo: string,
  cabecera: string | null | undefined,
  secreto: string,
  opts: { toleranciaSeg?: number; ahoraSeg?: number } = {},
): Promise<AvisoWebhook> {
  const partes = Object.fromEntries((cabecera ?? "").split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(partes.t);
  const v1 = partes.v1 ?? "";
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/.test(v1)) throw new Error("Firma de webhook ausente o mal formada.");
  const ahora = opts.ahoraSeg ?? Math.floor(Date.now() / 1000);
  if (Math.abs(ahora - t) > (opts.toleranciaSeg ?? 300)) throw new Error("Firma de webhook vencida.");
  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(`${t}.${cuerpo}`)));
  const esperado = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  let dif = 0;
  for (let i = 0; i < 64; i++) dif |= esperado.charCodeAt(i) ^ v1.charCodeAt(i);
  if (dif !== 0) throw new Error("La firma del webhook no corresponde al secreto.");
  return JSON.parse(cuerpo) as AvisoWebhook;
}
