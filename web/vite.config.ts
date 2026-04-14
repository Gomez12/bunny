import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Bun server port (see src/server/index.ts).
const API_TARGET = process.env.BUNNY_API ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
    fs: {
      // Allow importing shared type files from the backend (../src/agent/sse_events.ts).
      allow: [".."],
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
