// El verificador de avisos, contra la misma firma que calcula sygners.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verificarWebhook } from "../src/index";

const SECRETO = "whsec_sgn_" + "b".repeat(43);
const cuerpo = JSON.stringify({ id: "e1", evento: "firma.registrada", creado: "2026-09-26T00:00:00Z", documento: { id: "d1", estado: "PARTIAL" }, firmante: "a@b.c" });
const firmar = (s: string, t: number, c = cuerpo) => `t=${t},v1=${createHmac("sha256", s).update(`${t}.${c}`).digest("hex")}`;

test("acepta un aviso bien firmado y lo devuelve", async () => {
  const t = Math.floor(Date.now() / 1000);
  const a = await verificarWebhook(cuerpo, firmar(SECRETO, t), SECRETO);
  assert.equal(a.evento, "firma.registrada");
  assert.equal(a.documento.id, "d1");
});

test("rechaza otro secreto, un cuerpo tocado y una firma vieja", async () => {
  const t = Math.floor(Date.now() / 1000);
  await assert.rejects(verificarWebhook(cuerpo, firmar("otro", t), SECRETO));
  await assert.rejects(verificarWebhook(cuerpo.replace("PARTIAL", "COMPLETED"), firmar(SECRETO, t), SECRETO));
  await assert.rejects(verificarWebhook(cuerpo, firmar(SECRETO, t - 3600), SECRETO));
  await assert.rejects(verificarWebhook(cuerpo, null, SECRETO));
});
