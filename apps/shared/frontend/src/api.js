// Datasource switch — picks which backend every `api.*` call in this app
// actually talks to, the same role Grafana's datasource plugin selection
// plays: components (TraceExplorer, TraceWaterfall, ServiceMap, App, …)
// import `{ api }` from here and call it the same way regardless of which
// implementation answers.
//
//   - self-hosted (default, `npm run build`): ./datasource/engineApi.js —
//     proxied through apps/self-hosted/web to one engine next to your own Docker host.
//     This is the ONLY implementation that existed before the hosted/
//     thin-agent build, and this file resolving to it by default (nothing
//     has to opt in) is what keeps that build's behavior byte-for-byte
//     unchanged — see that file's own header.
//   - hosted (`npm run build:hosted`, i.e. `vite build --mode hosted` —
//     see package.json / vite.config.js): ./datasource/hostedApi.js —
//     talks to license-server's /v1/dashboard/* routes instead, scoped to
//     the logged-in account.
//
// DEPLOY_MODE reads Vite's own built-in `import.meta.env.MODE` (set
// directly by the `--mode hosted` CLI flag, no extra file needed) rather
// than a custom VITE_DEPLOY_MODE env var sourced from a `.env.hosted`
// file — that was the original design here, and it was fragile in
// exactly the way that bit: `.env.hosted` has to physically survive
// `COPY apps/shared/frontend .` in the Docker build for VITE_DEPLOY_MODE to ever
// be set, and when it silently didn't (multi-stage Docker build, easy for
// a file like that to not make the trip), this fell back to
// self-hosted's engineApi/Docker-UI branch while still being served at
// /app/ — because `base: '/app/'` in vite.config.js already read the
// built-in `mode` param directly and got it right, masking that
// DEPLOY_MODE itself hadn't. Vite's own `MODE` needs no such file and
// can't go missing the same way, so it's used directly now.
import { engineApi } from './datasource/engineApi.js';
import { hostedApi } from './datasource/hostedApi.js';

export const DEPLOY_MODE = import.meta.env.MODE === 'hosted' ? 'hosted' : 'self-hosted';

export const api = DEPLOY_MODE === 'hosted' ? hostedApi : engineApi;
