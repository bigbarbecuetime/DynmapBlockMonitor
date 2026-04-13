import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getStatus } from '../api.js';

const NAV = [
  { to: '/',        label: 'Dashboard',     icon: '▦' },
  { to: '/groups',  label: 'Groups & POIs', icon: '⊞' },
  { to: '/alerts',  label: 'Alert History', icon: '🔔' },
  { to: '/settings',label: 'Settings',      icon: '⚙' },
];

export default function Layout({ children }) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const s = await getStatus();
        if (mounted) setStatus(s);
      } catch {}
    }
    poll();
    const t = setInterval(poll, 15_000);
    return () => { mounted = false; clearInterval(t); };
  }, []);

  const online = status?.running && !status?.lastError;

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 border-r border-slate-800 bg-slate-900 flex flex-col">
        {/* Logo */}
        <div className="px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🗺️</span>
            <div>
              <div className="text-sm font-bold text-slate-100 leading-tight">Block Monitor</div>
              <div className="text-xs text-slate-500">Dynmap Watcher</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-indigo-600/20 text-indigo-400'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                }`
              }
            >
              <span className="w-4 text-center">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Poller status */}
        <div className="px-5 py-3 border-t border-slate-800">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`} />
            <span className="text-xs text-slate-400">{online ? 'Poller running' : 'Poller offline'}</span>
          </div>
          {status?.watchedPois !== undefined && (
            <div className="text-xs text-slate-600 mt-0.5">{status.watchedPois} POIs · {status.watchedTiles} tiles</div>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
