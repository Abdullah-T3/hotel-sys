import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// `npm run dev` proxies the API to a gateway on :8080; `npm run build` writes the UI into the server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../server/app/static", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/v1": "http://127.0.0.1:8080", "/health": "http://127.0.0.1:8080" },
  },
});
