'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { getSettings } = require('./db');
const { startPoller } = require('./poller');
const ALERTS_DIR = process.env.ALERTS_DIR || path.join(__dirname, '../data/alerts');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());

// ── Dynmap reverse proxy ─────────────────────────────────────────────────────
// Resolves the target dynamically so settings changes take effect without restart.
app.use('/dynmap', (req, res, next) => {
  const { dynmap_url } = getSettings();
  createProxyMiddleware({
    target: dynmap_url,
    changeOrigin: true,
    pathRewrite: { '^/dynmap': '' },
    on: {
      error: (err, req, res) => {
        res.status(502).json({ error: `Dynmap proxy error: ${err.message}` });
      },
    },
  })(req, res, next);
});

// ── Static alert images ──────────────────────────────────────────────────────
app.use('/alerts', express.static(ALERTS_DIR));

// ── REST API routes ──────────────────────────────────────────────────────────
app.use('/api/groups',    require('./routes/groups'));
app.use('/api/groups/:groupId/pois', require('./routes/pois'));
app.use('/api/pois',      require('./routes/pois'));
app.use('/api/alerts',    require('./routes/alerts'));
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/status',    require('./routes/status'));

// ── React SPA (production only — skipped in dev when dist doesn't exist) ─────
const CLIENT_DIST = path.join(__dirname, '../client/dist');
const CLIENT_INDEX = path.join(CLIENT_DIST, 'index.html');
if (fs.existsSync(CLIENT_INDEX)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (_req, res) => res.sendFile(CLIENT_INDEX));
} else {
  app.get('*', (_req, res) =>
    res.status(404).send('Client not built. In dev mode open http://localhost:5173 (Vite). Run `npm run build:client` for production.')
  );
}

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  startPoller().catch(err => {
    console.error('[server] Failed to start poller:', err);
  });
});

module.exports = app;
