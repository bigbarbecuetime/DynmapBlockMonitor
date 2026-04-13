'use strict';

const { Router } = require('express');
const db = require('../db');
const { rebuildIndex, stopPoller, startPoller } = require('../poller');

const router = Router();

// GET /api/settings
router.get('/', (req, res) => {
  res.json(db.getSettings());
});

// PUT /api/settings
router.put('/', (req, res) => {
  const updated = db.updateSettings(req.body);
  // If poll_interval changed the poller will pick it up on the next cycle
  // If dynmap_url / world_name / map_type changed, rebuild the coordinator
  rebuildIndex();
  res.json(updated);
});

module.exports = router;
