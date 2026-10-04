// La entrega de la clave a sygners con postMessage: nunca en una URL.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { abrirVentanaDeFirma, VentanaBloqueadaError, MENSAJE_CLAVE, MENSAJE_LISTO } from "../src/navegador";

const ORIGEN = "https://sygners.test";
const URL_FIRMA = `${ORIGEN}/sign/tok123`;

// Un navegador mínimo: window.open, la pestaña abierta y los mensajes.
let oyentes: ((e: MessageEvent) => void)[];
let pestaña: {
  location: { href: string };
  document: { title: string; body: { textContent: string; style: { cssText: string } } };
  recibidos: { data: unknown; origen: string }[];
  postMessage: (data: unknown, origen: string) => void;
  close: () => void;
  cerrada: boolean;
};
let bloquear: boolean;

beforeEach(() => {
  oyentes = [];
  bloquear = false;
  pestaña = {
    location: { href: "about:blank" },
    document: { title: "", body: { textContent: "", style: { cssText: "" } } },
    recibidos: [],
    postMessage(data, origen) {
      this.recibidos.push({ data, origen });
    },
    close() {
      this.cerrada = true;
    },
    cerrada: false,
  };
  Object.assign(globalThis, {
    window: { open: () => (bloquear ? null : pestaña) },
    addEventListener: (_t: string, f: (e: MessageEvent) => void) => oyentes.push(f),
    removeEventListener: (_t: string, f: (e: MessageEvent) => void) => (oyentes = oyentes.filter((o) => o !== f)),
  });
});

const avisar = (source: unknown, origin: string, data: unknown) =>
  oyentes.slice().forEach((f) => f({ source, origin, data } as MessageEvent));

test("abre en blanco, navega a urlFirma sin la clave y la entrega sólo al origen de sygners", async () => {
  const v = abrirVentanaDeFirma();
  assert.equal(pestaña.location.href, "about:blank");
  const entregada = v.entregar({ urlFirma: URL_FIRMA, claveDeAcceso: "K7QM2XB9FTZ4" });
  assert.equal(pestaña.location.href, URL_FIRMA);
  assert.ok(!String(pestaña.location.href).includes("K7QM2XB9FTZ4"));

  // Mensajes que no corresponden: otra ventana, otro origen, otro tipo.
  avisar({}, ORIGEN, { tipo: MENSAJE_LISTO });
  avisar(pestaña, "https://otro.test", { tipo: MENSAJE_LISTO });
  avisar(pestaña, ORIGEN, { tipo: "otra-cosa" });
  assert.equal(pestaña.recibidos.length, 0);

  avisar(pestaña, ORIGEN, { tipo: MENSAJE_LISTO });
  await entregada;
  assert.deepEqual(pestaña.recibidos, [{ data: { tipo: MENSAJE_CLAVE, clave: "K7QM2XB9FTZ4" }, origen: ORIGEN }]);
  // Una sola vez: deja de escuchar.
  avisar(pestaña, ORIGEN, { tipo: MENSAJE_LISTO });
  assert.equal(pestaña.recibidos.length, 1);
  assert.equal(oyentes.length, 0);
});

test("con la pestaña bloqueada, lo dice", () => {
  bloquear = true;
  assert.throws(() => abrirVentanaDeFirma(), VentanaBloqueadaError);
});

test("cerrar cierra la pestaña", () => {
  abrirVentanaDeFirma().cerrar();
  assert.equal(pestaña.cerrada, true);
});
