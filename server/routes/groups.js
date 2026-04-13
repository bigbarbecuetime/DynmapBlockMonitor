'use strict';

const { Router } = require('express');
const db = require('../db');
const { rebuildIndex } = require('../poller');
const { sendTestNotification } = require('../alerter');

const router = Router();

// GET /api/groups
router.get('/', (req, res) => {
  res.json(db.getAllGroups());
});

// POST /api/groups
router.post('/', (req, res) => {
  const { name, webhook_url, msg_title, msg_body, msg_mention } = req.body;
  if (!name || !webhook_url) {
    return res.status(400).json({ error: 'name and webhook_url are required' });
  }
  const group = db.createGroup({ name, webhook_url, msg_title, msg_body, msg_mention });
  res.status(201).json(group);
});

// GET /api/groups/:id
router.get('/:id', (req, res) => {
  const group = db.getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json(group);
});

// PUT /api/groups/:id
router.put('/:id', (req, res) => {
  const group = db.getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const updated = db.updateGroup(req.params.id, req.body);
  res.json(updated);
});

// DELETE /api/groups/:id
router.delete('/:id', (req, res) => {
  const group = db.getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  db.deleteGroup(req.params.id);
  rebuildIndex();
  res.json({ ok: true });
});

// POST /api/groups/:id/test-notification
router.post('/:id/test-notification', async (req, res) => {
  const group = db.getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  try {
    const settings = db.getSettings();
    await sendTestNotification(group, settings);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
