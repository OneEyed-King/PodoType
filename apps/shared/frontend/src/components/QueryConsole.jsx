import { useEffect, useState } from 'react';
import { api } from '../api.js';

// A handful of starting points, not a query library — picking one just
// fills the textarea (never runs automatically), so it's always obvious
// what's about to execute and easy to tweak before hitting Run. Table/column
// names here match ensureClickHouseSchema in server.js exactly; if that ever
// changes, GET /api/query/tables (rendered below as the schema reference) is
// the source of truth, not this list.
const EXAMPLES = [
  {
    label: 'Slowest traces (last hour)',
    sql: `SELECT ServiceName, SpanName, Duration / 1e6 AS duration_ms, Timestamp\nFROM otel_traces\nWHERE Timestamp >= now() - INTERVAL 1 HOUR\nORDER BY Duration DESC\nLIMIT 50`,
  },
  {
    label: 'Request count + avg duration by service (last hour)',
    sql: `SELECT ServiceName, count() AS spans, avg(Duration) / 1e6 AS avg_duration_ms\nFROM otel_traces\nWHERE Timestamp >= now() - INTERVAL 1 HOUR AND ParentSpanId = ''\nGROUP BY ServiceName\nORDER BY spans DESC`,
  },
  {
    label: 'CPU / memory / error-rate history for one service',
    sql: `SELECT Timestamp, CpuPercent, MemPercent, RequestsPerSec, ErrorRate\nFROM container_metrics\nWHERE ServiceName = 'your-service-name'\nORDER BY Timestamp DESC\nLIMIT 200`,
  },
  {
    label: 'Recent log patterns containing "error" (opted-in services only)',
    sql: `SELECT Timestamp, ServiceName, Level, Pattern, Count, SampleLine\nFROM log_patterns\nWHERE Timestamp >= now() - INTERVAL 1 HOUR AND (Level = 'error' OR positionCaseInsensitive(Pattern, 'error') > 0)\nORDER BY Timestamp DESC\nLIMIT 100`,
  },
  {
    label: 'Trace count per hour, last 24h (spot a spike)',
    sql: `SELECT toStartOfHour(Timestamp) AS hour, ServiceName, count() AS spans\nFROM otel_traces\nWHERE Timestamp >= now() - INTERVAL 24 HOUR AND ParentSpanId = ''\nGROUP BY hour, ServiceName\nORDER BY hour DESC`,
  },
];

// Query history — the "like Grafana Explore" piece that was actually
// missing. Every query you Run gets recorded here (success or failure —
// Grafana's own Explore history keeps both, since a failed query you're
// iterating on is exactly the thing you want to get back to), newest
// first, kept in localStorage so it survives a reload/tab close the same
// way Grafana's does. This is genuinely local to the browser profile —
// unlike everything else in this app it's never sent to the server, so it
// naturally stays scoped to whoever is sitting at this browser (fine for
// a debugging aid; nothing sensitive is added beyond the SQL text itself).
const HISTORY_KEY = 'podotype_query_history_v1';
const HISTORY_MAX = 50;

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(entries) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_MAX)));
  } catch {
    // best-effort — a full/blocked localStorage just means history doesn't
    // persist this session, not a reason to break the query console itself
  }
}

function formatHistoryTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function ResultsTable({ rows }) {
  if (rows.length === 0) return <div className="text-[13px] text-muted py-3">Query ran fine — no rows.</div>;
  const columns = Object.keys(rows[0]);
  return (
    <div className="overflow-auto max-h-[28rem] border border-border-soft rounded-md">
      <table className="w-full text-[13px] font-mono border-collapse">
        <thead className="sticky top-0 bg-panel-raised">
          <tr>
            {columns.map((c) => (
              <th key={c} className="text-left px-2 py-1.5 border-b border-border-soft text-ink-dim whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? '' : 'bg-panel-raised/40'}>
              {columns.map((c) => (
                <td key={c} className="px-2 py-1 border-b border-border-soft/50 text-ink whitespace-nowrap max-w-xs overflow-hidden text-ellipsis">
                  {typeof row[c] === 'object' && row[c] !== null ? JSON.stringify(row[c]) : String(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The "debug like Grafana Explore" panel — raw, read-only SQL against
// podotype's own ClickHouse, for exactly the questions the fixed panels
// elsewhere in this dashboard don't anticipate. See server.js's "Ad-hoc
// debug query" comment for what's actually enforced server-side (SELECT/
// WITH only, one statement, same engine-key auth as every other route) —
// this component is just a thin editor + results table over
// POST /api/query, it enforces nothing itself.
export default function QueryConsole({ onClose }) {
  const [sql, setSql] = useState(EXAMPLES[0].sql);
  const [limit, setLimit] = useState(1000);
  const [result, setResult] = useState(null); // { rows, rowCount, tookMs, sql }
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [tables, setTables] = useState(null);
  const [tablesError, setTablesError] = useState(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState(loadHistory);

  useEffect(() => {
    if (!schemaOpen || tables) return;
    api
      .queryTables()
      .then((body) => setTables(body.tables))
      .catch((err) => setTablesError(err.message));
  }, [schemaOpen, tables]);

  function recordHistory(entry) {
    setHistory((prev) => {
      // Skip recording an exact repeat of the immediately-previous run
      // (e.g. mashing Run again on the same query) — everything else,
      // including a query you've run before further back, gets its own
      // entry, same as Grafana Explore's history.
      if (prev[0] && prev[0].sql === entry.sql && prev[0].limit === entry.limit) return prev;
      const next = [entry, ...prev].slice(0, HISTORY_MAX);
      saveHistory(next);
      return next;
    });
  }

  async function run() {
    setRunning(true);
    setError(null);
    const ranAt = new Date().toISOString();
    try {
      const body = await api.runQuery(sql, limit);
      setResult(body);
      recordHistory({ sql, limit, ranAt, ok: true, rowCount: body.rowCount, tookMs: body.tookMs });
    } catch (err) {
      setError(err.message);
      setResult(null);
      recordHistory({ sql, limit, ranAt, ok: false, errorMessage: err.message });
    } finally {
      setRunning(false);
    }
  }

  // Cmd/Ctrl+Enter to run, same shortcut most SQL consoles (and Grafana
  // Explore itself) use — a debugging tool should not require reaching for
  // the mouse for its single most common action.
  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run();
  }

  function useHistoryEntry(entry) {
    setSql(entry.sql);
    if (entry.limit) setLimit(entry.limit);
    setHistoryOpen(false);
  }

  function clearHistory() {
    setHistory([]);
    saveHistory([]);
  }

  return (
    <div className="mb-5 border border-border rounded-lg overflow-hidden">
      <div className="px-3.5 py-2 border-b border-border-soft flex items-center justify-between">
        <span className="text-[12px] font-bold uppercase tracking-wider text-ink-dim">
          🔎 Query — debug your own traces/logs/metrics directly
        </span>
        <button type="button" className="link-btn text-muted hover:text-ink text-[15px] leading-none" onClick={onClose} title="Close">
          ×
        </button>
      </div>

      <div className="px-3.5 py-3 flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap text-[13px]">
          <span className="text-muted">Examples:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              onClick={() => setSql(ex.sql)}
              className="link-btn text-ink-dim hover:text-accent"
            >
              {ex.label}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="link-btn text-ink-dim hover:text-accent"
              title="Every query you've run in this browser, newest first — click one to load it back into the editor"
            >
              {historyOpen ? 'Hide history ⌃' : `History ⌄${history.length > 0 ? ` (${history.length})` : ''}`}
            </button>
            <button type="button" onClick={() => setSchemaOpen((v) => !v)} className="link-btn text-ink-dim hover:text-accent">
              {schemaOpen ? 'Hide schema ⌃' : 'Show schema ⌄'}
            </button>
          </span>
        </div>

        {historyOpen && (
          <div className="border border-border-soft rounded-md p-2.5 text-[13px] max-h-56 overflow-auto flex flex-col gap-1">
            {history.length === 0 && <div className="text-muted">No queries run yet in this browser.</div>}
            {history.length > 0 && (
              <div className="flex justify-end">
                <button type="button" onClick={clearHistory} className="link-btn text-muted hover:text-down text-[12px]">
                  Clear history
                </button>
              </div>
            )}
            {history.map((h, i) => (
              <button
                key={`${h.ranAt}-${i}`}
                type="button"
                onClick={() => useHistoryEntry(h)}
                title={h.sql}
                className="text-left px-2 py-1.5 rounded border border-transparent hover:border-border-soft"
              >
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted mb-0.5">
                  <span>{formatHistoryTime(h.ranAt)}</span>
                  {h.ok ? (
                    <span className="text-accent">{h.rowCount} row{h.rowCount === 1 ? '' : 's'} · {h.tookMs}ms</span>
                  ) : (
                    <span className="text-down">failed</span>
                  )}
                </div>
                <div className="font-mono text-ink-dim truncate">{h.sql.replace(/\s+/g, ' ')}</div>
              </button>
            ))}
          </div>
        )}

        {schemaOpen && (
          <div className="border border-border-soft rounded-md p-2.5 text-[12px] font-mono max-h-48 overflow-auto">
            {tablesError && <div className="text-down">Couldn't load schema: {tablesError}</div>}
            {!tables && !tablesError && <div className="text-muted">Loading schema…</div>}
            {tables &&
              Object.entries(tables).map(([table, columns]) => (
                <div key={table} className="mb-2">
                  <div className="text-ink font-semibold">{table}</div>
                  <div className="text-muted pl-3">{columns.map((c) => `${c.column} ${c.type}`).join(', ')}</div>
                </div>
              ))}
          </div>
        )}

        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKeyDown}
          rows={8}
          spellCheck={false}
          className="w-full bg-panel border border-border-soft rounded px-2.5 py-2 font-mono text-[13px] text-ink resize-y"
          placeholder="SELECT ... FROM otel_traces WHERE ..."
        />

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="text-[13px] font-semibold text-[#f5f7fc] bg-accent hover:brightness-110 rounded-md px-3.5 py-1.5 disabled:opacity-50"
          >
            {running ? 'Running…' : 'Run (⌘/Ctrl+Enter)'}
          </button>
          <label className="flex items-center gap-1.5 text-[13px] text-muted">
            row limit
            <input
              type="number"
              min="1"
              max="5000"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="w-20 bg-panel border border-border-soft rounded px-1.5 py-0.5 font-mono text-[13px] text-ink"
            />
          </label>
          <span className="text-[12px] text-muted">
            Read-only — SELECT/WITH only, one statement. Auto-limited unless your query already has its own LIMIT.
          </span>
        </div>

        {error && <div className="text-[13px] text-down font-mono whitespace-pre-wrap">{error}</div>}

        {result && (
          <>
            <div className="text-[12px] text-muted font-mono">
              {result.rowCount} row{result.rowCount === 1 ? '' : 's'} · {result.tookMs}ms
            </div>
            <ResultsTable rows={result.rows} />
          </>
        )}
      </div>
    </div>
  );
}
