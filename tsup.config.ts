import { defineConfig } from "tsup";

export default defineConfig([
  // Paquete npm: servidor (Node) y navegador para bundlers.
  {
    entry: ["src/index.ts", "src/navegador.ts"],
    format: ["esm", "cjs"],
    dts: true,
  },
  // `navegador` en un solo archivo, con hash-wasm adentro, para cargarlo con
  // <script type="module"> sin bundler.
  {
    entry: { "sygners-navegador": "src/navegador.ts" },
    format: ["esm"],
    platform: "browser",
    noExternal: ["hash-wasm"],
    outDir: "dist/navegador",
  },
]);
