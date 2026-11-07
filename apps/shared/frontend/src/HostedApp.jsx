// DEPRECATED — no longer imported anywhere. The hosted build's top-level
// UI now lives inside App.jsx itself (see its HOSTED constant and the
// `if (HOSTED) { ... }` branch near its return), so main.jsx always mounts
// App regardless of DEPLOY_MODE. This file is left in place only because
// deleting it requires separate permission on your machine — safe to
// delete by hand (`rm apps/shared/frontend/src/HostedApp.jsx`) whenever convenient;
// nothing in the build references it anymore.
