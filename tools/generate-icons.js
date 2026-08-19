// Renders the "Crate Label Sun" app icon (SVG) to the PNG sizes the PWA
// manifest and iOS home-screen need. Re-run whenever the mark changes.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#E3A939"/>
  <g stroke="#2B2418" stroke-width="4" stroke-linecap="round">
    <line x1="79" y1="50" x2="88" y2="50"/>
    <line x1="70.5" y1="70.5" x2="76.9" y2="76.9"/>
    <line x1="50" y1="79" x2="50" y2="88"/>
    <line x1="29.5" y1="70.5" x2="23.1" y2="76.9"/>
    <line x1="21" y1="50" x2="12" y2="50"/>
    <line x1="29.5" y1="29.5" x2="23.1" y2="23.1"/>
    <line x1="50" y1="21" x2="50" y2="12"/>
    <line x1="70.5" y1="29.5" x2="76.9" y2="23.1"/>
  </g>
  <circle cx="50" cy="50" r="24" fill="#FBF4E7"/>
  <text x="50" y="60" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="28" fill="#2B2418">SZ</text>
</svg>`;

const targets = [
  { name: 'icon-512.png', size: 512 },
  { name: 'icon-192.png', size: 192 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'favicon-32.png', size: 32 },
  { name: 'favicon-16.png', size: 16 },
];

fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  for (const t of targets) {
    const outPath = path.join(OUT_DIR, t.name);
    await sharp(Buffer.from(svg), { density: 384 })
      .resize(t.size, t.size)
      .png()
      .toFile(outPath);
    console.log('Wrote', outPath);
  }
})();
