import StatusPill, { statusPillProps, tracePillProps } from './StatusPill.jsx';
import ServiceDetailPanel from './ServiceDetailPanel.jsx';

// Full page for one service — replaces the old "expand this row in place
// inside the list" behavior. `svc` is looked up by name from whichever
// live, polling list App.jsx already has (watchedServices/statusServices)
// on every render, so this page stays live (status/trace pill, metrics)
// exactly like the row did, it's just not squeezed between every other
// watched service anymore.
export default function ServiceDetailPage({ svc, onBack, ...panelProps }) {
  if (!svc) {
    return (
      <div>
        <button type="button" onClick={onBack} className="link-btn text-accent text-[13px] mb-3">
          ← Back to services
        </button>
        <p className="text-muted text-[15px]">
          That service isn't watched anymore — it may have just been removed or stopped.
        </p>
      </div>
    );
  }

  const status = statusPillProps(svc);
  const trace = tracePillProps(svc.trace);

  return (
    <div>
      <button type="button" onClick={onBack} className="link-btn text-accent text-[13px] mb-3">
        ← Back to services
      </button>
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <h1 className="text-[22px] font-bold font-mono m-0 [overflow-wrap:anywhere]">{svc.name}</h1>
        <StatusPill {...status} />
        {trace && <StatusPill {...trace} />}
      </div>
      <ServiceDetailPanel svc={svc} {...panelProps} />
    </div>
  );
}
