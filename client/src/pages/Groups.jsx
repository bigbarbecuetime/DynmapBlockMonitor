import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getGroups, createGroup, updateGroup, deleteGroup, testNotification } from '../api.js';
import Modal from '../components/Modal.jsx';

const DEFAULT_FORM = {
  name: '', webhook_url: '',
  msg_title: '⚠️ Block Change: {poi_name}',
  msg_body: '{poi_name} at ({x}, {z}) in **{group_name}** changed from {old_color} → {new_color}',
  msg_mention: '',
};

function GroupForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({ ...DEFAULT_FORM, ...initial });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try { await onSave(form); }
    catch (err) { setError(err.message); setSaving(false); }
  }

  const SAMPLE_VARS = {
    poi_name: 'Iron Farm Entrance', group_name: form.name || 'My Group',
    x: 128, z: -64, old_color: '#4A7F3B', new_color: '#C0392B',
    timestamp: new Date().toLocaleString(), dynmap_link: '#',
  };
  function preview(tmpl) {
    return tmpl.replace(/\{(\w+)\}/g, (_, k) => SAMPLE_VARS[k] ?? `{${k}}`);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <div className="rounded-md bg-red-900/30 border border-red-700/40 text-red-400 text-sm px-3 py-2">{error}</div>}

      <div>
        <label className="label">Group Name *</label>
        <input className="input" value={form.name} onChange={set('name')} required placeholder="e.g. Iron Farm" />
      </div>
      <div>
        <label className="label">Discord Webhook URL *</label>
        <input className="input" type="url" value={form.webhook_url} onChange={set('webhook_url')} required placeholder="https://discord.com/api/webhooks/..." />
      </div>
      <div>
        <label className="label">Message Mention (optional)</label>
        <input className="input" value={form.msg_mention} onChange={set('msg_mention')} placeholder="e.g. @everyone or <@&ROLE_ID>" />
      </div>

      <hr className="border-slate-800" />
      <p className="text-xs text-slate-500">
        Template variables: <code className="text-slate-400">{'{poi_name}'} {'{group_name}'} {'{x}'} {'{z}'} {'{old_color}'} {'{new_color}'} {'{timestamp}'} {'{dynmap_link}'}</code>
      </p>

      <div>
        <label className="label">Alert Title Template</label>
        <input className="input" value={form.msg_title} onChange={set('msg_title')} />
        <div className="mt-1 text-xs text-slate-500">Preview: {preview(form.msg_title)}</div>
      </div>
      <div>
        <label className="label">Alert Body Template</label>
        <textarea className="input resize-none h-20" value={form.msg_body} onChange={set('msg_body')} />
        <div className="mt-1 text-xs text-slate-500 whitespace-pre-wrap">Preview: {preview(form.msg_body)}</div>
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onCancel} className="btn-secondary">Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save Group'}
        </button>
      </div>
    </form>
  );
}

export default function Groups() {
  const [groups, setGroups]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(null); // null | 'create' | {group}
  const [testing, setTesting] = useState(null);
  const [testMsg, setTestMsg] = useState({});

  async function load() {
    try { setGroups(await getGroups()); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function handleSave(form) {
    if (modal === 'create') {
      await createGroup(form);
    } else {
      await updateGroup(modal.id, form);
    }
    await load();
    setModal(null);
  }

  async function handleDelete(g) {
    if (!confirm(`Delete group "${g.name}" and all its POIs?`)) return;
    await deleteGroup(g.id);
    await load();
  }

  async function handleTest(g) {
    setTesting(g.id);
    setTestMsg({});
    try {
      await testNotification(g.id);
      setTestMsg({ [g.id]: { ok: true, text: 'Test sent!' } });
    } catch (err) {
      setTestMsg({ [g.id]: { ok: false, text: err.message } });
    } finally {
      setTesting(null);
    }
  }

  if (loading) return <div className="text-slate-500 text-sm">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Groups</h1>
          <p className="text-sm text-slate-400 mt-1">Manage POI groups and Discord webhooks</p>
        </div>
        <button onClick={() => setModal('create')} className="btn-primary">+ New Group</button>
      </div>

      {groups.length === 0 ? (
        <div className="card text-center py-16">
          <div className="text-4xl mb-3">📭</div>
          <div className="text-slate-300 font-medium">No groups yet</div>
          <div className="text-slate-500 text-sm mt-1">Create a group to start monitoring blocks</div>
          <button onClick={() => setModal('create')} className="btn-primary mt-4">Create First Group</button>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(g => (
            <div key={g.id} className="card">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold text-slate-100">{g.name}</h2>
                    <span className="badge badge-green">{g.active_poi_count} active</span>
                    <span className="badge badge-gray">{g.poi_count} total</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1 font-mono truncate max-w-xs">
                    {g.webhook_url.replace(/https:\/\/discord\.com\/api\/webhooks\/(\d+)\/.*/, 'discord.com/webhooks/$1/***')}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                  {testMsg[g.id] && (
                    <span className={`text-xs ${testMsg[g.id].ok ? 'text-emerald-400' : 'text-red-400'}`}>
                      {testMsg[g.id].text}
                    </span>
                  )}
                  <button
                    onClick={() => handleTest(g)}
                    disabled={testing === g.id}
                    className="btn-ghost text-xs"
                    title="Send test notification"
                  >
                    {testing === g.id ? '…' : '🔔 Test'}
                  </button>
                  <Link to={`/groups/${g.id}`} className="btn-secondary text-xs">
                    Manage POIs →
                  </Link>
                  <button onClick={() => setModal(g)} className="btn-ghost text-xs">Edit</button>
                  <button onClick={() => handleDelete(g)} className="btn-danger text-xs">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <Modal
          title={modal === 'create' ? 'New Group' : `Edit "${modal.name}"`}
          onClose={() => setModal(null)}
          size="lg"
        >
          <GroupForm
            initial={modal !== 'create' ? modal : undefined}
            onSave={handleSave}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
    </div>
  );
}
