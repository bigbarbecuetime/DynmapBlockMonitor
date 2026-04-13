'use strict';

const { Router } = require('express');
const db = require('../db');

const router = Router();

// GET /api/alerts?group=&poi=&since=&limit=&offset=
router.get('/', (req, res) => {
  const { group, poi, since, limit, offset } = req.query;
  const alerts = db.getAlerts({
    groupId: group ? parseInt(group) : undefined,
    poiId:   poi   ? parseInt(poi)   : undefined,
    since,
    limit:  limit  ? parseInt(limit)  : 50,
    offset: offset ? parseInt(offset) : 0,
  });
  const total = db.getAlertCount({
    groupId: group ? parseInt(group) : undefined,
    poiId:   poi   ? parseInt(poi)   : undefined,
    since,
  });
  res.json({ alerts, total });
});

// GET /api/alerts/:id
router.get('/:id', (req, res) => {
  const alert = db.getAlert(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  res.json(alert);
});

// GET /api/alerts/:id/image  (redirect to static file)
router.get('/:id/image', (req, res) => {
  const alert = db.getAlert(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (!alert.image_path) return res.status(404).json({ error: 'No image for this alert' });
  res.redirect(`/alerts/${alert.image_path}`);
});

module.exports = router;
