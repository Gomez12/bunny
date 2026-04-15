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
    // Sourcemaps balloon the shipped binary (every chunk ships its .map).
    // Keep them in dev (Vite's dev server always produces them) and drop the
    // emitted files from the prod bundle we embed via scripts/build.ts.
    sourcemap: false,
  },
});
