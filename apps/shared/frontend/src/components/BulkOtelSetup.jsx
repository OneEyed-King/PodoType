import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// One place to turn tracing on/off for several services at once, instead of
// opening each service's own row, expanding its tracing panel, and running
// through the same "which language is this?" prompt one at a time. Doesn't
// replace the per-row Set up/Disable controls — those still work for a
// single quick change — this is for "I just stood up 20 containers, trace
// half of them" or similar.
//
// Deliberately pre-checks and pre-fills whatever's already enabled, so this
// doubles as a bulk EDITOR, not just a bulk enabler: unchecking a
// currently-traced service here and hitting Generate turns tracing off for
// it, same as using that service's own Disable button would.
export default function BulkOtelSetup({ services, supportedOtelLanguages, languageGuesses, onApply, onClose }) {
  const { t } = useTranslation();
  // Only watched services make sense here — tracing on something podotype
  // isn't even monitoring can't show up in the merged file either way (see
  // resolveOtelOverrideEntries in server.js), so listing unwatched ones
  // would just be a confusing dead end.
  const watched = services.filter((s) => s.watched);
  const guesses = languageGuesses || new Map();

  // A guess only ever pre-fills which language gets checked-in by default —
  // never applied without the person seeing and keeping it. Falls back to
  // the first supported language when there's no usable guess for a
  // service, same as before guessing existed.
  function defaultLanguageFor(name) {
    const g = guesses.get(name);
    if (g && g.guess && g.supported) return g.guess;
    return supportedOtelLanguages[0] || '';
  }

  const [selection, setSelection] = useState(() => {
    const map = new Map();
    for (const s of watched) {
      if (s.otel && s.otel.enabled) map.set(s.name, s.otel.language);
    }
    return map; // service name -> language; presence in the map = checked
  });
  const [applying, setApplying] = useState(false);

  function toggle(name) {
    setSelection((prev) => {
      const next = new Map(prev);
      if (next.has(name)) next.delete(name);
      else next.set(name, defaultLanguageFor(name));
      return next;
    });
  }

  function setLanguage(name, language) {
    setSelection((prev) => new Map(prev).set(name, language));
  }

  async function generate() {
    setApplying(true);
    try {
      await onApply(selection);
    } finally {
      setApplying(false);
    }
  }

  const selectedCount = selection.size;

  return (
    <div className="mb-5 p-3.5 rounded-lg bg-panel border border-border-soft flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-bold text-[14px]">{t('bulkOtelSetup.title')}</div>
          <div className="text-muted text-[13px] mt-0.5">{t('bulkOtelSetup.description')}</div>
        </div>
        <button type="button" onClick={onClose} title={t('bulkOtelSetup.close')} className="link-btn text-muted hover:text-ink text-[15px] leading-none shrink-0">
          ×
        </button>
      </div>

      {watched.length === 0 ? (
        <p className="text-muted text-[14px] m-0">{t('bulkOtelSetup.noWatchedServices')}</p>
      ) : supportedOtelLanguages.length === 0 ? (
        <p className="text-muted text-[14px] m-0">{t('bulkOtelSetup.noLanguagesSupported')}</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5 max-h-[320px] overflow-y-auto">
            {watched.map((s) => {
              const checked = selection.has(s.name);
              const guess = guesses.get(s.name);
              // Only worth a line when there's something to say: either a
              // supported guess that isn't already what's checked in (so
              // toggling on will pre-fill something specific), or a language
              // podotype can't trace at all — surfaced here so someone
              // doesn't check the box just to hit "unsupported" downstream.
              const guessHint =
                guess && guess.guess && !checked
                  ? guess.supported
                    ? t('bulkOtelSetup.guessSupported', { guess: guess.guess, reason: guess.reason })
                    : guess.note
                    ? t('bulkOtelSetup.guessUnsupported', { guess: guess.guess, note: guess.note })
                    : null
                  : null;
              return (
                <div
                  key={s.name}
                  className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md border ${
                    checked ? 'border-accent/40 bg-accent/5' : 'border-transparent'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(s.name)}
                    className="accent-accent shrink-0"
                  />
                  <span className="flex flex-col flex-1 min-w-0">
                    <span className="font-mono text-[13px] [overflow-wrap:anywhere]">{s.name}</span>
                    {guessHint && <span className="text-muted text-[12px] [overflow-wrap:anywhere]">{guessHint}</span>}
                  </span>
                  <select
                    disabled={!checked}
                    value={selection.get(s.name) || defaultLanguageFor(s.name)}
                    onChange={(e) => setLanguage(s.name, e.target.value)}
                    className="bg-panel-raised border border-border text-ink rounded-md px-2 py-1 text-[13px] font-mono disabled:opacity-40 shrink-0"
                  >
                    {supportedOtelLanguages.map((lang) => (
                      <option key={lang} value={lang}>
                        {lang}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={generate}
              disabled={applying}
              className="text-[14px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 disabled:opacity-60 rounded-md px-3.5 py-1.5"
            >
              {applying ? t('bulkOtelSetup.generating') : t('bulkOtelSetup.generateConfig')}
            </button>
            <span className="font-mono text-[12px] text-muted">
              {t('bulkOtelSetup.selectedCount', { selected: selectedCount, total: watched.length })}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
