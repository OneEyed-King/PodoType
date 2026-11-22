# Changelog

All notable changes to PodoType are logged here. For what the tool currently
does, see `README.md` — this file is for what's new.

## Unreleased

### Added
- The dashboard is now available in German, Spanish, French, Japanese,
  Brazilian Portuguese, and Russian, in addition to English — pick a
  language from the switcher in the header; detected from the browser by
  default, remembered once changed.
- HTTP Basic Auth in front of the whole self-hosted dashboard (UI and
  API alike), on by default (`admin`/`admin`) — change it via
  `PODOTYPE_BASIC_AUTH_USER`/`PODOTYPE_BASIC_AUTH_PASSWORD` in `.env`
  before exposing an install beyond a trusted network.
- A ground-truth preflight warning: `/api/preflight` now also checks
  whether Beyla has actually resolved any real traffic after a 90-second
  grace period (not just whether its metrics port answers), and the
  dashboard shows a banner linking to Code Tracing when it hasn't —
  catches the Docker Desktop/WSL2 case where eBPF starts cleanly but
  silently captures nothing.
- Accent color presets for the dashboard — switch between a few curated
  colors (default: rust, matching the PodoType brand) from Settings.
  Choice is remembered per-browser.
- TLS certificate expiry alerting — a watched service whose health check is
  set to "HTTP" against an https:// URL now gets its certificate's expiry
  checked periodically, feeding the existing alert channels and per-service
  overrides. Defaults to warning at 14 days and critical at 3 days left.
- Poll intervals settings (under Settings) — every background poll/eval
  cadence (health checks, CPU/memory, alert evaluation, TLS recheck, etc.)
  is now editable from the UI and takes effect immediately, no more editing
  an env var and restarting the container.

### Changed
- The sidebar's brand mark now always renders in PodoType's rust brand
  color, independent of whichever accent preset is currently selected
  (the accent preset still defaults to that same rust, but can be
  switched; the logo no longer follows it).
- The Code Tracing setup panel's apply/cleanup commands are now their
  own always-visible one-line copy boxes, instead of being buried inside
  a long prose block or scrolled out of the generated YAML's textarea.
- Setting a service's manual health check is now a proper dialog with
  radio buttons for "HTTP" vs "TCP" instead of two sequential browser
  prompts — the old free-text prompt rejected "https" as a type (the
  type is the check mechanism, not the target's protocol; an https://
  target still uses the "http" check type) with a confusing
  "Type must be \"http\" or \"tcp\"" alert. Error messages app-wide (this
  dialog's validation included) now show as an in-page banner pinned to
  the top of the window instead of a native browser alert.
- Alert notification text (Telegram, webhook, email) now leads with a
  clear "PodoType Alert (Critical/Warning)" or "PodoType — Resolved"
  title and a severity icon, instead of a single run-on
  "podotype alert: ..." line.
- The Profiling nav item is temporarily hidden (the feature itself is
  unverified end-to-end) until it's ready to turn back on.
- The build-and-push CI workflow now also runs on pull requests targeting
  master, so a check actually shows up on the PR itself (build-only, no
  image push) instead of only running after the fact on the merge
  commit to master.

### Fixed
- Saved email alert channel settings (SMTP host/user/password/recipient)
  were being silently dropped on every state reload — email alerts would
  look saved right after clicking Save, then stop working moments later.
- A watched service's latency chart crashed the whole engine process
  (`latencyHistory is not defined`) the moment anyone opened it — the
  variable was referenced but never declared.
