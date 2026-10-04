#!/usr/bin/env bash
# Publica el ejemplo en Vercel (producción).
#
# En local, @sygners/sdk es un link a la raíz del repo, y Vercel no empaqueta
# archivos de fuera del proyecto. Por eso se arma una copia aparte con el SDK
# instalado desde un tarball (`npm pack`) y se publica ya compilada.
# Requiere `vercel link` hecho en esta carpeta (.vercel/project.json).
set -euo pipefail

ejemplo="$(cd "$(dirname "$0")/.." && pwd)"
raiz="$(cd "$ejemplo/../.." && pwd)"
copia="$(mktemp -d)"
trap 'rm -rf "$copia"' EXIT

(cd "$raiz" && npm run build >/dev/null)
tarball="$(cd "$raiz" && npm pack --silent --pack-destination "$copia")"

# Sólo lo que se publica: nada de .env, links.json ni node_modules.
cp -R "$ejemplo"/{api,public,app.mjs,almacen.mjs,terminos.mjs,package.json,vercel.json} "$copia/"
mkdir "$copia/.vercel" && cp "$ejemplo/.vercel/project.json" "$copia/.vercel/"

cd "$copia"
npm install --silent --no-audit --no-fund "./$tarball"
# La parte del SDK que corre en el navegador, como archivo estático.
cp node_modules/@sygners/sdk/dist/navegador/sygners-navegador.js public/
vercel pull --yes --environment=production >/dev/null
vercel build --prod
vercel deploy --prebuilt --prod
