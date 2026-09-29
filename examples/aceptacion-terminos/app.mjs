// Ejemplo: aceptación de términos con firma de conformidad.
//
//   0. Quien emite crea un link por persona. Cada link firma un solo documento.
//   1. Desde el link, el navegador manda nombre, DNI y email.
//   2. El servidor arma el PDF y lo devuelve para previsualizarlo. Lo guarda
//      como borrador: lo que se envía a firmar es exactamente lo que se vio.
//   3. Al confirmar, el servidor lo manda a firmar con @sygners/sdk y devuelve
//      la clave de acceso para que el usuario la comparta por otro canal.
//
// La API key vive sólo acá, nunca en el navegador. `manejar` atiende un pedido
// HTTP de Node: lo usan server.mjs (local) y api/index.mjs (Vercel).
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { Sygners, SygnersError } from "@sygners/sdk";
import { almacen } from "./almacen.mjs";
import { TITULO, generarPdf } from "./terminos.mjs";

// Firmantes que se suman siempre, además de quien completa el formulario
// (por ejemplo, alguien de la empresa). Separados por coma.
const FIRMANTES_EXTRA = (process.env.FIRMANTES_EXTRA ?? "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

const sygners = new Sygners({
  apiKey: process.env.SYGNERS_API_KEY ?? "",
  baseUrl: process.env.SYGNERS_BASE_URL,
  idiomaErrores: "es-AR",
});

function estadoLink(l) {
  if (!l) return { estado: "inexistente" };
  if (l.documentoId) return { estado: "usado", usadoEl: l.usadoEl, documentoId: l.documentoId, firma: l.firma ?? null };
  return { estado: "pendiente", creadoEl: l.creadoEl };
}

// Un link sirve mientras exista y no se haya usado. Que no se esté usando en
// este momento lo asegura la reserva de `enviar`.
async function linkDisponible(id) {
  const l = typeof id === "string" ? await almacen.obtenerLink(id) : null;
  if (!l) return { error: "Este link para firmar no existe.", status: 404 };
  if (l.documentoId) return { error: "Este link ya se usó para firmar un acuerdo.", status: 409 };
  return { link: l };
}

async function crearLink(res) {
  const id = randomBytes(9).toString("base64url");
  const creadoEl = new Date().toISOString();
  await almacen.guardarLink(id, { creadoEl });
  json(res, 201, { id, creadoEl });
}

async function consultarLinks(url, res) {
  const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 200);
  const lista = await almacen.obtenerLinks(ids);
  await Promise.all(ids.map((id, i) => lista[i]?.documentoId && actualizarFirma(id, lista[i])));
  json(res, 200, Object.fromEntries(ids.map((id, i) => [id, estadoLink(lista[i])])));
}

// Si el documento de un link usado ya se firmó en sygners. Los estados finales
// quedan guardados en el link; los demás se vuelven a consultar como mucho
// cada 30 segundos (por instancia).
const FIRMA_TTL_MS = 30_000;
const FINALES = new Set(["firmado", "rechazado", "anulado", "vencido"]);
const consultadoEl = new Map();

async function actualizarFirma(id, l) {
  if (FINALES.has(l.firma) || Date.now() - (consultadoEl.get(l.documentoId) ?? 0) < FIRMA_TTL_MS) return;
  try {
    const e = await sygners.documentos.estado(l.documentoId);
    consultadoEl.set(l.documentoId, Date.now());
    const firma = aFirma(e);
    if (firma !== l.firma) {
      l.firma = firma;
      await almacen.guardarLink(id, l);
    }
  } catch (e) {
    // Sin respuesta de sygners: se muestra el último estado conocido.
    console.error(`No se pudo consultar ${l.documentoId}: ${e.message}`);
  }
}

function aFirma({ estado, venceEl }) {
  if (estado === "COMPLETED") return "firmado";
  if (estado === "REJECTED") return "rechazado";
  if (estado === "CANCELLED") return "anulado";
  if (venceEl && new Date(venceEl) < new Date()) return "vencido";
  return "sin-firmar";
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizar(d) {
  return {
    nombre: String(d?.nombre ?? "").trim().replace(/\s+/g, " "),
    dni: String(d?.dni ?? "").replace(/[.\s]/g, ""),
    email: String(d?.email ?? "").trim().toLowerCase(),
  };
}

const formatoDni = (dni) => Number(dni).toLocaleString("es-AR");

function validar(d) {
  const { nombre, dni, email } = normalizar(d);
  if (nombre.length < 3 || nombre.length > 80) return { error: "Ingresá tu nombre y apellido." };
  if (!/^\d{7,8}$/.test(dni)) return { error: "El DNI tiene que tener 7 u 8 números." };
  if (!EMAIL.test(email) || email.length > 254) return { error: "El email no es válido." };
  return { nombre, dni: formatoDni(dni), email };
}

// El PDF con lo que haya cargado hasta ahora y espacios en blanco para el
// resto. Sólo para mirar: no queda como borrador y no se puede enviar.
async function muestra(req, res) {
  const { nombre, dni } = normalizar(await leerJson(req));
  const pdf = await generarPdf({
    nombre: nombre.slice(0, 80),
    dni: /^\d{1,8}$/.test(dni) ? formatoDni(dni) : "",
    fecha: new Date(),
  });
  res.writeHead(200, { "Content-Type": "application/pdf", "Cache-Control": "no-store" });
  res.end(pdf);
}

async function previsualizar(req, res) {
  const cuerpo = await leerJson(req);
  const disponible = await linkDisponible(cuerpo.link);
  if (disponible.error) return json(res, disponible.status, { error: disponible.error });
  const v = validar(cuerpo);
  if (v.error) return json(res, 400, { error: v.error });

  const pdf = await generarPdf({ ...v, fecha: new Date() });
  const id = randomUUID();
  await almacen.guardarBorrador(id, { pdf, link: cuerpo.link, email: v.email, dni: v.dni });

  res.writeHead(200, { "Content-Type": "application/pdf", "X-Borrador": id, "Cache-Control": "no-store" });
  res.end(pdf);
}

async function enviar(req, res) {
  const { borrador: id } = await leerJson(req);
  const borrador = typeof id === "string" ? await almacen.obtenerBorrador(id) : null;
  if (!borrador) return json(res, 410, { error: "La vista previa venció. Generala de nuevo." });

  // Se reserva el link antes de llamar a sygners: dos envíos simultáneos desde
  // el mismo link no pueden crear dos documentos.
  if (!(await almacen.reservarLink(borrador.link))) {
    return json(res, 409, { error: "Este link se está usando en este momento." });
  }
  try {
    const disponible = await linkDisponible(borrador.link);
    if (disponible.error) return json(res, disponible.status, { error: disponible.error });

    const doc = await sygners.documentos.crear({
      archivo: borrador.pdf,
      nombre: `aceptacion-terminos-${borrador.dni.replace(/\./g, "")}.pdf`,
      tipo: "application/pdf",
      titulo: TITULO,
      firmantes: [...new Set([borrador.email, ...FIRMANTES_EXTRA])],
      idioma: "es-AR",
    });
    await almacen.guardarLink(borrador.link, {
      ...disponible.link,
      documentoId: doc.documentoId,
      usadoEl: new Date().toISOString(),
      firma: "sin-firmar",
    });
    await almacen.borrarBorrador(id);
    // La clave de acceso es la única copia: no la loguees ni la guardes junto
    // al email del firmante.
    console.log(`Documento ${doc.documentoId} enviado a ${doc.firmantes.map((f) => f.email).join(", ")}`);
    json(res, 200, {
      documentoId: doc.documentoId,
      claveDeAcceso: doc.claveDeAcceso,
      venceEl: doc.venceEl,
      firmantes: doc.firmantes,
      aviso: doc.aviso,
    });
  } catch (e) {
    if (e instanceof SygnersError) {
      console.error(`sygners (${e.paso}, ${e.status}, ${e.codigo}): ${e.message}`);
      const mensaje = e.status === 402 ? "El plan no tiene saldo para enviar este documento." : e.message;
      return json(res, 502, { error: mensaje });
    }
    throw e;
  } finally {
    await almacen.liberarLink(borrador.link);
  }
}

export async function manejar(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const ruta = `${req.method} ${url.pathname}`;
    if (ruta === "GET /" || ruta === "GET /index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(new URL("./public/index.html", import.meta.url)));
    }
    if (ruta === "POST /api/links") return await crearLink(res);
    if (ruta === "GET /api/links") return await consultarLinks(url, res);
    if (ruta === "POST /api/muestra") return await muestra(req, res);
    if (ruta === "POST /api/previsualizar") return await previsualizar(req, res);
    if (ruta === "POST /api/enviar") return await enviar(req, res);
    json(res, 404, { error: "No encontrado." });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.status ?? 500, { error: e.status ? e.message : "Error inesperado." });
  }
}

async function leerJson(req, limite = 1_000_000) {
  let tam = 0;
  const partes = [];
  for await (const parte of req) {
    tam += parte.length;
    if (tam > limite) throw Object.assign(new Error("La solicitud es demasiado grande."), { status: 413 });
    partes.push(parte);
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON inválido."), { status: 400 });
  }
}

function json(res, status, cuerpo) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(cuerpo));
}
