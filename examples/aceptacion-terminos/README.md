# Ejemplo: aceptación de términos

Quien emite entra a la página y toca **Crear link para firmar**: cada link sirve para firmar **un
solo** acuerdo, y la lista de links creados queda en el `localStorage` del navegador. Cada link
está *Pendiente* o *Completado* (ya se creó el acuerdo desde él); los completados muestran además
si el documento se firmó en sygners (*Firmado*, *No firmado*, *Rechazado*, *Anulado* o *Vencido*),
que el servidor consulta con `documentos.estado`.

Quien abre un link ve desde el primer momento el PDF, con espacios en blanco para lo que falta, que
se va completando a medida que carga **nombre, DNI y email** (`POST /api/muestra`: sólo para mirar,
no se puede firmar). **Ver documento** arma el PDF definitivo. El PDF no lleva firma a mano: la firma
se hace en sygners. Al tocar **Firmar**, el servidor crea el documento con `@sygners/sdk` y devuelve la
clave de acceso y el link para firmar. El navegador guarda la clave en su `localStorage` (lista
**Documentos para firmar**), la copia al portapapeles y redirige directo a sygners, donde se pega
para abrir el documento. Si el navegador no deja copiar, muestra la clave en un modal con
**Ir a firmar**. sygners igual manda su invitación por email.

```
navegador                         server.mjs                          sygners
─────────                         ──────────                          ───────
Crear link para firmar ─────▶ POST /api/links
          /?link=<id> ◀──────  lo registra (links.json o Redis)

(desde el link)
nombre, DNI, email ────────▶ POST /api/previsualizar
                               arma el PDF (terminos.mjs)
             PDF + borrador ◀──  y lo guarda como borrador
      (vista previa en iframe)
Firmar ─────────────────────▶ POST /api/firmar
                               documentos.crear(PDF) ──────────▶ invita por email
   código + link para firmar ◀── claveDeAcceso; el link queda usado
  (localStorage + portapapeles)
redirige a sygners ─────────────────────────────────────────────▶ /sign/<documentoId>
```

Lo que se firma es exactamente el PDF que se previsualizó: el servidor guarda el borrador y
el navegador sólo manda su id. El texto de los términos lo pone el servidor; el navegador sólo aporta los
datos. Qué links existen y cuáles ya se usaron lo sabe el servidor
(`links.json`), porque un link se abre en cualquier navegador; el link se reserva mientras se crea el
documento, así que dos pedidos simultáneos no crean dos documentos.

## Correrlo

```bash
# 1. Compilar el SDK (el ejemplo lo usa desde la raíz del repo)
cd ../.. && npm install && npm run build && cd examples/aceptacion-terminos

# 2. Instalar y configurar
npm install
cp .env.example .env   # completá SYGNERS_API_KEY (sgn_test_… para stage)

# 3. Arrancar
npm start              # http://localhost:3000
```

| Variable            | Qué es                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| `SYGNERS_API_KEY`   | Obligatoria. "Mi plan" → *Integración (API)*.                           |
| `SYGNERS_BASE_URL`  | Opcional. Otra URL de la API (por ejemplo, stage).                      |
| `SYGNERS_URL_FIRMA` | Opcional. Dónde se firma; `{documentoId}` se reemplaza. Default `<SYGNERS_BASE_URL>/sign/{documentoId}`. |
| `FIRMANTES_EXTRA`   | Opcional. Emails que firman siempre además del usuario, separados por coma. |
| `PORT`              | Opcional. Default `3000`.                                               |

## Publicarlo en Vercel

En Vercel cada pedido puede caer en una instancia distinta y el disco es de sólo lectura, así que
los links y borradores van a **Upstash Redis** (`almacen.mjs` lo usa cuando encuentra
`KV_REST_API_URL`/`KV_REST_API_TOKEN` o `UPSTASH_REDIS_REST_URL`/`TOKEN`). La página se sirve
estática desde `public/` y `/api/*` es una sola función (`api/index.mjs`).

```bash
vercel link                                   # una vez
vercel integration add upstash/upstash-kv     # una vez: crea el Redis y carga sus variables
vercel env add SYGNERS_API_KEY production     # una vez (y SYGNERS_BASE_URL si no es producción)
npm run deploy:vercel
```

`deploy:vercel` publica desde una copia aparte con el SDK instalado desde `npm pack`: en local
`@sygners/sdk` es un link a la raíz del repo, que Vercel no empaqueta.

## Para llevarlo a producción

- **El código va por otro canal.** Acá el código queda en el navegador de quien firma y nunca viaja
  por email. Si sumás `FIRMANTES_EXTRA`, a ellos compartíselo por WhatsApp, SMS o en persona, nunca
  en el mismo email que el enlace de la invitación.
- **El código es la única copia.** `crear` la devuelve una vez y sygners no la tiene: el servidor
  la pasa al navegador y no la loguea. Este ejemplo la guarda en el `localStorage` de quien firma,
  así que cualquiera con acceso a ese navegador puede verla. Si la guardás en tu sistema, que no
  quede junto al email del firmante: juntos abren el documento.
- Los borradores viven en memoria 30 minutos y los links en `links.json`. En producción, guardá
  los dos en tu base de datos.
- Validá del lado del servidor lo mismo que valida `validar()` en `server.mjs`, y sumá la
  autenticación de tu sistema delante de `POST /api/links` y de la lista de links: sin ella,
  cualquiera puede crear links y consumir el cupo del plan.
