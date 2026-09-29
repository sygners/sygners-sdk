# Ejemplo: aceptación de términos

Una página donde el usuario carga **nombre, DNI y email**, hace su **firma de conformidad** en un
recuadro y ve el PDF armado antes de enviarlo. Al tocar **Enviar a firmar**, el servidor lo manda
con `@sygners/sdk`, y un modal muestra el **código para compartir** (la clave de acceso), con
botones para copiarlo y mandarlo por WhatsApp. Los códigos quedan en el `localStorage` del
navegador, en la lista **Documentos enviados**, para volver a compartirlos más tarde.

```
navegador                         server.mjs                          sygners
─────────                         ──────────                          ───────
nombre, DNI, email, firma ──▶ POST /api/previsualizar
                               arma el PDF (terminos.mjs)
             PDF + borrador ◀──  y lo guarda como borrador
      (vista previa en iframe)
Enviar a firmar ────────────▶ POST /api/enviar
                               documentos.crear(PDF) ──────────▶ invita por email
     código para compartir ◀── claveDeAcceso
            (modal)
```

Lo que se envía a firmar es exactamente el PDF que se previsualizó: el servidor guarda el borrador y
el navegador sólo manda su id. El texto de los términos lo pone el servidor; el navegador aporta los
datos y el trazo de la firma.

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
| `FIRMANTES_EXTRA`   | Opcional. Emails que firman siempre además del usuario, separados por coma. |
| `PORT`              | Opcional. Default `3000`.                                               |

## Para llevarlo a producción

- **El código va por otro canal.** El email de invitación lo manda sygners; el código lo comparte
  el usuario por WhatsApp, SMS o en persona. Nunca lo mandes en el mismo email que el enlace.
- **El código es la única copia.** `crear` la devuelve una vez y sygners no la tiene: el servidor
  la pasa al navegador y no la loguea. Este ejemplo la guarda en el `localStorage` de quien envió,
  así que cualquiera con acceso a ese navegador puede verla. Si la guardás en tu sistema, que no
  quede junto al email del firmante: juntos abren el documento.
- Los borradores viven en memoria 30 minutos. En producción, guardalos en tu base de datos.
- Validá del lado del servidor lo mismo que valida `validar()` en `server.mjs`, y sumá la
  autenticación de tu sistema delante de `/api/*`: sin ella, cualquiera puede consumir el cupo del plan.
