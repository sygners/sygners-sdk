// Ejemplo: aceptación de términos con firma de conformidad.
//
//   1. El navegador manda nombre, DNI, email y el trazo de la firma.
//   2. El servidor arma el PDF y lo devuelve para previsualizarlo. Lo guarda
//      como borrador: lo que se envía a firmar es exactamente lo que se vio.
//   3. Al confirmar, el servidor lo manda a firmar con @sygners/sdk y devuelve
//      la clave de acceso para que el usuario la comparta por otro canal.
//
// La API key vive sólo acá, nunca en el navegador.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Sygners, SygnersError } from "@sygners/sdk";
import { TITULO, generarPdf } from "./terminos.mjs";

try {
  process.loadEnvFile();
} catch {
  // Sin .env: se usan las variables del entorno.
}

const PUERTO = Number(process.env.PORT ?? 3000);
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

// Borradores previsualizados y todavía no enviados. En memoria alcanza para el
// ejemplo; en producción, tu base de datos.
const BORRADOR_TTL_MS = 30 * 60 * 1000;
const borradores = new Map();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PREFIJO_PNG = "data:image/png;base64,";

function validar(d) {
  const nombre = String(d?.nombre ?? "").trim().replace(/\s+/g, " ");
  const dni = String(d?.dni ?? "").replace(/[.\s]/g, "");
  const email = String(d?.email ?? "").trim().toLowerCase();
  const firma = String(d?.firma ?? "");
  if (nombre.length < 3 || nombre.length > 80) return { error: "Ingresá tu nombre y apellido." };
  if (!/^\d{7,8}$/.test(dni)) return { error: "El DNI tiene que tener 7 u 8 números." };
  if (!EMAIL.test(email) || email.length > 254) return { error: "El email no es válido." };
  if (!firma.startsWith(PREFIJO_PNG)) return { error: "Falta la firma de conformidad." };
  const firmaPng = Buffer.from(firma.slice(PREFIJO_PNG.length), "base64");
  if (firmaPng.length < 100) return { error: "Falta la firma de conformidad." };
  return { nombre, dni: Number(dni).toLocaleString("es-AR"), email, firmaPng };
}

async function previsualizar(req, res) {
  const v = validar(await leerJson(req));
  if (v.error) return json(res, 400, { error: v.error });

  const pdf = await generarPdf({ ...v, fecha: new Date() });
  const id = randomUUID();
  borradores.set(id, { pdf, email: v.email, dni: v.dni, vence: Date.now() + BORRADOR_TTL_MS });

  res.writeHead(200, { "Content-Type": "application/pdf", "X-Borrador": id, "Cache-Control": "no-store" });
  res.end(pdf);
}

async function enviar(req, res) {
  const { borrador: id } = await leerJson(req);
  const borrador = borradores.get(id);
  if (!borrador || borrador.vence < Date.now()) {
    borradores.delete(id);
    return json(res, 410, { error: "La vista previa venció. Generala de nuevo." });
  }

  try {
    const doc = await sygners.documentos.crear({
      archivo: borrador.pdf,
      nombre: `aceptacion-terminos-${borrador.dni.replace(/\./g, "")}.pdf`,
      tipo: "application/pdf",
      titulo: TITULO,
      firmantes: [...new Set([borrador.email, ...FIRMANTES_EXTRA])],
      idioma: "es-AR",
    });
    borradores.delete(id);
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
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(new URL("./public/index.html", import.meta.url)));
    }
    if (req.method === "POST" && req.url === "/api/previsualizar") return await previsualizar(req, res);
    if (req.method === "POST" && req.url === "/api/enviar") return await enviar(req, res);
    json(res, 404, { error: "No encontrado." });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.status ?? 500, { error: e.status ? e.message : "Error inesperado." });
  }
});

server.listen(PUERTO, () => console.log(`Ejemplo en http://localhost:${PUERTO}`));

setInterval(() => {
  const ahora = Date.now();
  for (const [id, b] of borradores) if (b.vence < ahora) borradores.delete(id);
}, 60_000).unref();

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
