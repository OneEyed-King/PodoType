import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds to ./dist — ../web/Dockerfile's ui-build stage copies that
// straight into the web image as /app/public (see ../web/Dockerfile).
// engine/web split: during local dev (`npm run dev`), API calls go
// through the proxy below straight to the engine (not through the web
// service at all) so you don't need CORS or an API key for dev — just run
// `node engine/server.js` in ui/ alongside this, WITHOUT setting
// ENGINE_API_KEY (see engine/server.js's "Engine API auth" comment for why
// an unset key skips the check).
//
// `npm run build:hosted` (see package.json) runs this same config in
// "hosted" mode (--mode hosted) — see src/api.js's header for what that
// switches at the JS level. The one build-config difference for that mode
// is `base`: self-hosted's apps/self-hosted/web serves the compiled app at the domain
// root, so its asset URLs stay root-relative ("/assets/..."); the hosted
// bundle is served from license-server's public/app/ subpath instead (see
// apps/hosted/license-server/Dockerfile's ui-build stage and server.js's static
// mount), so its own asset URLs need the matching "/app/" prefix or the
// browser would ask license-server for "/assets/..." at the domain root
// and get nothing back.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'hosted' ? '/app/' : '/',
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
