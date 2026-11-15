import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Relative base: index.html sets a <base href> at runtime, so one build works both at
// https://utubeflow.codelove.in/ and at https://<user>.github.io/youtube-for-all/.
// The SSR build (`vite build --ssr src/prerender.tsx --outDir dist-ssr`) only renders the home page to HTML
// at build time; it keeps node_modules external, so the chunk split applies to the browser build only.
export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: isSsrBuild
      ? {}
      : {
          output: {
            manualChunks: (id: string) =>
              id.includes("node_modules/@firebase") || id.includes("node_modules/firebase")
                ? "firebase"
                : id.includes("node_modules")
                  ? "vendor"
                  : undefined,
          },
        },
  },
}));
