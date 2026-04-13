import { useEffect, useState } from 'react';
import { getSettings, updateSettings, getStatus } from '../api.js';

export default function Settings() {
  const [form, setForm]     = useState(null);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => {
    Promise.all([getSettings(), getStatus()])
      .then(([s, st]) => { setForm(s); setStatus(st); })
      .catch(console.error);
  }, []);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(''); setSaved(false);
    try {
      const updated = await updateSettings(form);
      setForm(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!form) return <div className="text-slate-500 text-sm">Loading…</div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Settings</h1>
        <p className="text-sm text-slate-400 mt-1">Dynmap connection and poller configuration</p>
      </div>

      {/* Status card */}
      {status && (
        <div className="card space-y-2">
          <h2 className="text-sm font-semibold text-slate-300">Poller Status</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <div className="text-slate-500">Running</div>
            <div className={status.running ? 'text-emerald-400' : 'text-red-400'}>
              {status.running ? 'Yes' : 'No'}
            </div>
            <div className="text-slate-500">Watched Tiles</div>
            <div className="text-slate-300">{status.watchedTiles}</div>
            <div className="text-slate-500">Watched POIs</div>
            <div className="text-slate-300">{status.watchedPois}</div>
            <div className="text-slate-500">Last Poll</div>
            <div className="text-slate-300">
              {status.lastPollTime ? new Date(status.lastPollTime).toLocaleString() : '—'}
            </div>
            <div className="text-slate-500">Last Timestamp</div>
            <div className="text-slate-300 font-mono text-xs">{status.lastTimestamp || '—'}</div>
            {status.lastError && (
              <>
                <div className="text-slate-500">Last Error</div>
                <div className="text-red-400 text-xs">{status.lastError}</div>
              </>
            )}
          </div>
        </div>
      )}

      <form onSubmit={submit} className="space-y-5">
        {error && (
          <div className="rounded-md bg-red-900/30 border border-red-700/40 text-red-400 text-sm px-3 py-2">{error}</div>
        )}
        {saved && (
          <div className="rounded-md bg-emerald-900/30 border border-emerald-700/40 text-emerald-400 text-sm px-3 py-2">
            Settings saved
          </div>
        )}

        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-slate-300">Dynmap Connection</h2>
          <div>
            <label className="label">Dynmap Base URL</label>
            <input className="input" value={form.dynmap_url} onChange={set('dynmap_url')} placeholder="http://dynmap.example.com:8123" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">World Name</label>
              <input className="input" value={form.world_name} onChange={set('world_name')} placeholder="world" />
            </div>
            <div>
              <label className="label">Map Type</label>
              <input className="input" value={form.map_type} onChange={set('map_type')} placeholder="flat2" />
              <div className="text-xs text-slate-500 mt-1">As it appears in Dynmap tile URLs</div>
            </div>
          </div>
        </div>

        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-slate-300">Poller</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Poll Interval (ms)</label>
              <input className="input" type="number" min="3000" step="1000" value={form.poll_interval} onChange={set('poll_interval')} />
              <div className="text-xs text-slate-500 mt-1">Minimum 3000ms recommended</div>
            </div>
            <div>
              <label className="label">Offline Threshold (ms)</label>
              <input className="input" type="number" min="60000" step="60000" value={form.offline_threshold} onChange={set('offline_threshold')} />
              <div className="text-xs text-slate-500 mt-1">Gap before full rescan triggers</div>
            </div>
            <div>
              <label className="label">Rescan Cooldown (ms)</label>
              <input className="input" type="number" min="5000" step="1000" value={form.rescan_cooldown} onChange={set('rescan_cooldown')} />
              <div className="text-xs text-slate-500 mt-1">Suppress duplicate alerts for this window</div>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
