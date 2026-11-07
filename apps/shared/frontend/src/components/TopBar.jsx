// mode="hosted" (passed only from App.jsx's hosted branch) swaps the
// Docker-shaped bits — "HOST · hostname", watched/discovered counts, "+
// Add service" (there's no container list to add from on a hosted
// account) — for what a hosted account actually has: a service count and
// its retention window. Omitting `mode` (self-hosted's own call site)
// keeps every prop and every branch here exactly as it was before hosted
// existed.
import ThemeToggle from './ThemeToggle.jsx';

export default function TopBar({
  watchedCount,
  discoveredCount,
  pollSeconds,
  onAddService,
  onJump,
  mode,
  serviceCount,
  retentionDays,
  onReplayTour,
}) {
  const hosted = mode === 'hosted';
  return (
    <header className="flex items-center gap-4 px-6 py-3.5 border-b border-border-soft bg-panel">
      <div className="flex items-center gap-2.5">
        <span className="w-[30px] h-[30px] inline-flex items-center justify-center rounded-md bg-panel-raised border border-border text-[14px]">
          🦉
        </span>
        <div>
          <div className="font-bold text-[15px] tracking-tight">podotype</div>
          <div className="font-mono text-[12px] text-muted tracking-wider uppercase">
            {hosted ? (
              'hosted'
            ) : (
              <>
                HOST <span className="opacity-60">·</span> {window.location.hostname || 'this host'}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 font-mono text-[13px] text-ink-dim ml-2">
        {hosted ? (
          <>
            <span>
              {serviceCount} service{serviceCount === 1 ? '' : 's'}
            </span>
            {retentionDays !== null && retentionDays !== undefined && (
              <>
                <span className="text-border">·</span>
                <span>last {retentionDays} days</span>
              </>
            )}
          </>
        ) : (
          <>
            <span>{watchedCount} watched</span>
            <span className="text-border">·</span>
            <span>{discoveredCount} discovered</span>
            <span className="text-border">·</span>
            <span>poll {pollSeconds}s</span>
          </>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {onReplayTour && (
          <button
            type="button"
            onClick={onReplayTour}
            title="Replay the guided tour"
            className="w-7 h-7 inline-flex items-center justify-center rounded-md text-muted hover:bg-panel-raised hover:text-ink text-[13px] font-bold"
          >
            ?
          </button>
        )}
        <ThemeToggle />
      </div>

      <span className="inline-flex items-center gap-1.5 font-mono text-[12px] font-bold tracking-wider text-accent bg-accent/10 border border-accent/25 rounded-full px-2.5 py-1">
        <span className="w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_6px_theme(colors.accent)]" />
        LIVE
      </span>

      {onJump && (
        <button
          type="button"
          onClick={onJump}
          title="Jump to a service (Ctrl/Cmd+K)"
          className="text-[13px] font-semibold rounded-md px-3.5 py-1.5 border text-ink bg-panel-raised border-border hover:border-accent hover:text-accent"
        >
          🔎 Jump <span className="text-muted font-normal">⌘K</span>
        </button>
      )}

      {!hosted && (
        <button
          type="button"
          onClick={onAddService}
          className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3.5 py-1.5"
        >
          + Add service
        </button>
      )}
    </header>
  );
}
