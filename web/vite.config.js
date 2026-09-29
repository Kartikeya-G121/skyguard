import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tunnels (ngrok, cloudflared) for sharing a local dev server need their host
// allowed explicitly: SKYGUARD_ALLOWED_HOSTS=abc.ngrok-free.dev npm run dev
const allowedHosts = process.env.SKYGUARD_ALLOWED_HOSTS?.split(",").filter(Boolean) ?? [];

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, allowedHosts },
  preview: { port: 4180, allowedHosts },
  build: {
    rolldownOptions: {
      output: {
        // Keep the map and animation libraries out of the app chunk so a
        // redeploy of app code does not invalidate them in the browser cache.
        manualChunks(id) {
          if (id.includes("leaflet")) return "map";
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
});
