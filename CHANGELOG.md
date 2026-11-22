# Changelog

All notable changes to PodoType are logged here. For what the tool currently
does, see `README.md` — this file is for what's new.

## Unreleased

### Added
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
  main, so a check actually shows up on the PR itself (build-only, no
  image push) instead of only running after the fact on the merge
  commit to main.

### Fixed
- Saved email alert channel settings (SMTP host/user/password/recipient)
  were being silently dropped on every state reload — email alerts would
  look saved right after clicking Save, then stop working moments later.
- A watched service's latency chart crashed the whole engine process
  (`latencyHistory is not defined`) the moment anyone opened it — the
  variable was referenced but never declared.
