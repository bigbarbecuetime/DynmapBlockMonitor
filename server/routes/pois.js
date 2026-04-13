'use strict';

const { Router } = require('express');
const db = require('../db');
const { rebuildIndex } = require('../poller');
const { samplePoiColor } = require('../detector');
const { buildTileUrl } = require('../coordinator');

const router = Router({ mergeParams: true });

// GET /api/groups/:groupId/pois
router.get('/', (req, res) => {
  const group = db.getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json(db.getPoisForGroup(req.params.groupId));
});

// POST /api/groups/:groupId/pois
router.post('/', (req, res) => {
  const group = db.getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const { name, x, z, tolerance, active } = req.body;
  if (!name || x === undefined || z === undefined) {
    return res.status(400).json({ error: 'name, x, and z are required' });
  }

  const poi = db.createPoi(req.params.groupId, { name, x: parseInt(x), z: parseInt(z), tolerance, active });
  rebuildIndex();
  res.status(201).json(poi);
});

// GET /api/pois/:id
router.get('/:id', (req, res) => {
  const poi = db.getPoi(req.params.id);
  if (!poi) return res.status(404).json({ error: 'POI not found' });
  res.json(poi);
});

// PUT /api/pois/:id
router.put('/:id', (req, res) => {
  const poi = db.getPoi(req.params.id);
  if (!poi) return res.status(404).json({ error: 'POI not found' });
  const updated = db.updatePoi(req.params.id, req.body);
  rebuildIndex();
  res.json(updated);
});

// DELETE /api/pois/:id
router.delete('/:id', (req, res) => {
  const poi = db.getPoi(req.params.id);
  if (!poi) return res.status(404).json({ error: 'POI not found' });
  db.deletePoi(req.params.id);
  rebuildIndex();
  res.json({ ok: true });
});

// POST /api/pois/:id/set-baseline — sample current pixel and save as baseline
router.post('/:id/set-baseline', async (req, res) => {
  const poi = db.getPoi(req.params.id);
  if (!poi) return res.status(404).json({ error: 'POI not found' });

  try {
    const settings = db.getSettings();
    const color = await samplePoiColor(poi, settings);
    const updated = db.setPoiBaseline(req.params.id, color.r, color.g, color.b);
    rebuildIndex();
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: `Failed to sample pixel: ${err.message}` });
  }
});

// POST /api/pois/:id/update-baseline — same as set-baseline (preserves alert history)
router.post('/:id/update-baseline', async (req, res) => {
  const poi = db.getPoi(req.params.id);
  if (!poi) return res.status(404).json({ error: 'POI not found' });

  try {
    const settings = db.getSettings();
    const color = await samplePoiColor(poi, settings);
    const updated = db.setPoiBaseline(req.params.id, color.r, color.g, color.b);
    rebuildIndex();
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: `Failed to sample pixel: ${err.message}` });
  }
});

// GET /api/pois/:id/preview — returns tile metadata for the frontend preview
router.get('/:id/preview', (req, res) => {
  const poi = db.getPoi(req.params.id);
  if (!poi) return res.status(404).json({ error: 'POI not found' });

  const settings = db.getSettings();
  // Flat URL format — no subdirectory
  const zoomTileUrl = `/dynmap/tiles/${settings.world_name}/${settings.map_type}/${poi.tile_key}.png`;

  res.json({
    poi,
    zoomTileUrl,
    pixelX: poi.pixel_x,
    pixelZ: poi.pixel_z,
  });
});

module.exports = router;
