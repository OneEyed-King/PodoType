import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';

// Small reusable "text block + copy button" — used for both the full
// docker-compose.podotype.yml and the much shorter "include:" snippet, so
// copying either one works the same way.
function CopyableBlock({ text, label, rows }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.alert(t('otelInstructions.copyFailedAlert'));
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        readOnly
        value={text}
        rows={rows || Math.min(16, text.split('\n').length + 1)}
        className="w-full bg-bg text-ink border border-border rounded-md p-2 font-mono text-[12px] resize-y"
      />
      <button type="button" onClick={copy} className="link-btn self-start">
        {copied ? t('otelInstructions.copied') : t('otelInstructions.copyLabel', { label })}
      </button>
    </div>
  );
}

// A single-line command with its own copy button — same copy/feedback
// behavior as CopyableBlock below, but sized for one command instead of a
// whole file, so it can sit above the fold without a scrollbar.
function CopyableCommand({ text, label }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.alert(t('otelInstructions.copyFailedAlert'));
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-bold uppercase tracking-wide text-ink-dim">{label}</div>
      <div className="flex items-stretch gap-1.5">
        <code className="flex-1 min-w-0 overflow-x-auto whitespace-pre bg-bg text-ink border border-border rounded-md px-2 py-1.5 font-mono text-[12px]">
          {text}
        </code>
        <button type="button" onClick={copy} className="link-btn shrink-0 px-2">
          {copied ? t('otelInstructions.copied') : t('otelInstructions.copy')}
        </button>
      </div>
    </div>
  );
}

// downloadUrl/closeTitle default to the OTel file's own values so the
// existing call site keeps working unchanged — kept generic in case another
// generated-file panel needs this component later.
//
// compose.instructions is server-generated text (it comes straight from
// the Node backend that built this YAML, not from the frontend i18n
// layer) and stays in English, same out-of-scope convention as
// PreflightBanner's own server-generated preflight.message.
export default function OtelInstructions({ compose, onClose, downloadUrl, closeTitle }) {
  const { t } = useTranslation();
  if (!compose) return null;

  return (
    <div className="mt-1.5 p-2.5 rounded-md bg-panel-recessed border border-border-soft flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[11px] text-muted uppercase tracking-wide">{t('otelInstructions.setupInstructions')}</div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={closeTitle || t('otelInstructions.closeTitleDefault')}
            className="link-btn text-muted hover:text-ink text-[15px] leading-none"
          >
            ×
          </button>
        )}
      </div>

      <a href={downloadUrl || api.otelComposeDownloadUrl()} className="link-btn text-accent font-bold self-start">
        {t('otelInstructions.downloadLabel', { filename: compose.filename })}
      </a>

      <CopyableBlock text={compose.yaml} label={compose.filename} />

      {/* Confirmed live: these two commands are also in the long prose
          below (and again as comments in the YAML above), but both of
          those are long enough to scroll the commands out of view. Putting
          them here, right after the file you just downloaded/copied,
          means the next two things to actually DO are visible without
          scrolling — in the order you'd do them: get the file, then run
          it, then clean up later once the traced set changes. The prose
          below is for the "why"/full detail, not the first thing someone
          needs to find. */}
      {compose.runCommand && <CopyableCommand text={compose.runCommand} label={t('otelInstructions.applyIt')} />}
      {compose.cleanupCommand && (
        <CopyableCommand
          text={compose.cleanupCommand}
          label={t('otelInstructions.cleanupLabel')}
        />
      )}

      <pre className="whitespace-pre-wrap font-mono text-[13px] text-muted m-0">{compose.instructions}</pre>

      {compose.includeSnippet && (
        <div className="pt-2 border-t border-border-soft flex flex-col gap-1.5">
          <div className="font-mono text-[11px] text-muted uppercase tracking-wide">{t('otelInstructions.ciCdRecommended')}</div>
          <CopyableBlock text={compose.includeSnippet} label={t('otelInstructions.includeSnippetLabel')} rows={3} />
        </div>
      )}
    </div>
  );
}
