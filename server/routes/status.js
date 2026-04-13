'use strict';

const { Router } = require('express');
const { getStatus } = require('../poller');

const router = Router();

// GET /api/status
router.get('/', (req, res) => {
  res.json(getStatus());
});

module.exports = router;
