// Los vectores de sygners (`scripts/vectores-sdk.json` del repo principal): lo que
// allá ya se cifró, la copia de acá lo tiene que abrir. Si esto falla, la copia
// de `src/cripto` divergió y el SDK NO se publica.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256Hex } from "../src/cripto/hash";
import { bytesToHex, decryptDocument, documentAad, fromB64, hexToBytes, toB64, unwrapDek } from "../src/cripto/envelope";
import {
  ARGON2ID_PARAMS,
  PASSPHRASE_KEK_ALG,
  PASSPHRASE_LENGTH,
  decodeKdfParams,
  deriveKekFromPassphrase,
  encodeKdfParams,
  generatePassphrase,
  normalizeForAlg,
} from "../src/cripto/passphrase";

const v = JSON.parse(readFileSync(new URL("./vectores-sdk.json", import.meta.url), "utf8"));

test("mismo esquema: alg, longitud de la clave y parámetros de Argon2id", () => {
  assert.equal(v.esquema.alg, PASSPHRASE_KEK_ALG);
  assert.equal(v.esquema.longitudClave, PASSPHRASE_LENGTH);
  assert.equal(v.esquema.kdfParams, encodeKdfParams(ARGON2ID_PARAMS));
  assert.equal(generatePassphrase().phrase.length, PASSPHRASE_LENGTH);
});

test("la clave tipeada se normaliza igual", () => {
  for (const n of v.normalizacion) assert.equal(normalizeForAlg(n.entrada, PASSPHRASE_KEK_ALG), n.normalizada, n.entrada);
});

for (const d of v.documentos) {
  test(`abre el documento ${d.documentId}`, async () => {
    const plaintext = fromB64(d.plaintextB64);
    assert.equal(await sha256Hex(plaintext), d.fileHash, "hash");
    assert.equal(bytesToHex(documentAad(d.documentId, d.fileHash)), d.aadHex, "AAD");
    const kek = await deriveKekFromPassphrase(d.clave, d.kdfSalt, decodeKdfParams(d.kdfParams)!, v.esquema.alg);
    const dek = await unwrapDek(kek, d.wrappedKey);
    assert.equal(bytesToHex(dek), d.dekHex, "DEK");
    const plano = await decryptDocument({ dek: hexToBytes(d.dekHex), blob: fromB64(d.blobB64), documentId: d.documentId, fileHash: d.fileHash });
    assert.equal(toB64(plano), d.plaintextB64, "descifrado");
  });
}
