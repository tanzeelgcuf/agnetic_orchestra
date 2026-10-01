import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4100",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        // The bearer token stays server-side; the browser never sees it.
        headers: {
          Authorization: `Bearer ${process.env.ORCHESTRA_API_TOKEN ?? "dev-token-change-me"}`
        }
      }
    }
  }
});
