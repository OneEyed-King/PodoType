import { useEffect, useRef, useState } from 'react';
import { api, DEPLOY_MODE } from './api.js';
import { hostedApi } from './datasource/hostedApi.js';
import TopBar from './components/TopBar.jsx';
import Sidebar from './components/Sidebar.jsx';
import WatchedRow from './components/WatchedRow.jsx';
import ServiceDetailPage from './components/ServiceDetailPage.jsx';
import SelectServices from './components/SelectServices.jsx';
import AttentionBanner from './components/AttentionBanner.jsx';
import AlertsPanel from './components/AlertsPanel.jsx';
import RetentionPanel from './components/RetentionPanel.jsx';
import LogRetentionPanel from './components/LogRetentionPanel.jsx';
import OtelInstructions from './components/OtelInstructions.jsx';
import BulkOtelSetup from './components/BulkOtelSetup.jsx';
import ServiceMap from './components/ServiceMap.jsx';
// BillingPanel removed for self-hosted — there is no billing/SaaS-tier concept here (see server.js). It stays only in the hosted repo's copy of this file.
import HostedAlertsPanel from './components/HostedAlertsPanel.jsx';
import QueryConsole from './components/QueryConsole.jsx';
import HostStatsPanel from './components/HostStatsPanel.jsx';
import StatusSummaryStrip from './components/StatusSummaryStrip.jsx';
import UsageStats from './components/UsageStats.jsx';
import IncidentPanel from './components/IncidentPanel.jsx';
import OverviewSummary from './components/OverviewSummary.jsx';
import RootCauseSummary from './components/RootCauseSummary.jsx';
import PreflightBanner from './components/PreflightBanner.jsx';
import OnboardingTour, { hasSeenOnboarding } from './components/OnboardingTour.jsx';
import FleetGoldenSignals from './components/charts/FleetGoldenSignals.jsx';
import CompareServices from './components/CompareServices.jsx';
import ProfilingPanel from './components/ProfilingPanel.jsx';
import IncidentDetail from './components/IncidentDetail.jsx';
import OverviewExportButton from './components/OverviewExportButton.jsx';
import TimeRangePicker, { formatRangeMinutes } from './components/TimeRangePicker.jsx';
import JumpBox from './components/JumpBox.jsx';

const POLL_MS = 5000;

// Services page — "which service is slowest" (Reddit feedback: the fleet
// view told you something was slow but never which watched service to
// look at first). Finds the highest trace p95 among services that have
// real trace data; needs at least two such services, otherwise "slowest"
// is meaningless (nothing to be slower than).
function findSlowestServiceName(list) {
  let slowestName = null;
  let slowestMs = -Infinity;
  let candidates = 0;
  for (const svc of list) {
    const ms = svc.trace && typeof svc.trace.p95Ms === 'number' ? svc.trace.p95Ms : null;
    if (ms === null) continue;
    candidates += 1;
    if (ms > slowestMs) {
      slowestMs = ms;
      slowestName = svc.name;
    }
  }
  return candidates > 1 ? slowestName : null;
}

// This file is now the ONE top-level component for both builds — no more
// separate HostedApp.jsx mirroring these classes. `HOSTED` gates every
// piece of self-hosted behavior that has no meaning for a hosted account
// (Docker container discovery/watch-unwatch, OTEL compose generation,
// per-instance billing, log tailing — see hostedApi.js's header for the
// exact list of engineApi methods with no hosted equivalent, and why: a
// hosted account has no Docker host to control). Every branch below that
// checks HOSTED is new; nothing that already ran for self-hosted changed
// shape or moved, so a self-hosted build (HOSTED === false, the default)
// behaves byte-for-byte like it did before this file also had to serve
// hosted accounts.
const HOSTED = DEPLOY_MODE === 'hosted';

// --- Navigation shell -------------------------------------------------------
// The monitor view used to be one long stack: a toolbar of toggle buttons
// (Service map / Query / Alerts were all "open this panel inline, on top of
// the watched-service list") followed by every panel that happened to be
// open, all fighting for the same vertical space. `section` below replaces
// that with real navigation (see Sidebar.jsx) — one section renders in the
// main area at a time, picked from a persistent left nav instead of a row
// of toggle buttons that accumulate open panels the longer you use it.
// Shared by both builds (only one branch below ever runs per build, so one
// piece of state is enough) and defaults to the same landing section either
// way.
const SECTIONS = ['overview', 'services', 'map', 'traces', 'tracing-setup', 'alerts', 'settings', 'compare', 'profiling'];

export default function App() {
  const [services, setServices] = useState([]);
  const [statusServices, setStatusServices] = useState([]);
  const [thresholds, setThresholds] = useState(null);
  const [storage, setStorage] = useState(null);
  const [otelLanguages, setOtelLanguages] = useState(['java']);
  const [updatedText, setUpdatedText] = useState('');
  const [manualAddValue, setManualAddValue] = useState('');

  // Two-step flow: pick services, then land on a page that only shows what
  // you picked. "monitor" is the steady-state home once anything is
  // watched; "select" is the picker, reachable any time via "Add more
  // services". hasInitializedView makes sure we only auto-pick the
  // starting page once (on first load), never yank the person back to
  // "select" mid-session just because everything got briefly un-watched.
  const [view, setView] = useState('select');
  const hasInitializedView = useRef(false);

  const [expandedRows, setExpandedRows] = useState(() => new Set());
  // name -> Set('metrics') — Traces (see TracesPanel) no longer has its own
  // collapse state: it shows its live data (if any) the moment the row
  // itself is expanded, no second click to open it.
  // Per-service ACTIVE TAB inside its expanded row (backlog item #16 —
  // horizontal tabs replacing the old vertical stack of Traces/Health/
  // Alerts/SLO/Dependencies/Logs panels, Coroot-style, instead of
  // scrolling past everything to find one section). Map<serviceName,
  // tabId>, same lift-state-up pattern the old expandedPanels Set used —
  // collapsing and re-expanding a row remembers which tab you were on,
  // same as before. Absent entry (a service never opened) means
  // WatchedRow falls back to its own default tab.
  const [activeServiceTab, setActiveServiceTab] = useState(() => new Map());
  // One shared tracing setup file for the whole stack, not one per
  // service — so this is a single piece of state, not a per-name map.
  // null = panel hidden; set = panel open with whatever was last fetched.
  const [otelCompose, setOtelCompose] = useState(null);
  // Which section of the monitor view is showing — see the SECTIONS/
  // Sidebar comment above. Replaces the old serviceMapOpen/queryConsoleOpen
  // toggle booleans entirely: "open the service map" is now "navigate to
  // the map section", not "turn on a panel that stacks under the list".
  const [section, setSection] = useState('overview');
  // First-run onboarding tour (OnboardingTour.jsx) — shown once per
  // browser (localStorage, same best-effort pattern Sidebar/ThemeToggle
  // already use), replayable any time from TopBar's "Take the tour"
  // button. Lazy-init off hasSeenOnboarding() so a returning visitor's
  // first paint never flashes the tour on before this check runs.
  const [showTour, setShowTour] = useState(() => !hasSeenOnboarding());
  // Backlog item #11 — the incident detail "page" (still no router —
  // same section-swap pattern every other page already uses). Set by
  // IncidentPanel's onSelectIncident when a row is clicked; App.jsx just
  // remembers which incident and flips `section` to show it.
  const [selectedIncident, setSelectedIncident] = useState(null);
  // Which service's dedicated detail page (see ServiceDetailPage.jsx) is
  // open, if any — { name, hosted }. Looked back up by name from
  // watchedServices/statusServices on every render rather than storing
  // the svc object itself, so the page stays live off the normal poll
  // instead of freezing at whatever the service looked like the moment
  // it was opened.
  const [detailService, setDetailService] = useState(null);
  function openServiceDetail(name, hosted) {
    setDetailService({ name, hosted });
    setSection('serviceDetail');
  }
  function openIncident(incident) {
    setSelectedIncident(incident);
    setSection('incidentDetail');
  }
  // Overview's time-range filter (IncidentPanel/OverviewSummary) and
  // Services' search box — both plain UI state shared across the hosted/
  // self-hosted branches below, same "one var, only one branch renders"
  // pattern `section` itself uses.
  const [overviewRangeMinutes, setOverviewRangeMinutes] = useState(60);
  const [servicesQuery, setServicesQuery] = useState('');
  // Self-hosted only (see the toggle button's own placement below) — the
  // ad-hoc SQL console, gated behind the SAME engine key every other API
  // call already needs. Not offered on the hosted build: that one talks to
  // license-server's per-tenant routes, never a shared multi-tenant
  // ClickHouse directly, so there's no single safe "your own data" query
  // surface to expose there the way there is for one self-hosted engine.
  // (Still used by both builds today — see the Traces section below.)
  // Ctrl/Cmd+K "go to..." box (see JumpBox.jsx and the keydown listener
  // below) — global, not gated to either build, since both have a
  // watched-service list (and now a full section nav) worth jumping around
  // in.
  const [jumpBoxOpen, setJumpBoxOpen] = useState(false);
  // Declared unconditionally, ABOVE the `if (HOSTED)` branch below (and
  // everything else that returns early per-view) on purpose — this is a
  // hook, and HOSTED-gated JSX further down returns different trees on
  // different renders (select vs monitor view, auth-checking, etc.), so a
  // hook can't live inside any of those branches without breaking React's
  // "same hooks, same order, every render" rule. It only ever toggles
  // jumpBoxOpen, so it doesn't need per-build service data — jumpItems
  // (which does) is computed separately inside each branch's own render,
  // as a plain value, not a hook.
  useEffect(() => {
    function onKeyDown(e) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setJumpBoxOpen((v) => !v);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  // name -> { guess, supported, reason, note, lowConfidence } — refetched
  // every time the Code Tracing page becomes active (see the effect right
  // below), never auto-applied, only used to pre-fill each row's language
  // dropdown there.
  const [otelLanguageGuesses, setOtelLanguageGuesses] = useState(new Map());
  // Code Tracing's own dedicated page (section === 'tracing-setup', see
  // Sidebar.jsx) needs a fresh guess map every time someone navigates to
  // it — which containers are running, and thus what's guessable, can
  // change between visits — same trigger the old toggle-panel's onClick
  // used to cover before this moved to a real nav section.
  useEffect(() => {
    if (section === 'tracing-setup') refreshOtelLanguageGuesses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);
  const manualAddInputRef = useRef(null);

  // --- Hosted-only state/effects. Self-hosted's own state above is
  // untouched; these are additive, and every effect below bails out
  // immediately when !HOSTED so none of it runs on the self-hosted build. ---
  const [hostedRetentionDays, setHostedRetentionDays] = useState(null);
  const [hostedError, setHostedError] = useState(null);
  const [hostedExpandedRows, setHostedExpandedRows] = useState(() => new Set());
  // name -> Set('metrics') — same per-row sub-panel expand state as
  // self-hosted's own expandedPanels above (WatchedRow is the same
  // component; this is its hosted-side copy of that state, not a new
  // concept).
  const [hostedActiveServiceTab, setHostedActiveServiceTab] = useState(() => new Map());
  // Self-hosted has no login of its own (it's a single local engine, not a
  // multi-tenant account) — this only matters, and only runs, for hosted.
  const [authChecked, setAuthChecked] = useState(!HOSTED);
  // Captured off the same /v1/auth/me call that already gates the page —
  // no extra request. Only ever populated on the hosted build; self-hosted
  // has no login so Sidebar's logout ribbon simply never renders there.
  const [userEmail, setUserEmail] = useState(null);

  useEffect(() => {
    if (!HOSTED) return;
    fetch('/v1/auth/me', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) {
          window.location.href = '/login.html';
          return null;
        }
        return res.json();
      })
      .then((body) => {
        if (!body) return;
        setUserEmail(body.email || null);
        setAuthChecked(true);
      })
      .catch(() => {
        window.location.href = '/login.html';
      });
  }, []);

  function handleLogout() {
    hostedApi
      .logout()
      .catch(() => {})
      .then(() => {
        window.location.href = '/login.html';
      });
  }

  // Only retentionDays is actually read from this response now — svc.trace/
  // svc.red used to come from here too (this file's own hostedServices()
  // landing-list call), joined client-side against watched containers by
  // name; that join is what silently hid all trace data (the naive
  // containerName === serviceName match). Both are now resolved server-side
  // straight into GET /discovery's own response (see routes/dashboard.js),
  // so WatchedRow/TracesPanel read svc.trace/svc.red directly, same as they
  // do for self-hosted — this call is kept only for the retention banner.
  function hostedRefresh() {
    setHostedError(null);
    hostedApi
      .hostedServices()
      .then((body) => setHostedRetentionDays(body.retentionDays))
      .catch((err) => setHostedError(err.message));
  }

  useEffect(() => {
    if (!HOSTED || !authChecked) return undefined;
    hostedRefresh();
    const id = setInterval(hostedRefresh, POLL_MS);
    return () => clearInterval(id);
  }, [authChecked]);

  function toggleHostedRow(name) {
    setHostedExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectHostedTab(name, tabId) {
    setHostedActiveServiceTab((prev) => {
      const next = new Map(prev);
      next.set(name, tabId);
      return next;
    });
  }

  async function hostedToggleMetrics(name, enabled) {
    await hostedApi.setMetrics(name, enabled);
    await hostedDiscoveryRefresh();
  }

  async function hostedStopWatching(name) {
    setHostedExpandedRows((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    await hostedApi.toggle(name);
    await hostedDiscoveryRefresh();
  }

  // Discovery + watch selection — the real "select services" step you
  // asked for, backed by the agent's own Docker access (see
  // hostedApi.services' own comment). Mirrors self-hosted's `services`/
  // `view`/`hasInitializedView` state above one-for-one, just hosted's own
  // copy since the two builds' data never overlaps.
  const [hostedDiscovery, setHostedDiscovery] = useState(null); // {services, watchedCount, tier, maxWatchedServices}
  const [hostedDiscoveryError, setHostedDiscoveryError] = useState(null);
  const [hostedView, setHostedView] = useState('select');
  const hostedHasInitializedView = useRef(false);
  const [hostedManualAddValue, setHostedManualAddValue] = useState('');
  const hostedManualAddInputRef = useRef(null);
  const [hostedToggleError, setHostedToggleError] = useState(null);

  function hostedDiscoveryRefresh() {
    setHostedDiscoveryError(null);
    return hostedApi
      .services()
      .then((body) => {
        setHostedDiscovery(body);
        if (Array.isArray(body.otelLanguages) && body.otelLanguages.length > 0) setOtelLanguages(body.otelLanguages);
        if (!hostedHasInitializedView.current) {
          hostedHasInitializedView.current = true;
          setHostedView(body.watchedCount > 0 ? 'monitor' : 'select');
        }
      })
      .catch((err) => setHostedDiscoveryError(err.message));
  }

  useEffect(() => {
    if (!HOSTED || !authChecked) return undefined;
    hostedDiscoveryRefresh();
    const id = setInterval(hostedDiscoveryRefresh, POLL_MS);
    return () => clearInterval(id);
  }, [authChecked]);

  async function hostedToggleService(name) {
    setHostedToggleError(null);
    try {
      await hostedApi.toggle(name);
      await hostedDiscoveryRefresh();
    } catch (err) {
      // The free-tier cap rejection (402) lands here — surfaced inline
      // rather than a window.alert, since DiscoveredTable's checkbox is
      // clicked one at a time and a blocking alert for a routine "you're
      // at the cap" case is more friction than the message deserves.
      setHostedToggleError(err.message);
    }
  }

  async function hostedManualAdd() {
    const name = hostedManualAddValue.trim();
    if (!name) return;
    setHostedManualAddValue('');
    await hostedToggleService(name);
  }
  // --- end hosted-only state/effects ---

  async function refresh() {
    try {
      const [{ services: svcList, otelLanguages: langs }, status] = await Promise.all([api.services(), api.status()]);
      if (Array.isArray(langs) && langs.length > 0) setOtelLanguages(langs);
      setServices(svcList);
      setStatusServices(status.services);
      setThresholds(status.thresholds);
      setStorage(status.storage || null);

      if (!hasInitializedView.current) {
        hasInitializedView.current = true;
        setView(status.services.length > 0 ? 'monitor' : 'select');
      }

      let text = `Updated ${new Date(status.generatedAt).toLocaleTimeString()} — stale after ${status.thresholds.staleAfterSeconds}s, slow above ${status.thresholds.slowThresholdMs}ms`;
      if (status.containersError) text += ` — Docker error: ${status.containersError}`;
      setUpdatedText(text);
    } catch (err) {
      setUpdatedText(`Error refreshing: ${err.message}`);
    }
  }

  useEffect(() => {
    if (HOSTED) return undefined;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    // Chrome (and, less aggressively, Firefox) clamps setInterval timers in
    // a backgrounded tab — confirmed directly on this project: with the tab
    // hidden (document.hidden === true, e.g. switched to another window),
    // this poll can silently stop firing at its normal 5s cadence while
    // everything ELSE keeps working (an EventSource's push-driven onmessage
    // isn't throttled the same way, which is why LogsPanel's live tail kept
    // updating in the same tab when this didn't). The fix isn't to fight
    // the throttling — it's to refetch immediately the moment the tab
    // becomes visible again, so coming back to the tab always shows current
    // data right away instead of waiting for a throttled timer or looking
    // permanently stale until a manual reload. Grafana's own dashboards use
    // the same pattern for auto-refresh.
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const configByName = new Map(services.map((s) => [s.name, s]));

  // The free-tier watched-services cap (see server.js's own
  // FREE_TIER_MAX_WATCHED_SERVICES) is a hard block server-side — a 403
  // with a friendly "upgrade, or un-watch another service first" message.
  // Neither toggleService nor manualAdd used to catch that rejection, so
  // clicking the checkbox on an 11th service just failed silently: no
  // error, no explanation, the checkbox simply didn't stay checked. A
  // hard block that gives no feedback reads as a bug, not a paywall —
  // toggleError surfaces the backend's own message (see its render site
  // in the 'select' view below) so hitting the cap is legible instead of
  // silent.
  const [toggleError, setToggleError] = useState(null);

  // fetchJSON's thrown Error is `${url} -> ${detail}` (see engineApi.js) —
  // strip the URL prefix so what's shown is just the human-readable part
  // the backend actually wrote for a person to read.
  function friendlyErrorMessage(err) {
    const msg = err && err.message ? err.message : String(err);
    const idx = msg.indexOf(' -> ');
    return idx === -1 ? msg : msg.slice(idx + 4);
  }

  async function toggleService(name) {
    setToggleError(null);
    try {
      await api.toggle(name);
    } catch (err) {
      setToggleError(friendlyErrorMessage(err));
      return;
    }
    await refresh();
  }

  async function manualAdd() {
    const name = manualAddValue.trim();
    if (!name) return;
    setToggleError(null);
    try {
      await api.toggle(name);
    } catch (err) {
      setToggleError(friendlyErrorMessage(err));
      return;
    }
    setManualAddValue('');
    await refresh();
  }

  async function stopWatching(name) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    await toggleService(name);
    // Stopping watching a traced service changes what the shared setup
    // file should contain — if it's open right now, keep it honest rather
    // than leaving a just-removed service sitting in a stale, already-open
    // view. (The file itself always drops stale entries on a fresh fetch —
    // that's the whole point of this design — but there's no reason to
    // leave an already-open panel showing the old snapshot in the
    // meantime.)
    if (otelCompose) await refreshOtelComposeIfOpen();
  }

  // refreshFn defaults to self-hosted's own refresh() (its own call site
  // below never passes a second arg, so its behavior is unchanged) — the
  // rest of this is genuinely build-agnostic (a plain window.prompt flow
  // over api.setCheck, which api.js's own DEPLOY_MODE switch already
  // resolves to hostedApi.setCheck for the hosted build), so hosted reuses
  // this exact function rather than writing its own copy, passing
  // hostedDiscoveryRefresh as the one thing that has to differ.
  async function setupCheck(name, existing, refreshFn = refresh) {
    const type = window.prompt(
      `Health check type for "${name}" — type "http" or "tcp"\n(http: checks a URL; tcp: just checks the port accepts a connection)\n\nOnly needed if this service has no Docker HEALTHCHECK of its own — otherwise podotype already reads that for free.`,
      (existing && existing.type) || 'http'
    );
    if (type === null) return;
    const normalizedType = type.trim().toLowerCase();
    if (normalizedType !== 'http' && normalizedType !== 'tcp') {
      window.alert('Type must be "http" or "tcp".');
      return;
    }
    const targetPrompt =
      normalizedType === 'http'
        ? `Health check URL for "${name}" (e.g. http://host:8080/health)`
        : `Host:port to check for "${name}" (e.g. host:5432)`;
    const target = window.prompt(targetPrompt, (existing && existing.target) || '');
    if (target === null) return;
    if (!target.trim()) {
      window.alert('Target cannot be empty — use "Remove check" instead to clear it.');
      return;
    }
    await api.setCheck(name, { type: normalizedType, target: target.trim() });
    await refreshFn();
  }

  async function removeCheck(name, refreshFn = refresh) {
    await api.setCheck(name, { target: '' });
    await refreshFn();
  }

  async function toggleMetrics(name, enabled) {
    await api.setMetrics(name, enabled);
    await refresh();
  }

  // Code Tracing setup/disable used to be a per-service action here
  // (window.prompt for a language, window.confirm before enabling) —
  // removed in favor of ONE dedicated "Code Tracing" page (see Sidebar.jsx
  // and the `section === 'tracing-setup'` render block below) where every
  // watched service is checked/unchecked with a real <select> for its
  // language, not a native browser dialog. applyBulkOtel below is what
  // that page actually calls; per-service enable/disable both go through
  // it now (checking one box and hitting Generate is the single-service
  // case, same code path as bulk).

  // One shared panel for the whole stack, not one per service — opening it
  // from ANY service's "instructions" link, or from the top-level "view
  // setup file" link, shows the exact same file, since there's only one.
  // User-triggered, so a failure (e.g. Docker unreachable) surfaces as an
  // alert.
  async function showOtelInstructions() {
    try {
      const compose = await api.otelCompose();
      setOtelCompose(compose);
    } catch (err) {
      window.alert(err.message);
    }
  }

  // Background refresh of an already-open panel (after disabling/unwatching
  // something) — not user-triggered, so it fails quietly. The most common
  // failure here is "no services traced anymore" (the last one was just
  // turned off), which just means the panel should close, not pop an alert.
  async function refreshOtelComposeIfOpen() {
    try {
      const compose = await api.otelCompose();
      setOtelCompose(compose);
    } catch {
      setOtelCompose(null);
    }
  }

  // Fetches a language guess for every watched service in one round trip —
  // called whenever the Code Tracing page becomes active (see the
  // useEffect below), fresh every time rather than cached, since which
  // containers are running (and thus what's guessable) can change between
  // visits. Best-effort: hosted doesn't implement this endpoint at all
  // (see hostedApi.js's own comment on why) and self-hosted's own call can
  // still fail — either way this just leaves the guess map empty, which
  // BulkOtelSetup already handles the same as it always has.
  async function refreshOtelLanguageGuesses() {
    try {
      const { guesses } = await api.guessOtelLanguages();
      setOtelLanguageGuesses(new Map(Object.entries(guesses)));
    } catch {
      setOtelLanguageGuesses(new Map());
    }
  }

  // selection: Map<serviceName, language> from BulkOtelSetup — a checked
  // service with a language picked. Diffed against each service's current
  // otel state so this only issues a call for services that actually
  // change: turn on/switch language for anything selected, turn off
  // anything that was on but got unchecked, leave everything else alone.
  // Ends by opening the shared setup file, same as enabling tracing on a
  // single service does — bulk setup exists specifically to get that file
  // in one pass instead of clicking through each service individually.
  async function applyBulkOtel(selection) {
    // Self-hosted's own `services` state and hosted's `hostedDiscovery.services`
    // are the same shape (each entry carries its own `watched`/`otel`
    // fields) — see hostedApi's discovery mapping — so one function
    // genuinely covers both builds now that this page is shared between
    // them, not just self-hosted's old toggle panel.
    const roster = HOSTED ? (hostedDiscovery ? hostedDiscovery.services : []) : services;
    const changes = roster
      .filter((s) => s.watched)
      .map((s) => {
        const wantLanguage = selection.get(s.name);
        const currentlyEnabled = Boolean(s.otel && s.otel.enabled);
        if (wantLanguage) {
          if (!currentlyEnabled || s.otel.language !== wantLanguage) {
            return api.setOtel(s.name, { enabled: true, language: wantLanguage });
          }
        } else if (currentlyEnabled) {
          return api.setOtel(s.name, { enabled: false });
        }
        return null;
      })
      .filter(Boolean);

    if (changes.length > 0) await Promise.all(changes);
    await refresh();
    // Only open the shared file if the bulk edit actually left something
    // traced — e.g. someone could open this page and uncheck everything,
    // which is a valid way to turn tracing off for all of them at once,
    // and there's no file to show at that point. Stays on this same page
    // either way — no panel to close anymore, this IS the page.
    if (selection.size > 0) await showOtelInstructions();
  }

  // Just hides the panel — tracing itself stays enabled for whichever
  // services already have it on. Any "instructions"/"view setup file" link
  // re-fetches and reopens it, so this is a real close, not a dead end.
  function hideOtelInstructions() {
    setOtelCompose(null);
  }

  function toggleRowExpanded(name) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectTab(name, tabId) {
    setActiveServiceTab((prev) => {
      const next = new Map(prev);
      next.set(name, tabId);
      return next;
    });
  }

  // Hosted's entire return — self-hosted's license-expiry/watchedCount/
  // main render below never runs for hosted, and this never runs for
  // self-hosted (HOSTED is a build-time constant from DEPLOY_MODE).
  if (HOSTED) {
    if (!authChecked) {
      return (
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-[14px] text-muted">Checking your session…</div>
        </div>
      );
    }
    // Step 1: select which discovered containers to watch — the real
    // thing now (agent-shipped Docker discovery, see hostedApi.services'
    // own comment), reusing SelectServices/DiscoveredTable completely
    // unmodified since the {name, image, watched} shape matches self-
    // hosted's exactly.
    if (hostedView === 'select') {
      const hd = hostedDiscovery;
      return (
        <div className="min-h-screen">
          <TopBar mode="hosted" serviceCount={hd ? hd.services.filter((s) => s.watched).length : 0} retentionDays={hostedRetentionDays} />
          {hostedDiscoveryError && (
            <p className="text-muted text-[15px] px-6 pt-4">
              Couldn't load discovered containers — try refreshing. <span className="text-down">({hostedDiscoveryError})</span>
            </p>
          )}
          {hd && hd.tier === 'free' && (
            <div className="mx-6 mt-4 border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-ink-dim">
              <span className="font-bold uppercase tracking-wider text-[12px] text-ink-dim bg-panel-raised rounded px-2 py-0.5 mr-2">
                Free tier
              </span>
              Capped at {hd.maxWatchedServices} watched services ({hd.watchedCount}/{hd.maxWatchedServices} used).
            </div>
          )}
          {hostedToggleError && <p className="text-down text-[14px] px-6 pt-2">{hostedToggleError}</p>}
          {!hd && !hostedDiscoveryError && <p className="text-muted text-[15px] px-6 pt-4">Loading…</p>}
          {hd && (
            <SelectServices
              services={hd.services}
              watchedCount={hd.watchedCount}
              onToggle={hostedToggleService}
              manualAddValue={hostedManualAddValue}
              onManualAddChange={setHostedManualAddValue}
              onManualAdd={hostedManualAdd}
              manualAddInputRef={hostedManualAddInputRef}
              onStartTracking={() => setHostedView('monitor')}
            />
          )}
        </div>
      );
    }

    // Step 2: the monitor view — same shape as self-hosted's, filtered to
    // only WATCHED names (matches self-hosted's own "only watched services
    // appear here" behavior). Trace/log data keeps flowing for every
    // container regardless — see routes/dashboard.js's POST .../watch
    // comment — this filter is display-only. svc.trace/svc.red are now
    // resolved server-side (GET /discovery — see routes/dashboard.js's own
    // comment there), so there's no client-side join to do here anymore,
    // same as self-hosted never needed one.
    const watchedServices = hostedDiscovery ? hostedDiscovery.services.filter((s) => s.watched) : [];

    function jumpToService(name) {
      openServiceDetail(name, true);
      setJumpBoxOpen(false);
    }
    const jumpItems = [
      ...watchedServices.map((s) => ({ id: `svc:${s.name}`, label: s.name, kind: 'service', name: s.name })),
      { id: 'action:overview', label: 'Go to Overview', kind: 'section', target: 'overview' },
      { id: 'action:services', label: 'Go to Services', kind: 'section', target: 'services' },
      { id: 'action:map', label: 'Go to Service map', kind: 'section', target: 'map' },
      { id: 'action:traces', label: 'Go to Traces', kind: 'section', target: 'traces' },
      { id: 'action:tracing-setup', label: 'Go to Code Tracing', kind: 'section', target: 'tracing-setup' },
      { id: 'action:alerts', label: 'Go to Alerts', kind: 'section', target: 'alerts' },
      { id: 'action:settings', label: 'Go to Settings', kind: 'section', target: 'settings' },
      { id: 'action:add-services', label: 'Add more services', kind: 'view' },
    ];
    function handleJumpSelect(item) {
      if (item.kind === 'service') return jumpToService(item.name);
      if (item.kind === 'section') {
        setSection(item.target);
        setJumpBoxOpen(false);
        return;
      }
      if (item.id === 'action:add-services') {
        setHostedView('select');
        setJumpBoxOpen(false);
      }
    }

    return (
      <div className="min-h-screen flex flex-col">
        <TopBar
          mode="hosted"
          serviceCount={watchedServices.length}
          retentionDays={hostedRetentionDays}
          onJump={() => setJumpBoxOpen(true)}
          onReplayTour={() => setShowTour(true)}
        />
        {jumpBoxOpen && <JumpBox items={jumpItems} onSelect={handleJumpSelect} onClose={() => setJumpBoxOpen(false)} />}

        <div className="flex flex-1 min-h-0">
          <Sidebar active={section} onSelect={setSection} serviceCount={watchedServices.length} mode="hosted" userEmail={userEmail} onLogout={handleLogout} />
          {showTour && (
            <OnboardingTour onNavigate={setSection} onFinish={() => setShowTour(false)} hosted />
          )}

          <main className="flex-1 px-6 pb-10 pt-4 min-w-0">
            {hostedDiscovery && hostedDiscovery.tier === 'free' && (
              <div className="mb-5 border border-border rounded-lg px-3.5 py-2.5 flex items-center justify-between gap-3 flex-wrap text-[13px] text-ink-dim">
                <span>
                  <span className="font-bold uppercase tracking-wider text-[12px] text-ink-dim bg-panel-raised rounded px-2 py-0.5 mr-2">
                    Free tier
                  </span>
                  Capped at {hostedDiscovery.maxWatchedServices} watched services ({hostedDiscovery.watchedCount}/
                  {hostedDiscovery.maxWatchedServices} used).
                </span>
              </div>
            )}

            {(hostedError || hostedDiscoveryError) && (
              <p className="text-muted text-[15px] mb-4">
                Couldn't load your services — try refreshing.{' '}
                <span className="text-down">({hostedError || hostedDiscoveryError})</span>
              </p>
            )}

            {section === 'overview' && (
              <>
                <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
                  <h1 className="text-[20px] font-bold m-0">
                    <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">01 /</span>
                    Overview
                  </h1>
                  <div className="flex items-center gap-2">
                    <TimeRangePicker minutes={overviewRangeMinutes} onChange={setOverviewRangeMinutes} allowLive={false} />
                    <OverviewExportButton
                      services={watchedServices}
                      rangeMinutes={overviewRangeMinutes}
                      rangeLabel={formatRangeMinutes(overviewRangeMinutes)}
                    />
                  </div>
                </div>
                <FleetGoldenSignals services={watchedServices} />
                <div data-tour="overview-summary">
                  <OverviewSummary
                    services={watchedServices}
                    rangeMinutes={overviewRangeMinutes}
                    rangeLabel={formatRangeMinutes(overviewRangeMinutes)}
                  />
                </div>
                <RootCauseSummary onSelectService={(name) => openServiceDetail(name, true)} />
                <IncidentPanel
                  rangeMinutes={overviewRangeMinutes}
                  rangeLabel={formatRangeMinutes(overviewRangeMinutes)}
                  onSelectIncident={openIncident}
                />
                <UsageStats rangeMinutes={overviewRangeMinutes} rangeLabel={formatRangeMinutes(overviewRangeMinutes)} />
                <StatusSummaryStrip services={watchedServices} />
                <HostStatsPanel rangeMinutes={overviewRangeMinutes} />
              </>
            )}

            {section === 'services' && (
              <>
                <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                  <h1 className="text-[20px] font-bold m-0">
                    <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">02 /</span>
                    Watched services
                  </h1>
                  <button
                    type="button"
                    onClick={() => setHostedView('select')}
                    className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3.5 py-1.5"
                  >
                    + Add more services
                  </button>
                </div>
                <div className="flex items-center gap-3 font-mono text-[12px] text-muted mb-3">
                  <span>auto-refresh · poll {Math.round(POLL_MS / 1000)}s</span>
                </div>

                {watchedServices.length > 5 && (
                  <input
                    type="text"
                    value={servicesQuery}
                    onChange={(e) => setServicesQuery(e.target.value)}
                    placeholder={`Search ${watchedServices.length} services…`}
                    className="w-full max-w-xs mb-4 text-[13px] bg-panel-raised border border-border rounded-md px-3 py-1.5 text-ink placeholder:text-muted focus:outline-none focus:border-accent"
                  />
                )}

                {hostedDiscovery === null && !hostedDiscoveryError && <p className="text-muted text-[15px]">Loading…</p>}

                {hostedDiscovery !== null && watchedServices.length === 0 && !hostedDiscoveryError && (
                  <p className="text-muted text-[15px]">Nothing watched yet — use "+ Add more services" above to pick some.</p>
                )}

                {(() => {
                  const q = servicesQuery.trim().toLowerCase();
                  const filteredHostedServices = q ? watchedServices.filter((s) => s.name.toLowerCase().includes(q)) : watchedServices;
                  if (watchedServices.length > 0 && filteredHostedServices.length === 0) {
                    return <p className="text-muted text-[15px]">No services match "{servicesQuery}".</p>;
                  }
                  const slowestName = findSlowestServiceName(watchedServices);
                  return (
                    filteredHostedServices.length > 0 && (
                      <div className="flex flex-col gap-2.5">
                        {filteredHostedServices.map((s) => (
                      <div key={s.name} id={`svc-row-${s.name}`}>
                        <WatchedRow
                          svc={s}
                          isSlowest={s.name === slowestName}
                          onStopWatching={() => hostedStopWatching(s.name)}
                          onOpenDetail={() => openServiceDetail(s.name, true)}
                        />
                      </div>
                    ))}
                      </div>
                    )
                  );
                })()}
              </>
            )}

            {section === 'map' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">03 /</span>
                  Service map
                </h1>
                <ServiceMap />
              </>
            )}

            {section === 'traces' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">04 /</span>
                  Traces
                </h1>
                <p className="text-[14px] text-ink-dim mb-4">
                  Per-service traces live on each service's own row under Services. Use this console for ad-hoc SQL
                  across everything you're watching.
                </p>
                <QueryConsole onClose={() => setSection('overview')} />
              </>
            )}

            {section === 'tracing-setup' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">05 /</span>
                  Code Tracing
                </h1>
                <p className="text-[14px] text-ink-dim mb-4">
                  Opt-in, per-service instrumentation on top of the always-on Beyla eBPF tracing — pick which watched
                  services to instrument and a language for each, then generate the setup file once for all of them.
                </p>
                <BulkOtelSetup
                  services={hostedDiscovery ? hostedDiscovery.services : []}
                  supportedOtelLanguages={otelLanguages}
                  languageGuesses={otelLanguageGuesses}
                  onApply={applyBulkOtel}
                  onClose={() => setSection('services')}
                />
                {otelCompose && (
                  <div className="mt-5">
                    <OtelInstructions compose={otelCompose} onClose={hideOtelInstructions} />
                  </div>
                )}
              </>
            )}

            {section === 'alerts' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">06 /</span>
                  Alerts
                </h1>
                <HostedAlertsPanel />
              </>
            )}

            {section === 'settings' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">07 /</span>
                  Settings
                </h1>
                <RetentionPanel storage={null} label="Data retention (spans, logs & metrics)" editorLabel="Configure data retention" />
              </>
            )}

            {section === 'compare' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">08 /</span>
                  Compare
                </h1>
                <CompareServices services={watchedServices} />
              </>
            )}

            {section === 'profiling' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">09 /</span>
                  Profiling
                </h1>
                <ProfilingPanel />
              </>
            )}

            {section === 'incidentDetail' && (
              <IncidentDetail incident={selectedIncident} onBack={() => setSection('overview')} />
            )}

            {section === 'serviceDetail' && detailService && (
              <ServiceDetailPage
                svc={watchedServices.find((s) => s.name === detailService.name) || null}
                cfg={{ metrics: { enabled: (watchedServices.find((s) => s.name === detailService.name) || {}).metricsEnabled } }}
                activeTab={hostedActiveServiceTab.get(detailService.name)}
                onSetupCheck={(existing) => setupCheck(detailService.name, existing, hostedDiscoveryRefresh)}
                onRemoveCheck={() => removeCheck(detailService.name, hostedDiscoveryRefresh)}
                onSelectTab={(tabId) => selectHostedTab(detailService.name, tabId)}
                storageStatus={null}
                supportsAlertOverrides={true}
                onBack={() => setSection('services')}
              />
            )}
          </main>
        </div>
      </div>
    );
  }

  const watchedCount = services.filter((s) => s.watched).length;
  // Drives the top-level "N services traced — view setup file" link — one
  // shared file for the whole stack, so this only needs a count, not a
  // per-service list here.
  const tracedCount = services.filter((s) => s.otel && s.otel.enabled).length;

  function jumpToService(name) {
    openServiceDetail(name, false);
    setJumpBoxOpen(false);
  }
  const jumpItems = [
    ...statusServices.map((svc) => ({ id: `svc:${svc.name}`, label: svc.name, kind: 'service', name: svc.name })),
    { id: 'action:overview', label: 'Go to Overview', kind: 'section', target: 'overview' },
    { id: 'action:services', label: 'Go to Services', kind: 'section', target: 'services' },
    { id: 'action:map', label: 'Go to Service map', kind: 'section', target: 'map' },
    { id: 'action:traces', label: 'Go to Traces', kind: 'section', target: 'traces' },
    { id: 'action:tracing-setup', label: 'Go to Code Tracing', kind: 'section', target: 'tracing-setup' },
    { id: 'action:alerts', label: 'Go to Alerts', kind: 'section', target: 'alerts' },
    { id: 'action:settings', label: 'Go to Settings', kind: 'section', target: 'settings' },
    { id: 'action:add-services', label: 'Add more services', kind: 'view' },
  ];
  function handleJumpSelect(item) {
    if (item.kind === 'service') return jumpToService(item.name);
    if (item.kind === 'section') {
      setSection(item.target);
      setJumpBoxOpen(false);
      return;
    }
    if (item.id === 'action:add-services') {
      setView('select');
      setJumpBoxOpen(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar
        watchedCount={watchedCount}
        discoveredCount={services.length}
        pollSeconds={Math.round(POLL_MS / 1000)}
        onAddService={() => {
          setView('select');
          setTimeout(() => manualAddInputRef.current?.focus(), 0);
        }}
        onJump={view === 'monitor' ? () => setJumpBoxOpen(true) : undefined}
        onReplayTour={view === 'monitor' ? () => setShowTour(true) : undefined}
      />

      {/* Same inline-text treatment hosted's own hostedToggleError uses
          (see its render site above) — a blocking alert() for "you're at
          the free-tier cap" is more friction than a routine limit
          deserves, so this just sits above the list until the next
          successful toggle clears it. */}
      {view === 'select' && toggleError && <p className="text-down text-[14px] px-6 pt-2">{toggleError}</p>}

      {view === 'select' && (
        <SelectServices
          services={services}
          watchedCount={watchedCount}
          onToggle={toggleService}
          manualAddValue={manualAddValue}
          onManualAddChange={setManualAddValue}
          onManualAdd={manualAdd}
          manualAddInputRef={manualAddInputRef}
          onStartTracking={() => setView('monitor')}
        />
      )}

      {view === 'monitor' && (
        <div className="flex flex-1 min-h-0">
          <Sidebar active={section} onSelect={setSection} serviceCount={watchedCount} mode="self-hosted" />
          {showTour && (
            <OnboardingTour onNavigate={setSection} onFinish={() => setShowTour(false)} hosted={false} />
          )}

          <main className="flex-1 px-6 pb-10 pt-4 min-w-0">
            {section === 'overview' && (
              <>
                <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
                  <h1 className="text-[20px] font-bold m-0">
                    <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">01 /</span>
                    Overview
                  </h1>
                  <div className="flex items-center gap-2">
                    <TimeRangePicker minutes={overviewRangeMinutes} onChange={setOverviewRangeMinutes} allowLive={false} />
                    <OverviewExportButton
                      services={statusServices}
                      rangeMinutes={overviewRangeMinutes}
                      rangeLabel={formatRangeMinutes(overviewRangeMinutes)}
                    />
                  </div>
                </div>
                <div data-tour="preflight-area">
                  <PreflightBanner />
                </div>
                <FleetGoldenSignals services={statusServices} />
                <div data-tour="overview-summary">
                  <OverviewSummary
                    services={statusServices}
                    rangeMinutes={overviewRangeMinutes}
                    rangeLabel={formatRangeMinutes(overviewRangeMinutes)}
                  />
                </div>
                <RootCauseSummary onSelectService={(name) => openServiceDetail(name, false)} />
                <IncidentPanel
                  rangeMinutes={overviewRangeMinutes}
                  rangeLabel={formatRangeMinutes(overviewRangeMinutes)}
                  onSelectIncident={openIncident}
                />
                <UsageStats rangeMinutes={overviewRangeMinutes} rangeLabel={formatRangeMinutes(overviewRangeMinutes)} />
                <StatusSummaryStrip services={statusServices} />
                {thresholds && (
                  <AttentionBanner statusServices={statusServices} slowThresholdMs={thresholds.slowThresholdMs} storage={storage} />
                )}
                <HostStatsPanel rangeMinutes={overviewRangeMinutes} />
              </>
            )}

            {section === 'services' && (
              <>
                <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                  <h1 className="text-[20px] font-bold m-0">
                    <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">02 /</span>
                    Watched services
                  </h1>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setView('select')}
                      className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3.5 py-1.5"
                    >
                      + Add more services
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-3 font-mono text-[12px] text-muted mb-5">
                  <span>auto-refresh · poll {Math.round(POLL_MS / 1000)}s</span>
                  {tracedCount > 0 && (
                    <>
                      <span>·</span>
                      <button type="button" className="link-btn text-accent" onClick={showOtelInstructions}>
                        🔗 {tracedCount} service{tracedCount === 1 ? '' : 's'} traced — view setup file
                      </button>
                    </>
                  )}
                </div>

                {statusServices.length > 5 && (
                  <input
                    type="text"
                    value={servicesQuery}
                    onChange={(e) => setServicesQuery(e.target.value)}
                    placeholder={`Search ${statusServices.length} services…`}
                    className="w-full max-w-xs mb-4 text-[13px] bg-panel-raised border border-border rounded-md px-3 py-1.5 text-ink placeholder:text-muted focus:outline-none focus:border-accent"
                  />
                )}

                {statusServices.length === 0 ? (
                  <p className="text-muted text-[15px]">
                    Nothing watched yet.{' '}
                    <button type="button" className="link-btn text-accent" onClick={() => setView('select')}>
                      Select services to track
                    </button>
                    .
                  </p>
                ) : (() => {
                  const q = servicesQuery.trim().toLowerCase();
                  const filteredStatusServices = q ? statusServices.filter((svc) => svc.name.toLowerCase().includes(q)) : statusServices;
                  if (filteredStatusServices.length === 0) {
                    return <p className="text-muted text-[15px]">No services match "{servicesQuery}".</p>;
                  }
                  const slowestName = findSlowestServiceName(statusServices);
                  return (
                    <div className="flex flex-col gap-2.5">
                      {filteredStatusServices.map((svc) => (
                        <div key={svc.name} id={`svc-row-${svc.name}`}>
                          <WatchedRow
                            svc={svc}
                            isSlowest={svc.name === slowestName}
                            onStopWatching={() => stopWatching(svc.name)}
                            onOpenDetail={() => openServiceDetail(svc.name, false)}
                          />
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </>
            )}

            {section === 'map' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">03 /</span>
                  Service map
                </h1>
                <ServiceMap />
              </>
            )}

            {section === 'traces' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">04 /</span>
                  Traces
                </h1>
                <p className="text-[14px] text-ink-dim mb-4">
                  Per-service traces live on each service's own row under Services. Use this console for ad-hoc SQL
                  across everything you're watching.
                </p>
                <QueryConsole onClose={() => setSection('overview')} />
              </>
            )}

            {section === 'tracing-setup' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">05 /</span>
                  Code Tracing
                </h1>
                <p className="text-[14px] text-ink-dim mb-4">
                  Opt-in, per-service instrumentation on top of the always-on Beyla eBPF tracing — pick which watched
                  services to instrument and a language for each, then generate the setup file once for all of them.
                </p>
                <BulkOtelSetup
                  services={services}
                  supportedOtelLanguages={otelLanguages}
                  languageGuesses={otelLanguageGuesses}
                  onApply={applyBulkOtel}
                  onClose={() => setSection('services')}
                />
                {otelCompose && (
                  <div className="mt-5">
                    <OtelInstructions compose={otelCompose} onClose={hideOtelInstructions} />
                  </div>
                )}
              </>
            )}

            {section === 'alerts' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">06 /</span>
                  Alerts
                </h1>
                <AlertsPanel />
              </>
            )}

            {section === 'settings' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">07 /</span>
                  Settings
                </h1>
                <RetentionPanel storage={storage} />
                <LogRetentionPanel />
              </>
            )}

            {section === 'compare' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">08 /</span>
                  Compare
                </h1>
                <CompareServices services={statusServices} />
              </>
            )}

            {section === 'profiling' && (
              <>
                <h1 className="text-[20px] font-bold mb-4">
                  <span className="text-muted font-mono text-[13px] font-normal align-middle mr-2">09 /</span>
                  Profiling
                </h1>
                <ProfilingPanel />
              </>
            )}

            {section === 'incidentDetail' && (
              <IncidentDetail incident={selectedIncident} onBack={() => setSection('overview')} />
            )}

            {section === 'serviceDetail' && detailService && (
              <ServiceDetailPage
                svc={statusServices.find((svc) => svc.name === detailService.name) || null}
                cfg={configByName.get(detailService.name) || {}}
                activeTab={activeServiceTab.get(detailService.name)}
                onSetupCheck={(existing) => setupCheck(detailService.name, existing)}
                onRemoveCheck={() => removeCheck(detailService.name)}
                onSelectTab={(tabId) => selectTab(detailService.name, tabId)}
                storageStatus={storage ? storage.status : null}
                onBack={() => setSection('services')}
              />
            )}
          </main>
        </div>
      )}

      {jumpBoxOpen && <JumpBox items={jumpItems} onSelect={handleJumpSelect} onClose={() => setJumpBoxOpen(false)} />}

      <footer className="px-6 pb-3 pt-2 font-mono text-[12px] text-muted">{updatedText}</footer>
    </div>
  );
}
