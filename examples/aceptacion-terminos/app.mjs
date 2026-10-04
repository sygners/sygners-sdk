// Ejemplo: aceptación de términos con firma de conformidad.
//
//   0. Quien emite crea un link por persona. Cada link firma un solo documento.
//   1. Desde el link, el navegador manda nombre, DNI y email.
//   2. El servidor arma el PDF y lo devuelve para previsualizarlo. Lo guarda
//      como borrador: lo que se firma es exactamente lo que se vio.
//   3. Al tocar "Firmar":
//      a. el servidor inicia el documento en sygners (`documentos.iniciar`);
//      b. el navegador genera la clave de acceso y cifra el PDF con
//         `@sygners/sdk/navegador`, y devuelve el cifrado y la llave;
//      c. el servidor sube y sella (`documentos.completar`) con
//         `firmaEnElNavegador`: a quien firma no le llega el email, y su enlace
//         de firma vuelve acá;
//      d. el navegador lleva a sygners la pestaña que abrió al tocar "Firmar" y
//         le entrega la clave con postMessage.
//      La clave de acceso nunca pasa por este servidor ni va en una URL.
//
// La API key vive sólo acá, nunca en el navegador. `manejar` atiende un pedido
// HTTP de Node: lo usan server.mjs (local) y api/index.mjs (Vercel).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
// este momento lo asegura la reserva de `iniciarFirma`.
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
// resto. Sólo para mirar: no queda como borrador y no se puede firmar.
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

// Inicia el documento en sygners y reserva el link hasta que se complete (o
// venza la reserva). El navegador recibe lo que necesita para cifrar: el id y
// el hash del PDF. El uploadToken se queda en el borrador.
async function iniciarFirma(req, res) {
  const { borrador: id } = await leerJson(req);
  const borrador = typeof id === "string" ? await almacen.obtenerBorrador(id) : null;
  if (!borrador) return json(res, 410, { error: "La vista previa venció. Generala de nuevo." });
  // Reintento después de un error en el navegador: el documento ya existe.
  if (borrador.documentoId) return json(res, 200, { documentoId: borrador.documentoId, fileHash: borrador.fileHash });

  // Dos firmas simultáneas desde el mismo link no pueden crear dos documentos.
  if (!(await almacen.reservarLink(borrador.link))) {
    return json(res, 409, { error: "Este link se está usando en este momento." });
  }
  try {
    const disponible = await linkDisponible(borrador.link);
    if (disponible.error) throw Object.assign(new Error(disponible.error), { status: disponible.status });

    const ini = await sygners.documentos.iniciar({
      archivo: borrador.pdf,
      nombre: `aceptacion-terminos-${borrador.dni.replace(/\./g, "")}.pdf`,
      tipo: "application/pdf",
      titulo: TITULO,
      firmantes: [...new Set([borrador.email, ...FIRMANTES_EXTRA])],
      idioma: "es-AR",
    });
    await almacen.guardarBorrador(id, { ...borrador, documentoId: ini.documentoId, uploadToken: ini.uploadToken, fileHash: ini.fileHash });
    json(res, 200, { documentoId: ini.documentoId, fileHash: ini.fileHash });
  } catch (e) {
    await almacen.liberarLink(borrador.link);
    if (e instanceof SygnersError) return errorSygners(res, e);
    throw e;
  }
}

// Sube el PDF cifrado en el navegador y sella. `cifrado` y `llave` no abren
// nada sin la clave de acceso, que se quedó en el navegador.
async function completarFirma(req, res) {
  const { borrador: id, cifrado, llave } = await leerJson(req, 10_000_000);
  const borrador = typeof id === "string" ? await almacen.obtenerBorrador(id) : null;
  if (!borrador?.documentoId) return json(res, 410, { error: "La firma no se inició o venció. Generá la vista previa de nuevo." });
  if (typeof cifrado !== "string" || llave?.kind !== "passphrase") return json(res, 400, { error: "Falta el documento cifrado." });

  try {
    const disponible = await linkDisponible(borrador.link);
    if (disponible.error) return json(res, disponible.status, { error: disponible.error });

    const sellado = await sygners.documentos.completar(borrador.documentoId, {
      uploadToken: borrador.uploadToken,
      cifrado: Buffer.from(cifrado, "base64"),
      llave,
      // Firma ahora, en este navegador: recibe su enlace en vez del email.
      firmaEnElNavegador: borrador.email,
    });
    const urlFirma = sellado.firmantes.find((f) => f.email === borrador.email)?.urlFirma;
    await almacen.guardarLink(borrador.link, {
      ...disponible.link,
      documentoId: borrador.documentoId,
      usadoEl: new Date().toISOString(),
      firma: "sin-firmar",
    });
    await almacen.borrarBorrador(id);
    console.log(`Documento ${borrador.documentoId} creado para ${sellado.firmantes.map((f) => f.email).join(", ")}`);
    // Una versión de sygners sin `firmaEnElNavegador` sella igual y manda el
    // email: quien firma entra desde ahí.
    if (!urlFirma) console.error(`sygners no devolvió el enlace de firma de ${borrador.documentoId}`);
    json(res, 200, {
      documentoId: borrador.documentoId,
      urlFirma: urlFirma ?? null,
      venceEl: sellado.venceEl,
      firmantes: sellado.firmantes,
    });
  } catch (e) {
    if (e instanceof SygnersError) return errorSygners(res, e);
    throw e;
  } finally {
    await almacen.liberarLink(borrador.link);
  }
}

function errorSygners(res, e) {
  console.error(`sygners (${e.paso}, ${e.status}, ${e.codigo}): ${e.message}`);
  const mensaje = e.status === 402 ? "El plan no tiene saldo para enviar este documento." : e.message;
  json(res, 502, { error: mensaje });
}

// La parte del SDK que corre en el navegador, en un solo archivo. En Vercel
// la copia a public/ el script de deploy.
const SDK_NAVEGADOR = fileURLToPath(import.meta.resolve("@sygners/sdk/navegador/sygners-navegador.js"));

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
    if (ruta === "GET /sygners-navegador.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(await readFile(SDK_NAVEGADOR));
    }
    if (ruta === "POST /api/firmar/iniciar") return await iniciarFirma(req, res);
    if (ruta === "POST /api/firmar/completar") return await completarFirma(req, res);
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
