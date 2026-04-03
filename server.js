const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const MANIFEST = path.join(__dirname, 'cards-manifest.json');
const CUSTOM_DIR = path.join(__dirname, 'custom-cards');

const ALL_DEFAULTS = [
  '1E8B0269-6F4A-455E-8E32-D92A80529A71.JPG',
  '4A06414C-606A-4326-B9AF-F92E56E52264 (1).JPG',
  '85D134AB-4E4B-47BE-AB7F-36E0E29F8533.PNG',
  'B21DBD94-BA39-463A-A9CB-2D0B5E08CACB.JPG',
  'DF91EC43-7970-485D-B1C5-4FFDF61A77A2 (1).PNG',
  'IMG_6773.JPG',
  'IMG_6944.JPG',
  'IMG_7085.JPG'
];

if (!fs.existsSync(CUSTOM_DIR)) fs.mkdirSync(CUSTOM_DIR);

function loadManifest() {
  if (fs.existsSync(MANIFEST)) {
    try {
      return JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
    } catch {
      // corrupted manifest — recreate
    }
  }
  const m = { defaultImages: [...ALL_DEFAULTS], customImages: [] };
  saveManifest(m);
  return m;
}

function saveManifest(m) {
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

function requireAuth(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (pw !== 'maslo54') return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Body parser
app.use(express.json({ limit: '10mb' }));

// API routes FIRST (before static middleware)
app.get('/api/images', (req, res) => {
  res.json(loadManifest());
});

app.post('/api/images', requireAuth, (req, res) => {
  try {
    const { dataUrl, name } = req.body;
    if (!dataUrl) return res.status(400).json({ error: 'No image data' });
    const safeName = (name || 'image').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 50);
    const filename = Date.now() + '_' + safeName + '.jpg';
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(CUSTOM_DIR, filename), Buffer.from(base64, 'base64'));
    const m = loadManifest();
    m.customImages.push('custom-cards/' + filename);
    saveManifest(m);
    res.json({ ok: true, path: 'custom-cards/' + filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/images/default/:filename', requireAuth, (req, res) => {
  try {
    const m = loadManifest();
    m.defaultImages = m.defaultImages.filter(f => f !== req.params.filename);
    saveManifest(m);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/images/custom/:filename', requireAuth, (req, res) => {
  try {
    const m = loadManifest();
    const fullPath = 'custom-cards/' + req.params.filename;
    m.customImages = m.customImages.filter(f => f !== fullPath);
    saveManifest(m);
    try { fs.unlinkSync(path.join(CUSTOM_DIR, req.params.filename)); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Static files AFTER API routes
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log('');
  console.log('=================================');
  console.log(`  XAxit running on http://localhost:${PORT}`);
  console.log('  Open this URL in your browser!');
  console.log('=================================');
  console.log('');
});
