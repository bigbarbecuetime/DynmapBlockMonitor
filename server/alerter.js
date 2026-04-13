'use strict';

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { buildNativeTileUrl, nativePixelOffset } = require('./coordinator');
const { fetchTilePixels } = require('./detector');

const ALERTS_DIR = process.env.ALERTS_DIR || path.join(__dirname, '../data/alerts');

// Ensure alerts directory exists
if (!fs.existsSync(ALERTS_DIR)) fs.mkdirSync(ALERTS_DIR, { recursive: true });

/** Convert { r, g, b } to hex string "#RRGGBB" */
function toHex({ r, g, b }) {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
}

/** Replace template placeholders with actual values. */
function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/**
 * Fetch the native-zoom tile for a POI, draw a red border around the 16×16
 * block region, and save to disk.  Returns the saved file path (relative to
 * ALERTS_DIR) or null if the tile could not be fetched.
 */
async function buildAnnotatedImage(poi, settings) {
  const url = buildNativeTileUrl(
    settings.dynmap_url,
    settings.world_name,
    settings.map_type,
    poi.x,
    poi.z
  );

  let pixels;
  try {
    pixels = await fetchTilePixels(url);
  } catch {
    return null;
  }

  const { nativePixelX, nativePixelZ } = nativePixelOffset(poi.x, poi.z);
  const { data, width, height } = pixels;

  // Draw a 2-px red border around the 16×16 block region.
  // We mutate the raw buffer in place then re-encode.
  const borderColor = { r: 255, g: 30, b: 30, a: 255 };
  const BORDER = 2;
  const BLOCK = 16;

  function setPixel(x, z) {
    if (x < 0 || z < 0 || x >= width || z >= height) return;
    const off = (z * width + x) * 4;
    data[off]     = borderColor.r;
    data[off + 1] = borderColor.g;
    data[off + 2] = borderColor.b;
    data[off + 3] = borderColor.a;
  }

  // Top and bottom borders
  for (let bx = -BORDER; bx < BLOCK + BORDER; bx++) {
    for (let by = 0; by < BORDER; by++) {
      setPixel(nativePixelX + bx, nativePixelZ - 1 - by);       // top
      setPixel(nativePixelX + bx, nativePixelZ + BLOCK + by);    // bottom
    }
  }
  // Left and right borders
  for (let bz = 0; bz < BLOCK; bz++) {
    for (let bx = 0; bx < BORDER; bx++) {
      setPixel(nativePixelX - 1 - bx, nativePixelZ + bz);        // left
      setPixel(nativePixelX + BLOCK + bx, nativePixelZ + bz);    // right
    }
  }

  // Scale up 4× for visibility (128×128 → 512×512)
  const SCALE = 4;
  const pngBuffer = await sharp(data, { raw: { width, height, channels: 4 } })
    .resize(width * SCALE, height * SCALE, { kernel: 'nearest' })
    .png()
    .toBuffer();

  const filename = `alert_${poi.id}_${Date.now()}.png`;
  const filepath = path.join(ALERTS_DIR, filename);
  fs.writeFileSync(filepath, pngBuffer);
  return filename;
}

/**
 * Build the Dynmap direct link for a coordinate.
 */
function dynmapLink(settings, x, z) {
  return `${settings.dynmap_url}/?worldname=${settings.world_name}&mapname=${settings.map_type}&x=${x}&y=64&z=${z}&zoom=5`;
}

/**
 * Send a Discord webhook message for a POI change.
 * group: group row from DB
 * poi:   poi row from DB
 * oldColor, newColor: { r, g, b }
 * imagePath: filename in ALERTS_DIR (or null)
 */
async function sendDiscordAlert(group, poi, oldColor, newColor, imagePath, settings) {
  const oldHex = toHex(oldColor);
  const newHex = toHex(newColor);
  const now = new Date().toISOString();

  const vars = {
    poi_name:   poi.name,
    group_name: group.name,
    x:          poi.x,
    z:          poi.z,
    old_color:  oldHex,
    new_color:  newHex,
    timestamp:  now,
    dynmap_link: dynmapLink(settings, poi.x, poi.z),
  };

  const title   = renderTemplate(group.msg_title, vars);
  const desc    = renderTemplate(group.msg_body, vars);
  const mention = group.msg_mention ? group.msg_mention + ' ' : '';

  // Build multipart form if we have an image; otherwise plain JSON embed
  const embed = {
    title,
    description: mention + desc,
    color: 0xe74c3c,
    timestamp: now,
    fields: [
      { name: 'Old Colour', value: `\`${oldHex}\``, inline: true },
      { name: 'New Colour', value: `\`${newHex}\``, inline: true },
      { name: 'Coordinates', value: `X: ${poi.x}  Z: ${poi.z}`, inline: true },
    ],
  };

  if (imagePath) embed.image = { url: 'attachment://change.png' };

  const payload = { embeds: [embed] };

  let fetchOpts;
  if (imagePath) {
    const imgBuffer = fs.readFileSync(path.join(ALERTS_DIR, imagePath));
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    form.append('files[0]', new Blob([imgBuffer], { type: 'image/png' }), 'change.png');
    fetchOpts = { method: 'POST', body: form };
  } else {
    fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }

  const res = await fetch(group.webhook_url, { ...fetchOpts, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord webhook failed ${res.status}: ${body}`);
  }
}

/**
 * Full alert pipeline: annotate image + send Discord + return the saved
 * image filename (or null).
 */
async function fireAlert(group, poi, oldColor, newColor, settings) {
  const imagePath = await buildAnnotatedImage(poi, settings);

  try {
    await sendDiscordAlert(group, poi, oldColor, newColor, imagePath, settings);
  } catch (err) {
    console.error(`[alerter] Discord send failed for POI ${poi.id}: ${err.message}`);
  }

  return imagePath;
}

/**
 * Send a test notification using sample data to verify the webhook works.
 */
async function sendTestNotification(group, settings) {
  const fakePoi = { name: 'Test POI', x: 100, z: -200 };
  const vars = {
    poi_name:   fakePoi.name,
    group_name: group.name,
    x:          fakePoi.x,
    z:          fakePoi.z,
    old_color:  '#4A7F3B',
    new_color:  '#C0392B',
    timestamp:  new Date().toISOString(),
    dynmap_link: dynmapLink(settings, fakePoi.x, fakePoi.z),
  };

  const embed = {
    title: renderTemplate(group.msg_title, vars),
    description: (group.msg_mention ? group.msg_mention + ' ' : '') + renderTemplate(group.msg_body, vars),
    color: 0x3498db,
    footer: { text: 'This is a test notification' },
    timestamp: vars.timestamp,
  };

  const res = await fetch(group.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord webhook failed ${res.status}: ${body}`);
  }
}

module.exports = { fireAlert, buildAnnotatedImage, sendDiscordAlert, sendTestNotification, toHex, renderTemplate };
