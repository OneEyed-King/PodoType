export default function DiscoveredTable({ services, onToggle }) {
  if (services.length === 0) {
    return (
      <p className="text-muted text-[14px] py-2.5">
        No containers found — check that /var/run/docker.sock is mounted into PodoType's app container (see
        docker-compose.yml).
      </p>
    );
  }

  return (
    <div className="border border-border-soft rounded-lg overflow-hidden bg-panel">
      <div className="grid grid-cols-[1fr_1fr_90px] gap-2.5 px-3.5 py-2 font-mono text-[11px] uppercase tracking-widest text-muted border-b border-border-soft bg-panel-raised">
        <span>Container</span>
        <span>Image</span>
        <span className="text-right">Action</span>
      </div>
      <div>
        {services.map((svc) => (
          <div
            key={svc.name}
            className="grid grid-cols-[1fr_1fr_90px] items-center gap-2.5 px-3.5 py-2 border-b border-border-soft last:border-b-0 hover:bg-panel-raised"
          >
            <span className="font-mono text-[13px] [overflow-wrap:anywhere]">{svc.name}</span>
            <span className="font-mono text-[13px] text-muted [overflow-wrap:anywhere]">{svc.image || '—'}</span>
            <span className="flex justify-end items-center gap-1.5">
              <span
                className={`font-mono text-[12px] font-bold uppercase tracking-wide ${
                  svc.watched ? 'text-accent' : 'text-muted'
                }`}
              >
                {svc.watched ? 'watching' : 'watch'}
              </span>
              <input
                type="checkbox"
                className="switch"
                checked={svc.watched}
                onChange={() => onToggle(svc.name)}
                title={svc.watched ? 'Watching — click to stop' : 'Not watched — click to watch'}
              />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
