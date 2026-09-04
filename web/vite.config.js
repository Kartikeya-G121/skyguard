import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, allowedHosts: ["pursuit-alienable-cope.ngrok-free.dev"] },
  optimizeDeps: { include: ["prop-types", "react-simple-maps"] },
});
