// Clave de acceso: 12 caracteres alfanuméricos + derivación de KEK con Argon2id.
//
// ⚠️ ISOMÓRFICO Y CRÍTICO PARA COMPATIBILIDAD. Igual que `envelope.ts` y
// `signature.ts`, este archivo construye bytes que la otra mitad del sistema
// tiene que reproducir exactamente. Si la normalización de un esquema o los
// parámetros de Argon2id cambian, las claves ya emitidas dejan de derivar la
// misma KEK: no hay error de tipos, no hay excepción útil, se pierden
// documentos. Cualquier cambio acá es una ROTURA DE COMPATIBILIDAD, no un
// refactor — va como `alg` nuevo en `DocumentKey`, conviviendo con el viejo.
//
// Por eso los parámetros del KDF se PERSISTEN en cada fila `DocumentKey` y se
// leen de ahí al desenvolver, y por eso la normalización se elige **según el
// `alg` de la fila** y no según el esquema de hoy. Nunca se asumen.
//
// No hay wordlist. Se descartó diceware a propósito: una lista de palabras hay
// que elegirla, fijarla para siempre y decidirle un idioma. La clave se genera
// con tres líneas de código, no hay archivo de datos que pueda cambiar en un
// patch y romper claves existentes, y le sirve igual a un firmante que no hable
// español.

import { argon2id } from "hash-wasm";
import { fromB64, importAesKey, randomBytes, toB64 } from "./envelope";

// Identificador del esquema vigente, persistido en DocumentKey.alg. Lleva las DOS
// versiones que importan: la del KDF (`argon2id/v2`) y la del generador de claves
// (`alnum12/v1`), para poder diagnosticar una fila vieja sin adivinar.
//
// ⚠️ El `alg` de la fila NO es decorativo: de ahí sale qué normalización aplicar
// antes del KDF (ver `normalizeForAlg`). Es lo que permite cambiar de generador
// sin perder lo ya emitido.
export const PASSPHRASE_KEK_ALG = "argon2id/v2+alnum12/v1";

// Esquemas anteriores, solo para poder leer filas ya emitidas: `+cvc6/v1` fue la
// etapa de sílabas CVC y `argon2id/v2` pelado la de palabras diceware. Los dos
// usan la normalización legacy, que colapsa los separadores a un espacio en vez
// de borrarlos.
export const PASSPHRASE_KEK_ALG_CVC6 = "argon2id/v2+cvc6/v1";
export const PASSPHRASE_KEK_ALG_WORDS = "argon2id/v2";

// --- alfabeto (CONGELADO) --------------------------------------------------
//
// 32 símbolos, base32 estilo Crockford: los diez dígitos más las 26 letras menos
// `i l o u`. En cada par que se confunde al leer de un papel o de una pantalla se
// saca la LETRA y se deja el DÍGITO — si la `o` no existe, lo redondo solo puede
// ser un cero; si no existen `i` ni `l`, lo vertical solo puede ser un uno. La
// `u` se va por la razón de siempre en base32: sin ella no salen obscenidades
// por accidente.
//
// 32 es exactamente 5 bits, así que 12 caracteres son **60,0 bits justos** y el
// muestreo uniforme sale sin rechazar nada (32 divide 65536).
//
// ⚠️ Alfabeto y largo CONGELADOS, versionados en `PASSPHRASE_KEK_ALG`. Cambiarlos
// no es cosmético: es cambiar la clave que la gente anota en un papel y dicta por
// teléfono. Un cambio va como generador nuevo (`alnum16/v1`…) con su propio
// `alg`, nunca editando estas constantes.
//
// (Precisión, porque conviene tenerla escrita: lo que vuelve indescifrable un
// documento ya emitido es tocar la normalización de SU esquema o los params del
// KDF, no esta lista — la derivación solo ve la clave normalizada que la persona
// escribe. El alfabeto está congelado por otra razón: es el contrato de lo que se
// puede transcribir sin ambigüedad.)
//
// Lo que este formato NO arregla: dictar 12 caracteres al azar por teléfono es
// peor que dictar sílabas pronunciables, y quedan pares que suenan parecido en
// rioplatense (`b`/`v`, `s`/`c`). Para eso están el botón de WhatsApp y el QR, que
// son los canales que la UI empuja primero.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // 32 símbolos

// Largo de la clave, en caracteres. 12 × 5 bits = 60 bits.
export const PASSPHRASE_LENGTH = 12;

// Ejemplo para los placeholders de la UI. No es una clave emitida por nadie.
export const PASSPHRASE_EXAMPLE = "K7QM2XB9FTZ4";

// Largo del salt en bytes (random por documento, se guarda en claro).
export const KDF_SALT_BYTES = 16;

export interface KdfParams {
  // Memoria en KiB.
  m: number;
  // Iteraciones (time cost).
  t: number;
  // Paralelismo (lanes).
  p: number;
}

// Calibrado para móvil de gama baja, no para esta máquina.
//
// Medición real con hash-wasm (Apple Silicon, WASM nativo, 2026-08-19):
//   m=64MiB t=3 → 179 ms   |   m=32MiB t=2 → 56 ms
//   m=32MiB t=1 →  30 ms   |   m=16MiB t=2 → 24 ms
//
// Un móvil de gama baja corre este tipo de carga (memory-hard, WASM) del orden
// de 10-15× más lento, así que 32MiB/t=2 cae en ~0,6-0,9 s: abajo del techo de
// ~1,5 s que nos fijamos. Si hay que bajar, se baja `t` antes que `m`: la
// resistencia a crackeo con GPU/ASIC viene sobre todo de la memoria.
export const ARGON2ID_PARAMS: KdfParams = { m: 32 * 1024, t: 2, p: 1 };

// --- normalización ---------------------------------------------------------

// Forma canónica del esquema vigente (`alnum12/v1`): se saca TODO lo que no sea
// alfanumérico y se pasa a minúscula.
//
// Se borran los separadores en vez de colapsarlos porque la clave se muestra de
// corrido: quien la transcriba agrupada (`K7QM 2XB9 FTZ4`), con guiones o con un
// espacio de más tiene que abrir el mismo documento. Las mayúsculas tampoco
// cuentan — se muestra en mayúscula solo porque se lee mejor.
//
// ⚠️ Cambiar esta función invalida todas las claves `alnum12/v1` existentes.
export function normalizeAccessKey(input: string): string {
  return input
    .normalize("NFD")
    // Quita los diacríticos combinantes (bloque U+0300–U+036F).
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// Forma canónica de los esquemas viejos (diceware y sílabas CVC): los
// separadores colapsan a UN espacio, que era parte de la forma canónica porque
// la clave se mostraba con guiones o con espacios entre palabras.
//
// ⚠️ No tocar: es lo único que abre los documentos emitidos con esos esquemas.
export function normalizePassphraseLegacy(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Elige la normalización según el `alg` de la fila `DocumentKey`, nunca según el
// esquema de hoy. Un `alg` desconocido cae en la legacy a propósito: los dos
// esquemas anteriores son los únicos que existieron antes de que el `alg`
// empezara a nombrar el generador, así que "no lo reconozco" significa "es
// viejo".
export function normalizeForAlg(input: string, alg: string | null | undefined): string {
  return alg === PASSPHRASE_KEK_ALG ? normalizeAccessKey(input) : normalizePassphraseLegacy(input);
}

// --- generación ------------------------------------------------------------

// Índice uniforme en [0, range) por rechazo. Con 32 símbolos no rechaza nunca
// (32 divide 65536), pero se deja genérico: un `% range` sobre bytes crudos
// sesgaría los primeros símbolos del alfabeto si el largo dejara de ser potencia
// de dos.
function uniformIndex(range: number): number {
  const limit = Math.floor(0x10000 / range) * range;
  const buf = new Uint16Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % range;
  }
}

export interface GeneratedPassphrase {
  // La clave como se le muestra al usuario: 12 caracteres de corrido, en
  // mayúscula. Al derivar da igual el caso — lo normaliza `normalizeAccessKey`.
  phrase: string;
  // Salt del KDF, base64. Se guarda en claro junto al DEK envuelto.
  saltB64: string;
  params: KdfParams;
}

// Genera una clave de acceso. La elige SIEMPRE la app: la entropía real de algo
// pensado por una persona es mucho menor que la aparente.
export function generatePassphrase(length = PASSPHRASE_LENGTH): GeneratedPassphrase {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[uniformIndex(ALPHABET.length)];
  return {
    phrase: out.toUpperCase(),
    saltB64: toB64(randomBytes(KDF_SALT_BYTES)),
    params: ARGON2ID_PARAMS,
  };
}

// Bits de entropía exactos, para la UI y para poder discutir el número sin
// recalcularlo a mano: 12 × log2(32) = 12 × 5 = 60 bits.
export function passphraseBits(length = PASSPHRASE_LENGTH): number {
  return Math.round(length * Math.log2(ALPHABET.length) * 10) / 10;
}

// --- derivación ------------------------------------------------------------

// KEK de 256 bits derivada de la clave con Argon2id.
//
// Los `params` y el `alg` vienen de la fila `DocumentKey`, nunca de las
// constantes de arriba: un documento viejo tiene que seguir abriéndose con los
// parámetros y la normalización con los que fue creado, aunque el default de hoy
// sea otro.
export async function deriveKekFromPassphrase(
  phrase: string,
  saltB64: string,
  params: KdfParams,
  alg: string | null | undefined = PASSPHRASE_KEK_ALG,
): Promise<CryptoKey> {
  const raw = await argon2id({
    password: normalizeForAlg(phrase, alg),
    salt: fromB64(saltB64),
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: "binary",
  });
  return importAesKey(raw);
}

// Serialización de los parámetros para guardarlos en DocumentKey.kdfParams.
export function encodeKdfParams(params: KdfParams): string {
  return JSON.stringify({ m: params.m, t: params.t, p: params.p });
}

// Lectura defensiva: una fila sin params (o corrupta) no se adivina, se rechaza.
export function decodeKdfParams(raw: string | null): KdfParams | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<KdfParams>;
    if (
      typeof o.m !== "number" ||
      typeof o.t !== "number" ||
      typeof o.p !== "number" ||
      o.m <= 0 ||
      o.t <= 0 ||
      o.p <= 0
    ) {
      return null;
    }
    return { m: o.m, t: o.t, p: o.p };
  } catch {
    return null;
  }
}
