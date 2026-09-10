import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      // The CDP live view streams over /api/.../cdp/events as SSE — plain
      // HTTP, so nothing here needs to forward an Upgrade.
      "/api": "http://localhost:3001",
      "/callback": "http://localhost:3001",
    },
  },
});
