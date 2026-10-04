# @sygners/sdk

Cliente de la API de integración de [sygners](https://sygners.com): emití documentos para firmar
desde tu sistema, con el mismo cifrado que usa la web.

> ## ⚠️ Dos reglas antes de empezar
>
> 1. **La clave de acceso va a los firmantes por OTRO canal.** sygners les manda por email el enlace
>    de firma; la clave que te devuelve `crear` se la tenés que dar vos por otro lado (WhatsApp, SMS,
>    en persona). Si mandás la clave en el mismo mensaje que el enlace, el cifrado deja de proteger el
>    documento.
> 2. **La API key no se usa nunca desde un navegador.** Da acceso al cupo de tu plan. Usá el SDK
>    desde tu servidor; el cliente se niega a arrancar en un navegador.

## Qué hace

`documentos.crear` hace de tu lado lo mismo que hace el navegador en sygners.com:

1. calcula el SHA-256 del archivo (es lo que se ancla on-chain);
2. genera la **clave de acceso** (12 caracteres, 60 bits);
3. cifra el archivo con AES-256-GCM bajo una clave nueva del documento;
4. envuelve esa clave con Argon2id sobre la clave de acceso;
5. inicia el documento, sube el cifrado y lo sella.

Al sellar, sygners cobra la operación con el **cupo de tu plan** (una firma por firmante) y manda
las invitaciones. **sygners nunca recibe el archivo en claro ni la clave de acceso.**

## Instalación

```bash
npm install @sygners/sdk
```

Node 20 o más nuevo. La API key se genera en sygners.com → "Mi plan" → *Integración (API)*
(`sgn_live_…` en producción, `sgn_test_…` en stage).

## Uso

```ts
import { readFile } from "node:fs/promises";
import { Sygners } from "@sygners/sdk";

const sygners = new Sygners({ apiKey: process.env.SYGNERS_API_KEY! });

const doc = await sygners.documentos.crear({
  archivo: await readFile("contrato.pdf"),
  nombre: "contrato.pdf",
  tipo: "application/pdf",
  titulo: "Contrato de locación",
  firmantes: ["ana@ejemplo.com", "juan@ejemplo.com"],
  // emisor: "otra-cuenta@tuempresa.com", // una cuenta de tu plan; default: el dueño
  // metodoIdentidad: "partes" | "didit",
  // idioma: "es-AR" | "es-ES" | "en-US" | "pt-BR",
});

console.log(doc.documentoId);
console.log(doc.claveDeAcceso); // ← entregala por otro canal (ver arriba)

const estado = await sygners.documentos.estado(doc.documentoId);
if (estado.constanciaDisponible) {
  const pdf = await sygners.documentos.constancia(doc.documentoId);
}

await sygners.documentos.anular(doc.documentoId, "Se cargó el archivo equivocado");
```

Si un paso falla, `crear` lanza un `SygnersError` con `status`, `codigo` (estable) y `paso`
(`iniciar`, `subir` o `sellar`). Un documento iniciado y no sellado no cobra nada y vence solo.
Sin saldo en el plan, `status` es 402 y no se invita a nadie.

Cuando todos firman, el documento pasa a **privado**: sólo lo abren las wallets de los firmantes, y
la clave de acceso deja de abrirlo. Guardá tu copia del archivo original.

## Que la clave no pase por tu servidor

`crear` genera la clave de acceso en tu servidor. Si preferís que nazca en el navegador de quien
firma, partilo en tres:

```ts
// Navegador, en el handler del click (antes de cualquier await, o se bloquea como popup)
import { abrirVentanaDeFirma, cifrarDocumento } from "@sygners/sdk/navegador";
const ventana = abrirVentanaDeFirma();

// Servidor
const ini = await sygners.documentos.iniciar({ archivo, nombre, tipo, titulo, firmantes });
// → al navegador: ini.documentoId e ini.fileHash. El uploadToken se queda acá.

// Navegador
const { cifrado, llave, claveDeAcceso } = await cifrarDocumento({ archivo, documentoId, fileHash });
// → al servidor: cifrado y llave (no abren nada sin la clave).

// Servidor
const { venceEl, firmantes } = await sygners.documentos.completar(ini.documentoId, {
  uploadToken: ini.uploadToken,
  cifrado,
  llave,
  // Opcional: quien firma ahora, en este navegador. No recibe el email y su
  // enlace vuelve en firmantes[].urlFirma.
  firmaEnElNavegador: "ana@ejemplo.com",
});

// Navegador: lleva la pestaña a urlFirma y le entrega la clave con postMessage cuando
// sygners la pide. La clave nunca va en una URL.
await ventana.entregar({ urlFirma, claveDeAcceso });
```

Del lado de sygners, `/sign/[token]` guarda la clave en su `sessionStorage`, abre el documento sin
pedirla y la borra al firmar. `urlFirma` abre el documento para firmar: no lo guardes junto a la
clave en tu sistema ni lo mandes por el mismo canal. `@sygners/sdk/navegador` no usa la API key. Sin
bundler, cargá
`dist/navegador/sygners-navegador.js` (un solo archivo, con sus dependencias) con
`<script type="module">`.

## Webhooks

En "Mi plan" configurás una URL `https` y recibís un secreto (se muestra una sola vez). sygners
avisa `firma.registrada`, `documento.completado`, `documento.rechazado`, `documento.anulado` y
`documento.vencido` para los documentos que creaste con la API, y reintenta durante más de un día
si tu servidor no responde 2xx.

```ts
import { verificarWebhook } from "@sygners/sdk";

// Con el cuerpo CRUDO, tal como llegó.
const aviso = await verificarWebhook(cuerpoCrudo, req.headers["sygners-signature"], process.env.SYGNERS_WEBHOOK_SECRET!);
if (aviso.evento === "documento.completado") {
  // …
}
```

## Compatibilidad del cifrado

`src/cripto/` es copia textual del código de la web (ver `src/cripto/ORIGEN.md`), y
`test/vectores-sdk.json` son documentos que cifró la web: `npm test` comprueba que la copia los
abre. Si esa prueba falla, el SDK no se publica.

## Ejemplos

- [`examples/aceptacion-terminos`](examples/aceptacion-terminos): el usuario carga nombre y DNI desde
  un link para firmar, ve el PDF y lo firma: el navegador cifra con `@sygners/sdk/navegador` y abre
  el documento en sygners con la clave, que nunca pasa por el servidor.
