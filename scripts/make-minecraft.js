// Downscale assets/minecraft-source.jpg to a web-friendly default banner.
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');
(async () => {
  const root = path.join(__dirname, '..');
  const src = path.join(root, 'assets', 'minecraft-source.jpg');
  if (!fs.existsSync(src)) { console.error('Missing assets/minecraft-source.jpg'); process.exit(1); }
  const img = await Jimp.read(src);
  img.resize(640, Jimp.AUTO).quality(82);
  await img.writeAsync(path.join(root, 'assets', 'minecraft.jpg'));
  console.log(`minecraft.jpg written (${img.bitmap.width}x${img.bitmap.height})`);
})().catch(e => { console.error(e); process.exit(1); });
