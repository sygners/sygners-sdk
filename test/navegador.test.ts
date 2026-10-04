// La entrega de la clave a sygners: fragmento + sessionStorage, sin servidor.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { urlParaFirmar, abrirParaFirmar, tomarClaveDelFragmento, leerClave } from "../src/navegador";

// Un navegador mínimo: location, history y sessionStorage.
let url: URL;
let asignada: string | null;
beforeEach(() => {
  url = new URL("https://demo.test/");
  asignada = null;
  const datos = new Map<string, string>();
  Object.assign(globalThis, {
    sessionStorage: { getItem: (k: string) => datos.get(k) ?? null, setItem: (k: string, v: string) => void datos.set(k, v) },
    location: {
      get hash() { return url.hash; },
      get pathname() { return url.pathname; },
      get search() { return url.search; },
      assign: (u: string) => { asignada = u; },
    },
    history: { state: null, replaceState: (_s: unknown, _t: string, u: string) => { url = new URL(u, url); } },
  });
});

test("urlParaFirmar pone la clave en el fragmento, no en la query", () => {
  const u = new URL(urlParaFirmar("https://sygners.test/documents/cdoc1", "K7QM2XB9FTZ4"));
  assert.equal(u.search, "");
  assert.equal(u.hash, "#clave=K7QM2XB9FTZ4");
});

test("abrirParaFirmar guarda la clave y navega", () => {
  abrirParaFirmar({ urlDocumento: "https://sygners.test/documents/cdoc1", documentoId: "cdoc1", claveDeAcceso: "K7QM2XB9FTZ4" });
  assert.equal(leerClave("cdoc1"), "K7QM2XB9FTZ4");
  assert.equal(asignada, "https://sygners.test/documents/cdoc1#clave=K7QM2XB9FTZ4");
});

test("tomarClaveDelFragmento la pasa a sessionStorage y la saca de la URL", () => {
  url = new URL("https://sygners.test/documents/cdoc1?x=1#clave=K7QM2XB9FTZ4&otro=2");
  assert.equal(tomarClaveDelFragmento("cdoc1"), "K7QM2XB9FTZ4");
  assert.equal(url.toString(), "https://sygners.test/documents/cdoc1?x=1#otro=2");
  // Al recargar, sin fragmento, sale de sessionStorage.
  assert.equal(tomarClaveDelFragmento("cdoc1"), "K7QM2XB9FTZ4");
  assert.equal(tomarClaveDelFragmento("otro-doc"), null);
});
