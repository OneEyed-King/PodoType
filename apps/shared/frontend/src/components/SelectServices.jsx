import DiscoveredTable from './DiscoveredTable.jsx';

// Step 1 of 2: pick which containers to track. Toggling here calls the same
// /toggle endpoint as before — this page is just a clearer front door than
// mixing "pick services" and "monitor services" into one long scroll.
export default function SelectServices({ services, watchedCount, onToggle, manualAddValue, onManualAddChange, onManualAdd, manualAddInputRef, onStartTracking }) {
  return (
    <main className="px-6 pb-10 pt-4">
      <div className="max-w-3xl">
        <h1 className="text-[20px] font-bold m-0">Select services to track</h1>
        <p className="text-muted mt-2 text-[14px] leading-relaxed">
          Every container on this host, read straight from the Docker API — no traffic required. Toggle the ones you
          want to watch, then continue — you can always come back to add more later.
        </p>
      </div>

      <div className="mt-5 max-w-3xl">
        <DiscoveredTable services={services} onToggle={onToggle} />

        <div className="flex gap-2 mt-3 max-w-[480px]">
          <input
            ref={manualAddInputRef}
            type="text"
            value={manualAddValue}
            onChange={(e) => onManualAddChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onManualAdd();
            }}
            placeholder="Service name (for something not running as a container on this host)"
            className="flex-1 bg-panel border border-border text-ink rounded-md px-2.5 py-1.5 text-[14px] font-mono placeholder:font-sans placeholder:text-muted"
          />
          <button
            type="button"
            onClick={onManualAdd}
            className="bg-panel-raised border border-border text-ink rounded-md px-3.5 py-1.5 text-[14px] font-semibold hover:border-accent hover:text-accent whitespace-nowrap"
          >
            Add &amp; watch
          </button>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 max-w-3xl">
        <button
          type="button"
          onClick={onStartTracking}
          className="text-[14px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-4 py-2"
        >
          Start tracking →
        </button>
        <span className="font-mono text-[13px] text-muted">
          {watchedCount} selected
        </span>
      </div>
    </main>
  );
}
