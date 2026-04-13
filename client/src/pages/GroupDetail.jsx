import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  getGroup, getPois, createPoi, updatePoi, deletePoi,
  setBaseline, updateBaseline, getPoiPreview
} from '../api.js';
import Modal from '../components/Modal.jsx';
import TilePreview from '../components/TilePreview.jsx';
import ColorSwatch from '../components/ColorSwatch.jsx';

const DEFAULT_POI = { name: '', x: '', z: '', tolerance: 0, active: true };

function POIForm({ initial, onSave, onCancel }) {
  const [form, setForm]     = useState({ ...DEFAULT_POI, ...initial });
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm(f => ({ ...f, [k]: v }));
  };

  // Load tile preview when coords are valid integers
  useEffect(() => {
    const x = parseInt(form.x);
    const z = parseInt(form.z);
    if (isNaN(x) || isNaN(z) || !initial?.id) return;
    getPoiPreview(initial.id).then(setPreview).catch(() => {});
  }, [form.x, form.z, initial?.id]);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await onSave({
        ...form,
        x: parseInt(form.x),
        z: parseInt(form.z),
        tolerance: parseInt(form.tolerance) || 0,
      });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <div className="rounded-md bg-red-900/30 border border-red-700/40 text-red-400 text-sm px-3 py-2">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="label">POI Name *</label>
          <input className="input" value={form.name} onChange={set('name')} required placeholder="e.g. Iron Farm Entrance" />
        </div>
        <div>
          <label className="label">X Coordinate *</label>
          <input className="input" type="number" value={form.x} onChange={set('x')} required placeholder="-128" />
        </div>
        <div>
          <label className="label">Z Coordinate *</label>
          <input className="input" type="number" value={form.z} onChange={set('z')} required placeholder="64" />
        </div>
        <div>
          <label className="label">Tolerance (0 = exact)</label>
          <input className="input" type="number" min="0" max="100" value={form.tolerance} onChange={set('tolerance')} />
          <div className="text-xs text-slate-500 mt-1">RGB Euclidean distance threshold</div>
        </div>
        <div className="flex items-center gap-3 pt-6">
          <input
            id="active"
            type="checkbox"
            checked={form.active}
            onChange={set('active')}
            className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500"
          />
          <label htmlFor="active" className="text-sm text-slate-300 cursor-pointer">Active</label>
        </div>
      </div>

      {preview && (
        <div>
          <label className="label">Tile Preview</label>
          <p className="text-xs text-slate-500 mb-2">
            Red box = target pixel at ({preview.pixelX}, {preview.pixelZ}) in the 128×128 tile
          </p>
          <TilePreview
            tileUrl={preview.zoomTileUrl}
            pixelX={preview.pixelX}
            pixelZ={preview.pixelZ}
            scale={3}
          />
        </div>
      )}

      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onCancel} className="btn-secondary">Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save POI'}
        </button>
      </div>
    </form>
  );
}

function POICard({ poi, onEdit, onDelete, onSetBaseline, onUpdateBaseline }) {
  const [actioning, setActioning] = useState(null);
  const [preview, setPreview]     = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  async function action(fn, label) {
    setActioning(label);
    try { await fn(); }
    finally { setActioning(null); }
  }

  async function loadPreview() {
    if (preview) { setShowPreview(v => !v); return; }
    try {
      const p = await getPoiPreview(poi.id);
      setPreview(p);
      setShowPreview(true);
    } catch {}
  }

  const hasBaseline = poi.baseline_r !== null && poi.baseline_r !== undefined;

  return (
    <div className={`card space-y-3 ${!poi.active ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-slate-100">{poi.name}</span>
            {!poi.active && <span className="badge badge-gray">inactive</span>}
            {!hasBaseline && <span className="badge badge-yellow">no baseline</span>}
          </div>
          <div className="text-xs text-slate-500 mt-0.5 font-mono">
            X: {poi.x}  Z: {poi.z}  ·  tile {poi.tile_key}  ·  px ({poi.pixel_x}, {poi.pixel_z})
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          <button onClick={() => action(onSetBaseline, 'baseline')} disabled={!!actioning} className="btn-secondary text-xs">
            {actioning === 'baseline' ? '…' : hasBaseline ? 'Reset Baseline' : 'Set Baseline'}
          </button>
          {hasBaseline && (
            <button onClick={() => action(onUpdateBaseline, 'update')} disabled={!!actioning} className="btn-ghost text-xs">
              {actioning === 'update' ? '…' : 'Update Baseline'}
            </button>
          )}
          <button onClick={loadPreview} className="btn-ghost text-xs">
            {showPreview ? 'Hide' : 'Preview'}
          </button>
          <button onClick={onEdit} className="btn-ghost text-xs">Edit</button>
          <button onClick={onDelete} className="btn-danger text-xs">✕</button>
        </div>
      </div>

      {/* Baseline color */}
      {hasBaseline && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Baseline:</span>
          <ColorSwatch color={{ r: poi.baseline_r, g: poi.baseline_g, b: poi.baseline_b }} />
          {poi.tolerance > 0 && (
            <span className="text-xs text-slate-600">± {poi.tolerance}</span>
          )}
        </div>
      )}

      {/* Tile preview */}
      {showPreview && preview && (
        <div className="pt-1">
          <TilePreview
            tileUrl={preview.zoomTileUrl}
            pixelX={preview.pixelX}
            pixelZ={preview.pixelZ}
            scale={3}
          />
        </div>
      )}
    </div>
  );
}

export default function GroupDetail() {
  const { id } = useParams();
  const [group, setGroup]   = useState(null);
  const [pois, setPois]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]   = useState(null); // null | 'create' | poi

  const load = useCallback(async () => {
    const [g, p] = await Promise.all([getGroup(id), getPois(id)]);
    setGroup(g); setPois(p);
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function handleSave(form) {
    if (modal === 'create') {
      await createPoi(id, form);
    } else {
      await updatePoi(modal.id, form);
    }
    await load();
    setModal(null);
  }

  async function handleDelete(poi) {
    if (!confirm(`Delete POI "${poi.name}"?`)) return;
    await deletePoi(poi.id);
    await load();
  }

  async function handleSetBaseline(poi) {
    await setBaseline(poi.id);
    await load();
  }

  async function handleUpdateBaseline(poi) {
    await updateBaseline(poi.id);
    await load();
  }

  if (loading) return <div className="text-slate-500 text-sm">Loading...</div>;
  if (!group)  return <div className="text-red-400 text-sm">Group not found</div>;

  const activePois = pois.filter(p => p.active);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link to="/groups" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
          ← Back to Groups
        </Link>
        <h1 className="text-2xl font-bold text-slate-100 mt-2">{group.name}</h1>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <span className="badge badge-green">{activePois.length} active POIs</span>
          <span className="badge badge-gray">{pois.length} total</span>
          <span className="text-xs text-slate-500 font-mono truncate max-w-xs">
            {group.webhook_url.replace(/https:\/\/discord\.com\/api\/webhooks\/(\d+)\/.*/, 'discord.com/webhooks/$1/***')}
          </span>
        </div>
      </div>

      {/* POI list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-slate-200">Points of Interest</h2>
          <button onClick={() => setModal('create')} className="btn-primary">+ Add POI</button>
        </div>

        {pois.length === 0 ? (
          <div className="card text-center py-12">
            <div className="text-3xl mb-3">📍</div>
            <div className="text-slate-300 font-medium">No POIs yet</div>
            <div className="text-slate-500 text-sm mt-1">Add a block coordinate to start monitoring</div>
            <button onClick={() => setModal('create')} className="btn-primary mt-4">Add First POI</button>
          </div>
        ) : (
          <div className="space-y-3">
            {pois.map(poi => (
              <POICard
                key={poi.id}
                poi={poi}
                onEdit={() => setModal(poi)}
                onDelete={() => handleDelete(poi)}
                onSetBaseline={() => handleSetBaseline(poi)}
                onUpdateBaseline={() => handleUpdateBaseline(poi)}
              />
            ))}
          </div>
        )}
      </div>

      {modal && (
        <Modal
          title={modal === 'create' ? 'Add POI' : `Edit "${modal.name}"`}
          onClose={() => setModal(null)}
          size="lg"
        >
          <POIForm
            initial={modal !== 'create' ? modal : undefined}
            onSave={handleSave}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
    </div>
  );
}
