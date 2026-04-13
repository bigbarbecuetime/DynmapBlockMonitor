import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getGroups, getAlerts, getStatus } from '../api.js';
import ColorSwatch from '../components/ColorSwatch.jsx';

function StatCard({ label, value, sub }) {
  return (
    <div className="card">
      <div className="text-3xl font-bold text-slate-100">{value}</div>
      <div className="mt-1 text-sm font-medium text-slate-300">{label}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function toHex(r, g, b) {
  if (r === null || r === undefined) return null;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
}

export default function Dashboard() {
  const [groups, setGroups]   = useState([]);
  const [alerts, setAlerts]   = useState([]);
  const [status, setStatus]   = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getGroups(), getAlerts({ limit: 10 }), getStatus()])
      .then(([g, a, s]) => { setGroups(g); setAlerts(a.alerts); setStatus(s); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const totalPois   = groups.reduce((s, g) => s + (g.poi_count || 0), 0);
  const activePois  = groups.reduce((s, g) => s + (g.active_poi_count || 0), 0);
  const online      = status?.running && !status?.lastError;
  const lastPoll    = status?.lastPollTime ? new Date(status.lastPollTime).toLocaleTimeString() : '—';

  if (loading) return <div className="text-slate-500 text-sm">Loading...</div>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Dashboard</h1>
        <p className="text-sm text-slate-400 mt-1">Overview of monitored blocks and recent alerts</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Groups"      value={groups.length} />
        <StatCard label="Active POIs" value={activePois} sub={`${totalPois} total`} />
        <StatCard label="Poller"      value={online ? 'Online' : 'Offline'} sub={`Last poll ${lastPoll}`} />
        <StatCard label="Watched Tiles" value={status?.watchedTiles ?? '—'} sub={`${status?.watchedPois ?? '—'} POIs`} />
      </div>

      {/* Error banner */}
      {status?.lastError && (
        <div className="rounded-lg border border-red-700/50 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          <strong>Poller error:</strong> {status.lastError}
        </div>
      )}

      {/* Groups summary */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-slate-200">Groups</h2>
          <Link to="/groups" className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
            Manage →
          </Link>
        </div>
        {groups.length === 0 ? (
          <div className="card text-center py-10 text-slate-500">
            No groups yet. <Link to="/groups" className="text-indigo-400 hover:underline">Create one</Link>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-3">
            {groups.map(g => (
              <Link key={g.id} to={`/groups/${g.id}`} className="card hover:border-slate-600 transition-colors block">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-100">{g.name}</span>
                  <span className="badge badge-green">{g.active_poi_count} active</span>
                </div>
                <div className="text-xs text-slate-500 mt-1">{g.poi_count} POIs total</div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Recent alerts */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-slate-200">Recent Alerts</h2>
          <Link to="/alerts" className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
            View all →
          </Link>
        </div>
        {alerts.length === 0 ? (
          <div className="card text-center py-8 text-slate-500 text-sm">No alerts yet</div>
        ) : (
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className="card flex items-center gap-4">
                {a.image_path && (
                  <img
                    src={`/alerts/${a.image_path}`}
                    alt="change"
                    className="h-14 w-14 rounded-md object-cover shrink-0 border border-slate-700"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-100 truncate">{a.poi_name}</span>
                    <span className="badge badge-gray">{a.group_name}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <span className="text-xs text-slate-500">
                      ({a.x}, {a.z})
                    </span>
                    <ColorSwatch color={{ r: a.old_r, g: a.old_g, b: a.old_b }} />
                    <span className="text-slate-600">→</span>
                    <ColorSwatch color={{ r: a.new_r, g: a.new_g, b: a.new_b }} />
                  </div>
                </div>
                <div className="text-xs text-slate-500 shrink-0">
                  {new Date(a.alerted_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
