import { useEffect, useState, useCallback } from 'react';
import { getAlerts, getGroups } from '../api.js';
import ColorSwatch from '../components/ColorSwatch.jsx';

const PAGE_SIZE = 25;

export default function AlertHistory() {
  const [alerts, setAlerts]   = useState([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(0);
  const [groups, setGroups]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  // Filters
  const [filterGroup, setFilterGroup] = useState('');
  const [filterSince, setFilterSince] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, g] = await Promise.all([
        getAlerts({
          group: filterGroup || undefined,
          since: filterSince || undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
        getGroups(),
      ]);
      setAlerts(a.alerts);
      setTotal(a.total);
      setGroups(g);
    } finally {
      setLoading(false);
    }
  }, [filterGroup, filterSince, page]);

  useEffect(() => { load(); }, [load]);

  function applyFilters(e) {
    e.preventDefault();
    setPage(0);
    load();
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Alert History</h1>
        <p className="text-sm text-slate-400 mt-1">{total} total alerts</p>
      </div>

      {/* Filters */}
      <form onSubmit={applyFilters} className="card flex flex-wrap gap-4 items-end">
        <div>
          <label className="label">Group</label>
          <select
            className="input w-44"
            value={filterGroup}
            onChange={e => { setFilterGroup(e.target.value); setPage(0); }}
          >
            <option value="">All groups</option>
            {groups.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Since</label>
          <input
            type="datetime-local"
            className="input w-52"
            value={filterSince}
            onChange={e => { setFilterSince(e.target.value); setPage(0); }}
          />
        </div>
        <button type="submit" className="btn-secondary">Apply</button>
        {(filterGroup || filterSince) && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => { setFilterGroup(''); setFilterSince(''); setPage(0); }}
          >
            Clear
          </button>
        )}
      </form>

      {/* Table */}
      {loading ? (
        <div className="text-slate-500 text-sm">Loading…</div>
      ) : alerts.length === 0 ? (
        <div className="card text-center py-12 text-slate-500">No alerts match your filters</div>
      ) : (
        <div className="space-y-2">
          {alerts.map(a => (
            <div key={a.id} className="card">
              <button
                className="w-full text-left"
                onClick={() => setExpanded(expanded === a.id ? null : a.id)}
              >
                <div className="flex items-center gap-4">
                  {/* Thumbnail */}
                  {a.image_path ? (
                    <img
                      src={`/alerts/${a.image_path}`}
                      alt="change"
                      className="h-12 w-12 rounded border border-slate-700 object-cover shrink-0"
                    />
                  ) : (
                    <div className="h-12 w-12 rounded border border-slate-800 bg-slate-800/50 shrink-0" />
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-slate-100">{a.poi_name ?? 'Deleted POI'}</span>
                      <span className="badge badge-gray">{a.group_name ?? '—'}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap text-xs text-slate-500">
                      <span>({a.x}, {a.z})</span>
                      <ColorSwatch color={{ r: a.old_r, g: a.old_g, b: a.old_b }} />
                      <span className="text-slate-700">→</span>
                      <ColorSwatch color={{ r: a.new_r, g: a.new_g, b: a.new_b }} />
                    </div>
                  </div>

                  <div className="text-xs text-slate-500 shrink-0 text-right">
                    {new Date(a.alerted_at).toLocaleString()}
                    <div className="text-slate-700 mt-0.5">{expanded === a.id ? '▲' : '▼'}</div>
                  </div>
                </div>
              </button>

              {expanded === a.id && a.image_path && (
                <div className="mt-4 pt-4 border-t border-slate-800">
                  <img
                    src={`/alerts/${a.image_path}`}
                    alt="annotated tile"
                    className="rounded-lg border border-slate-700 max-w-full"
                    style={{ imageRendering: 'pixelated' }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-500">
            Page {page + 1} of {totalPages} ({total} alerts)
          </span>
          <div className="flex gap-2">
            <button
              className="btn-secondary"
              disabled={page === 0}
              onClick={() => setPage(p => p - 1)}
            >
              ← Prev
            </button>
            <button
              className="btn-secondary"
              disabled={page >= totalPages - 1}
              onClick={() => setPage(p => p + 1)}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
