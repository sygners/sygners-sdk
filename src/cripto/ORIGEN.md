# Origen de estos archivos

`envelope.ts`, `passphrase.ts`, `hash.ts` y `signature.ts` son **copia textual** de
`src/lib/` del repo de sygners. No se editan acá.

Si cambian allá, se copian de nuevo y se actualiza `test/vectores-sdk.json` con
`scripts/vectores-sdk.json` del mismo commit. `npm test` falla si la copia deja de
abrir lo que sygners ya cifró.

Copiados del commit `be10c6c` (26/09/2026).
