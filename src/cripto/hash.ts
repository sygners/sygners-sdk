// Hash del documento — UNA sola implementación, isomórfica.
//
// Es el "momento cero" de toda la evidencia: el valor que se ancla on-chain y
// contra el que después se verifica todo. Desde WIP-012 el hash lo calcula el
// BROWSER (el servidor ya no ve el plaintext), y el firmante lo recalcula sobre
// el plaintext descifrado antes de firmar. Las tres cosas tienen que salir del
// mismo código: dos implementaciones que se desincronizan es exactamente el
// riesgo invisible que describe WIP-006.
//
// WebCrypto, disponible en el browser y en Node 19+ vía globalThis.crypto.

// SHA-256 de un buffer, como hex con prefijo 0x (bytes32).
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    data as unknown as BufferSource,
  );
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `0x${hex}`;
}

// Comparación de hashes tolerante a mayúsculas y al prefijo 0x. Se usa en la
// verificación bloqueante del firmante, así que no puede fallar por formato.
export function hashesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (h: string) => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
  return norm(a) === norm(b);
}
