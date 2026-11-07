import { useState } from 'react';
import { api } from '../api.js';

// Small reusable "text block + copy button" — used for both the full
// docker-compose.podotype.yml and the much shorter "include:" snippet, so
// copying either one works the same way.
function CopyableBlock({ text, label, rows }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.alert('Could not copy automatically — select the text below and copy it manually.');
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
        {copied ? 'Copied!' : `Copy ${label}`}
      </button>
    </div>
  );
}

// downloadUrl/closeTitle default to the OTel file's own values so the
// existing call site keeps working unchanged — kept generic in case another
// generated-file panel needs this component later.
export default function OtelInstructions({ compose, onClose, downloadUrl, closeTitle }) {
  if (!compose) return null;

  return (
    <div className="mt-1.5 p-2.5 rounded-md bg-panel-recessed border border-border-soft flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[11px] text-muted uppercase tracking-wide">Setup instructions</div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={closeTitle || 'Close (tracing stays enabled — this just hides these instructions; reopen from the instructions link)'}
            className="link-btn text-muted hover:text-ink text-[15px] leading-none"
          >
            ×
          </button>
        )}
      </div>
      <pre className="whitespace-pre-wrap font-mono text-[13px] text-muted m-0">{compose.instructions}</pre>

      <a href={downloadUrl || api.otelComposeDownloadUrl()} className="link-btn text-accent font-bold self-start">
        ⬇ Download {compose.filename}
      </a>

      <CopyableBlock text={compose.yaml} label={compose.filename} />

      {compose.includeSnippet && (
        <div className="pt-2 border-t border-border-soft flex flex-col gap-1.5">
          <div className="font-mono text-[11px] text-muted uppercase tracking-wide">
            Recommended for CI/CD — paste at the top of the real docker-compose.yml your pipeline deploys, so this
            override applies automatically on every rebuild (needs Compose v2.20+)
          </div>
          <CopyableBlock text={compose.includeSnippet} label="include: snippet" rows={3} />
        </div>
      )}
    </div>
  );
}
