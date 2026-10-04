// Dónde viven los links para firmar y los borradores previsualizados.
//
// - Con Upstash Redis configurado (UPSTASH_REDIS_REST_URL/TOKEN, o las
//   KV_REST_API_URL/TOKEN que carga la integración de Vercel): en Redis. Es lo
//   que hace falta en Vercel, donde cada pedido puede caer en una instancia
//   distinta y el disco es de sólo lectura.
// - Si no, en local: borradores en memoria y links en links.json.
//
// En producción, tu base de datos.
import { readFileSync, writeFileSync } from "node:fs";
import { Redis } from "@upstash/redis";

const BORRADOR_TTL_SEG = 30 * 60;
// Si el proceso muere a mitad de un envío, el link se libera solo.
const RESERVA_TTL_SEG = 120;

function crearRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  const k = (tipo, id) => `aceptacion-terminos:${tipo}:${id}`;
  return {
    obtenerLink: (id) => redis.get(k("link", id)),
    guardarLink: (id, link) => redis.set(k("link", id), link),
    obtenerLinks: async (ids) => (ids.length ? redis.mget(...ids.map((id) => k("link", id))) : []),
    // Sólo uno gana: SET NX.
    reservarLink: async (id) => (await redis.set(k("reserva", id), 1, { nx: true, ex: RESERVA_TTL_SEG })) === "OK",
    liberarLink: (id) => redis.del(k("reserva", id)),
    guardarBorrador: (id, b) => redis.set(k("borrador", id), { ...b, pdf: Buffer.from(b.pdf).toString("base64") }, { ex: BORRADOR_TTL_SEG }),
    obtenerBorrador: async (id) => {
      const b = await redis.get(k("borrador", id));
      return b && { ...b, pdf: Buffer.from(b.pdf, "base64") };
    },
    borrarBorrador: (id) => redis.del(k("borrador", id)),
  };
}

function crearLocal() {
  const archivo = new URL("./links.json", import.meta.url);
  let links = {};
  try {
    links = JSON.parse(readFileSync(archivo, "utf8"));
  } catch {
    // Todavía no hay links.
  }
  const guardar = () => writeFileSync(archivo, JSON.stringify(links, null, 2));
  const reservas = new Set();
  const borradores = new Map();
  setInterval(() => {
    const ahora = Date.now();
    for (const [id, b] of borradores) if (b.vence < ahora) borradores.delete(id);
  }, 60_000).unref();

  return {
    obtenerLink: async (id) => links[id] ?? null,
    guardarLink: async (id, link) => {
      links[id] = link;
      guardar();
    },
    obtenerLinks: async (ids) => ids.map((id) => links[id] ?? null),
    reservarLink: async (id) => !reservas.has(id) && Boolean(reservas.add(id)),
    liberarLink: async (id) => reservas.delete(id),
    guardarBorrador: async (id, b) => borradores.set(id, { ...b, vence: Date.now() + BORRADOR_TTL_SEG * 1000 }),
    obtenerBorrador: async (id) => {
      const b = borradores.get(id);
      return b && b.vence > Date.now() ? b : null;
    },
    borrarBorrador: async (id) => borradores.delete(id),
  };
}

export const almacen = crearRedis() ?? crearLocal();
