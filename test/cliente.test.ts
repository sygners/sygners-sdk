// El cliente contra una API falsa: qué viaja, qué devuelve y cómo falla.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sygners, SygnersError, AVISO_CLAVE } from "../src/index";
import { decryptDocument, unwrapDek } from "../src/cripto/envelope";
import { decodeKdfParams, deriveKekFromPassphrase } from "../src/cripto/passphrase";
import { sha256Hex } from "../src/cripto/hash";

const KEY = `sgn_test_${"a".repeat(43)}`;

type Llamada = { url: string; metodo: string; headers: Record<string, string>; cuerpo: Uint8Array | string | null };

function apiFalsa(opts: { fallarEn?: string } = {}) {
  const llamadas: Llamada[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const cuerpo = init.body instanceof Uint8Array ? init.body : typeof init.body === "string" ? init.body : null;
    llamadas.push({ url, metodo: init.method ?? "GET", headers: init.headers as Record<string, string>, cuerpo });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const paso = url.endsWith("/documentos") ? "iniciar" : url.endsWith("/cifrado") ? "subir" : url.endsWith("/sellar") ? "sellar" : "otro";
    if (opts.fallarEn === paso) return json({ error: "Al plan no le alcanza el saldo.", codigo: "planSinSaldo" }, 402);
    if (paso === "iniciar") return json({ documentoId: "cdoc1", uploadToken: "tok1" }, 201);
    if (paso === "subir") return json({ ok: true });
    if (paso === "sellar") return json({ venceEl: "2026-10-03T00:00:00.000Z", firmantes: [{ email: "a@b.c", estado: "PENDING" }] });
    return json({}, 404);
  }) as typeof fetch;
  return { f, llamadas };
}

test("crear: tres pasos, devuelve la clave, y ni el archivo ni la clave viajan", async () => {
  const { f, llamadas } = apiFalsa();
  const s = new Sygners({ apiKey: KEY, baseUrl: "https://ejemplo.test", fetch: f });
  const secreto = "CONTENIDO-SECRETO-DEL-CONTRATO-" + Math.random();
  const archivo = new TextEncoder().encode(secreto);
  const r = await s.documentos.crear({ archivo, nombre: "contrato.txt", firmantes: ["a@b.c"] });

  assert.deepEqual(llamadas.map((l) => `${l.metodo} ${new URL(l.url).pathname}`), [
    "POST /api/v1/documentos",
    "PUT /api/v1/documentos/cdoc1/cifrado",
    "POST /api/v1/documentos/cdoc1/sellar",
  ]);
  assert.match(r.claveDeAcceso, /^[0-9A-Z]{12}$/);
  assert.equal(r.aviso, AVISO_CLAVE);
  for (const l of llamadas) {
    assert.equal(l.headers.Authorization, `Bearer ${KEY}`);
    const texto = l.cuerpo instanceof Uint8Array ? new TextDecoder("utf-8", { fatal: false }).decode(l.cuerpo) : l.cuerpo ?? "";
    assert.ok(!texto.includes(secreto), `el archivo en claro viajó en ${l.url}`);
    assert.ok(!texto.toUpperCase().includes(r.claveDeAcceso), `la clave viajó en ${l.url}`);
  }

  // Lo que viajó, abierto con la clave devuelta: es el mismo archivo.
  const blob = llamadas[1].cuerpo as Uint8Array;
  const sello = JSON.parse(llamadas[2].cuerpo as string);
  const k = sello.keys[0];
  const kek = await deriveKekFromPassphrase(r.claveDeAcceso, k.kdfSalt, decodeKdfParams(k.kdfParams)!, k.alg);
  const dek = await unwrapDek(kek, k.wrappedKey);
  const plano = await decryptDocument({ dek, blob, documentId: "cdoc1", fileHash: r.fileHash });
  assert.equal(new TextDecoder().decode(plano), secreto);
  assert.equal(r.fileHash, await sha256Hex(archivo));
  assert.equal(JSON.parse(llamadas[0].cuerpo as string).fileHash, r.fileHash);
});

test("un error dice en qué paso fue", async () => {
  const { f } = apiFalsa({ fallarEn: "sellar" });
  const s = new Sygners({ apiKey: KEY, fetch: f });
  await assert.rejects(s.documentos.crear({ archivo: new Uint8Array([1, 2, 3]), nombre: "x", firmantes: ["a@b.c"] }), (e: unknown) => {
    assert.ok(e instanceof SygnersError);
    assert.equal(e.paso, "sellar");
    assert.equal(e.status, 402);
    assert.equal(e.codigo, "planSinSaldo");
    return true;
  });
});

test("rechaza una key mal formada", () => {
  assert.throws(() => new Sygners({ apiKey: "hola" }));
});
