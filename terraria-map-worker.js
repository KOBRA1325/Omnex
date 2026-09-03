// Terraria world → PNG map renderer, run as an isolated Electron utilityProcess so
// the (transient) memory used to expand a large world's tile grid is freed on exit.
// Receives { wldPath, outPath } from the parent, writes a 1px-per-tile PNG, and
// replies { ok, width, height, name } (or { ok:false, error }).
const fs = require('fs');
const zlib = require('zlib');
const { FileReader } = require('terraria-world-file');

// ── minimal PNG encoder (RGB, no native deps) ───────────────────────────────────
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, colour type 2 (RGB)
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── tile palette (approximate Terraria map colours; unknowns fall back neutral) ──
const BLOCK = {
  0:[151,107,75], 1:[128,128,128], 2:[28,216,94], 3:[27,197,109], 5:[110,80,52], 6:[140,88,60], 7:[150,67,22],
  8:[185,164,23], 9:[185,194,195], 10:[73,51,36], 19:[168,120,80], 22:[54,63,150], 23:[142,66,158], 24:[142,66,158],
  25:[98,95,167], 30:[168,120,80], 32:[151,79,80], 37:[112,90,52], 38:[128,128,128], 39:[181,62,60], 40:[86,150,53],
  41:[75,75,143], 43:[86,108,20], 44:[121,105,44], 45:[185,164,23], 46:[86,108,140], 47:[62,82,114], 48:[128,128,128],
  51:[192,202,203], 53:[212,192,100], 56:[43,40,52], 57:[68,68,76], 58:[122,66,50], 59:[92,68,42], 60:[143,215,29],
  61:[105,157,30], 62:[105,157,30], 63:[110,60,155], 64:[224,100,90], 65:[75,140,205], 66:[185,120,50], 67:[145,80,175],
  68:[130,200,220], 70:[93,127,255], 71:[190,150,92], 74:[128,88,55], 75:[43,40,52], 107:[42,140,145], 108:[97,71,150],
  109:[78,193,227], 110:[87,120,44], 111:[181,178,155], 112:[100,80,60], 113:[144,148,204], 116:[181,172,190],
  117:[151,107,75], 118:[86,108,140], 119:[74,67,60], 120:[122,66,50], 121:[144,148,204], 122:[131,162,161],
  124:[168,120,80], 140:[227,46,46], 145:[192,30,30], 146:[38,38,240], 147:[220,240,245], 148:[195,203,213],
  149:[200,240,250], 151:[228,169,120], 152:[128,128,128], 153:[224,180,120], 156:[151,107,75], 157:[85,83,82],
  158:[110,105,100], 159:[151,150,140], 160:[229,255,180], 161:[144,195,232], 162:[144,220,240], 163:[120,80,160],
  164:[110,140,180], 166:[128,128,128], 167:[128,128,128], 168:[128,128,128], 169:[128,128,128], 170:[110,90,60],
  189:[220,225,240], 190:[110,80,52], 191:[110,80,52], 192:[142,66,158], 193:[105,157,30], 194:[151,107,75],
  195:[181,62,60], 196:[130,120,200], 197:[130,225,210], 198:[64,62,70], 199:[216,44,44], 200:[194,80,80],
  201:[211,80,80], 202:[203,70,70], 203:[137,44,44], 204:[137,44,44], 206:[137,44,44], 211:[229,255,180],
  221:[227,46,46], 222:[228,120,200], 223:[64,80,120], 224:[144,195,232], 225:[128,88,55], 226:[169,125,44],
  227:[110,180,90], 229:[255,156,12], 230:[8,72,232], 234:[68,52,70], 248:[190,60,60], 250:[128,128,128],
};
const WALL_C = [42, 42, 52]; // any wall behind an empty tile

async function render(wldPath, outPath) {
  const buf = fs.readFileSync(wldPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const p = await new FileReader().loadBuffer(ab); // loadBuffer is async
  const data = p.parse({ sections: ['header', 'worldTiles'] });
  const h = data.header, tiles = data.worldTiles.tiles;
    const W = h.maxTilesX | 0, H = h.maxTilesY | 0;
    const surf = h.worldSurface | 0, rock = h.rockLayer | 0;
    const rgb = Buffer.alloc(W * H * 3);
    for (let x = 0; x < W; x++) {
      const col = tiles[x];
      for (let y = 0; y < H; y++) {
        const t = col[y];
        let r, g, b;
        if (t && t.blockId != null) {
          const c = BLOCK[t.blockId] || [110, 100, 92];
          r = c[0]; g = c[1]; b = c[2];
        } else if (t && t.liquidType != null) {
          if (t.liquidType === 2) { r = 253; g = 62; b = 3; }        // lava
          else if (t.liquidType === 3) { r = 254; g = 194; b = 20; } // honey
          else if (t.liquidType === 4) { r = 232; g = 174; b = 255; }// shimmer
          else { r = 9; g = 61; b = 191; }                            // water
        } else if (t && t.wallId != null) {
          r = WALL_C[0]; g = WALL_C[1]; b = WALL_C[2];
        } else {
          if (y < surf) { r = 132; g = 170; b = 248; }      // sky
          else if (y < rock) { r = 88; g = 61; b = 46; }    // dirt layer
          else { r = 30; g = 25; b = 22; }                   // cavern/rock
        }
        const o = (y * W + x) * 3; rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
      }
    }
    fs.writeFileSync(outPath, encodePNG(W, H, rgb));
    return { width: W, height: H, name: h.worldName || null };
}

process.parentPort.on('message', (e) => {
  const { wldPath, outPath } = e.data || {};
  render(wldPath, outPath)
    .then(info => { process.parentPort.postMessage({ ok: true, ...info }); })
    .catch(err => { process.parentPort.postMessage({ ok: false, error: err && err.message || String(err) }); });
});
