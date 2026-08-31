// Build-time helper: turn assets/omnex-source.png into a multi-size icon.ico
// (ICO caps at 256px) and refresh assets/icon.png. Run: node scripts/make-icon.js
const Jimp = require('jimp');
const _p2i = require('png-to-ico');
const pngToIco = _p2i.default || _p2i;
const fs = require('fs');
const path = require('path');

(async () => {
  const root = path.join(__dirname, '..');
  const src = path.join(root, 'assets', 'omnex-source.png');
  if (!fs.existsSync(src)) { console.error('Missing assets/omnex-source.png'); process.exit(1); }

  const sizes = [256, 64, 48, 32, 16];
  const buffers = [];
  for (const s of sizes) {
    const img = await Jimp.read(src);
    img.resize(s, s, Jimp.RESIZE_BICUBIC);
    const buf = await img.getBufferAsync(Jimp.MIME_PNG);
    buffers.push(buf);
    if (s === 256) fs.writeFileSync(path.join(root, 'assets', 'icon.png'), buf);
  }
  const ico = await pngToIco(buffers);
  fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), ico);
  console.log(`icon.ico written (${ico.length} bytes, sizes ${sizes.join('/')}); icon.png refreshed at 256px`);
})().catch(e => { console.error(e); process.exit(1); });
