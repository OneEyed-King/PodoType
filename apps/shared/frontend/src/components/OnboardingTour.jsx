import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Guided first-run walkthrough — the gap spencer_cole12 on Reddit raised
// independently ("have you considered a guided walkthrough for first time
// users to highlight key features?") and Vishal had already flagged as a
// bucket-list item before that review came in. Built AFTER the preflight
// check (PreflightBanner) and the root-cause banner (RootCauseSummary)
// specifically so this tour has something real to point at for both —
// see this project's own reasoning for building in that order.
//
// No tour library (react-joyride etc.) — this is a small, fixed sequence
// over a handful of known, stable DOM anchors (sidebar nav buttons,
// data-tour-tagged wrapper divs), so a hand-rolled spotlight is simpler
// than pulling in a dependency for it. The spotlight itself is the
// standard CSS trick: a transparent box whose box-shadow is a huge solid
// color, which dims everything OUTSIDE that box without needing an SVG
// mask or a cutout layer.
const SEEN_KEY = 'podotype-onboarding-seen';
const SPOTLIGHT_PAD = 6;

export function hasSeenOnboarding() {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Best-effort only — a failed write just means the tour offers itself
    // again next visit, same fallback ThemeToggle/Sidebar already accept
    // for their own localStorage calls.
  }
}

// Each step optionally navigates first (`section`), then measures a DOM
// node identified by a CSS selector (`selector`). `selector: null` is a
// valid step — a plain centered card with no spotlight, used for the
// intro/outro. title/body are resolved via t() at render time (see
// buildSteps below) rather than stored here, so this stays a stable,
// translation-agnostic structure.
function buildStepDefs(hosted) {
  const steps = [
    { selector: null, i18nKey: 'intro' },
    { selector: '[data-tour="nav-services"]', i18nKey: 'services' },
    { section: 'overview', selector: '[data-tour="overview-summary"]', i18nKey: 'overview' },
    {
      section: 'overview',
      selector: '[data-tour="preflight-area"]',
      i18nKey: 'preflight',
      skipIf: hosted, // self-hosted only — see engineApi.js's own comment on why hostedApi has no /api/preflight yet
    },
    { selector: '[data-tour="nav-traces"]', i18nKey: 'traces' },
  ];
  return steps.filter((s) => !s.skipIf);
}

// section/onNavigate: App.jsx's own no-router `section` state — a step
// that names `section` calls onNavigate(section) on entry so the right
// page is showing before this tries to measure its target.
export default function OnboardingTour({ onNavigate, onFinish, hosted }) {
  const { t } = useTranslation();
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState(null);
  const stepDefs = buildStepDefs(hosted);
  const stepDef = stepDefs[stepIndex];
  const step = {
    ...stepDef,
    title: t(`onboarding.${stepDef.i18nKey}.title`),
    body: t(`onboarding.${stepDef.i18nKey}.body`),
  };
  const isLast = stepIndex === stepDefs.length - 1;

  useEffect(() => {
    if (step.section) onNavigate(step.section);

    function measure() {
      if (!step.selector) {
        setRect(null);
        return;
      }
      const el = document.querySelector(step.selector);
      setRect(el ? el.getBoundingClientRect() : null);
    }

    // Re-render happens after this effect runs, so a step that just
    // navigated doesn't have its target in the DOM yet on the very first
    // measurement — two rAFs is enough to wait for that paint without a
    // magic-number timeout. Both ids are tracked in THIS scope (not
    // nested) so the cleanup below can actually cancel whichever one
    // hasn't fired yet if the step changes again before it does —
    // otherwise a quick double-click on Next could call measure() on a
    // step that's no longer current.
    let raf2 = null;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(measure);
    });

    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  function finish() {
    markSeen();
    onFinish();
  }

  function next() {
    if (isLast) finish();
    else setStepIndex((i) => i + 1);
  }

  function back() {
    setStepIndex((i) => Math.max(0, i - 1));
  }

  // Tooltip card position: centered if there's no spotlight target (intro
  // step or a target that didn't resolve, e.g. sidebar mid-animation),
  // otherwise pinned just below the target — or above it, if below would
  // run off the bottom of the viewport.
  const cardStyle = (() => {
    if (!rect) {
      return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    }
    const belowTop = rect.bottom + 14;
    const spaceBelow = window.innerHeight - belowTop;
    const placeAbove = spaceBelow < 160;
    return {
      top: placeAbove ? Math.max(14, rect.top - 14) : belowTop,
      left: Math.min(Math.max(14, rect.left), window.innerWidth - 340),
      transform: placeAbove ? 'translateY(-100%)' : 'none',
    };
  })();

  return (
    <div className="fixed inset-0 z-[9998]" role="dialog" aria-modal="true">
      {rect ? (
        <div
          className="fixed rounded-lg transition-all duration-150 pointer-events-none"
          style={{
            top: rect.top - SPOTLIGHT_PAD,
            left: rect.left - SPOTLIGHT_PAD,
            width: rect.width + SPOTLIGHT_PAD * 2,
            height: rect.height + SPOTLIGHT_PAD * 2,
            boxShadow: '0 0 0 9999px rgba(10, 10, 15, 0.65)',
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-[rgba(10,10,15,0.65)]" />
      )}

      <div
        className="fixed w-80 border border-border bg-panel rounded-lg shadow-2xl p-4 z-[9999]"
        style={cardStyle}
      >
        <div className="font-mono text-[11px] text-muted uppercase tracking-wider mb-1.5">
          {t('onboarding.step', { current: stepIndex + 1, total: stepDefs.length })}
        </div>
        <div className="text-[15px] font-bold text-ink mb-1.5">{step.title}</div>
        <div className="text-[13px] text-ink-dim leading-relaxed mb-4">{step.body}</div>
        <div className="flex items-center justify-between">
          <button type="button" onClick={finish} className="text-[12px] font-semibold text-muted hover:text-ink">
            {t('onboarding.skipTour')}
          </button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={back}
                className="text-[13px] font-semibold rounded-md px-3 py-1.5 border text-ink bg-panel-raised border-border hover:border-accent"
              >
                {t('onboarding.back')}
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3.5 py-1.5"
            >
              {isLast ? t('onboarding.done') : t('onboarding.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
