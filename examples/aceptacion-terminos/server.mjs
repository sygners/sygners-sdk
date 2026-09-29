// Arranque local: `npm start`. En Vercel, el mismo `manejar` corre desde
// api/index.mjs.
import { createServer } from "node:http";

try {
  process.loadEnvFile();
} catch {
  // Sin .env: se usan las variables del entorno.
}
// Después de cargar el .env: app.mjs lee la configuración al importarse.
const { manejar } = await import("./app.mjs");

const PUERTO = Number(process.env.PORT ?? 3000);
createServer(manejar).listen(PUERTO, () => console.log(`Ejemplo en http://localhost:${PUERTO}`));
