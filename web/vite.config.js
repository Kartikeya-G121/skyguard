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
        // Keep the map and UI libraries out of the app chunk so a redeploy of
        // app code does not invalidate them in the browser cache. The MQTT
        // client is left alone: it is loaded only when a device connects.
        manualChunks(id) {
          if (id.includes("leaflet")) return "map";
          if (/node_modules\/(react|react-dom|react-router|scheduler|motion|motion-dom|motion-utils|framer-motion|lenis)\//.test(id)) {
            return "vendor";
          }
        },
      },
    },
  },
});
