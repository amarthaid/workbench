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
    // Inside a container on a VM-backed bind mount inotify never fires;
    // docker-compose.dev.yml sets CHOKIDAR_USEPOLLING and this is the switch.
    watch: process.env.CHOKIDAR_USEPOLLING
      ? { usePolling: true, interval: Number(process.env.CHOKIDAR_INTERVAL ?? 400) }
      : undefined,
    proxy: {
      // The CDP live view streams over /api/.../cdp/events as SSE — plain
      // HTTP, so nothing here needs to forward an Upgrade.
      "/api": "http://localhost:3001",
      "/callback": "http://localhost:3001",
      // Every other path the server owns, so SERVER_PUBLIC_URL can be this
      // origin in dev — one registered OAuth redirect URI for prod and dev,
      // and an MCP client, REST call, presigned or one-time URL, jot or curl
      // proxy request pointed at the portal all reach the server. All plain
      // HTTP (the live view is SSE), so nothing forwards an Upgrade.
      "/mcp": "http://localhost:3001",
      "/rest": "http://localhost:3001",
      "/.well-known": "http://localhost:3001",
      "/register": "http://localhost:3001",
      // Exact matches only: /authorize and /authorize/resume are server
      // routes, but /authorize/choose is a portal SPA route — the raw
      // "/authorize" prefix was swallowing it and the OAuth flow 404'd.
      "^/authorize(?:/resume)?$": "http://localhost:3001",
      "/token": "http://localhost:3001",
      "/j": "http://localhost:3001",
      // Trailing slash matters: the proxy matches a raw path prefix, so a
      // bare "/c" would also swallow SPA routes like /connect/:integration.
      // Curl-proxy paths are always /c/<integration>/..., so "/c/" is exact
      // enough.
      "/c/": "http://localhost:3001",
    },
  },
});
