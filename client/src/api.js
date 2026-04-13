const BASE = '/api';

async function request(method, path, body) {
  const opts = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Groups ───────────────────────────────────────────────────────────────────
export const getGroups = () => request('GET', '/groups');
export const getGroup  = (id) => request('GET', `/groups/${id}`);
export const createGroup = (body) => request('POST', '/groups', body);
export const updateGroup = (id, body) => request('PUT', `/groups/${id}`, body);
export const deleteGroup = (id) => request('DELETE', `/groups/${id}`);
export const testNotification = (id) => request('POST', `/groups/${id}/test-notification`);

// ── POIs ─────────────────────────────────────────────────────────────────────
export const getPois       = (groupId) => request('GET', `/groups/${groupId}/pois`);
export const getPoi        = (id) => request('GET', `/pois/${id}`);
export const createPoi     = (groupId, body) => request('POST', `/groups/${groupId}/pois`, body);
export const updatePoi     = (id, body) => request('PUT', `/pois/${id}`, body);
export const deletePoi     = (id) => request('DELETE', `/pois/${id}`);
export const setBaseline   = (id) => request('POST', `/pois/${id}/set-baseline`);
export const updateBaseline = (id) => request('POST', `/pois/${id}/update-baseline`);
export const getPoiPreview  = (id) => request('GET', `/pois/${id}/preview`);

// ── Alerts ───────────────────────────────────────────────────────────────────
export const getAlerts = (params = {}) => {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
  ).toString();
  return request('GET', `/alerts${qs ? '?' + qs : ''}`);
};
export const getAlert = (id) => request('GET', `/alerts/${id}`);

// ── Settings & Status ────────────────────────────────────────────────────────
export const getSettings    = () => request('GET', '/settings');
export const updateSettings = (body) => request('PUT', '/settings', body);
export const getStatus      = () => request('GET', '/status');
