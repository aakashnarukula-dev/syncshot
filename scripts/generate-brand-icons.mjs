// Render the existing website's Lucide Crop mark without raster redrawing.
// Run after installing website dependencies: node scripts/generate-brand-icons.mjs
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, readdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'syncshot-landing/package.json'));
const sharp = require(require.resolve('sharp', { paths: [require.resolve('next')] }));
const mark = await readFile(path.join(root, 'assets/brand/syncshot.svg'), 'utf8');
const paths = [...mark.matchAll(/<path d="([^"]+)"/g)].map(match => match[1]);
const background = '#141416';
const artwork = (kind) => {
  const bg = kind === 'mark' || kind === 'adaptive' ? '' : kind === 'mac'
    ? `<rect x="100" y="100" width="824" height="824" rx="184" fill="${background}"/>`
    : `<rect width="1024" height="1024" rx="${kind === 'round' ? 512 : 208}" fill="${background}"/>`;
  const size = kind === 'adaptive' ? 512 : kind === 'mark' ? 1024 : 640;
  const inset = (1024 - size) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${bg}<svg x="${inset}" y="${inset}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths.map(d => `<path d="${d}"/>`).join('')}</svg></svg>`;
};
const render = (kind, size) => sharp(Buffer.from(artwork(kind))).resize(size, size).png().toBuffer();
const save = async (file, kind, size) => writeFile(path.join(root, file), await render(kind, size));
const ico = async (kind, sizes) => {
  const images = await Promise.all(sizes.map(size => render(kind, size)));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  images.forEach((data, i) => {
    const start = 6 + i * 16;
    header[start] = sizes[i] === 256 ? 0 : sizes[i]; header[start + 1] = header[start];
    header.writeUInt16LE(1, start + 4); header.writeUInt16LE(32, start + 6);
    header.writeUInt32LE(data.length, start + 8); header.writeUInt32LE(offset, start + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images]);
};

for (const filename of await readdir(path.join(root, 'src-tauri/icons'))) {
  if (!filename.endsWith('.png')) continue;
  const size = filename === 'icon.png' ? 1024 : filename === 'tray.png' ? 44
    : filename === '128x128@2x.png' ? 256 : filename === 'StoreLogo.png' ? 50
    : Number(filename.match(/\d+/)?.[0]);
  if (!size) throw new Error(`Unknown icon size: ${filename}`);
  await save(`src-tauri/icons/${filename}`, filename === 'tray.png' ? 'mark' : 'mac', size);
}
const temp = await mkdtemp(path.join(tmpdir(), 'syncshot-brand-'));
try {
  const iconset = path.join(temp, 'SyncShot.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      await writeFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), await render('mac', size * scale));
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'src-tauri/icons/icon.icns')]);
} finally { await rm(temp, { recursive: true, force: true }); }
await writeFile(path.join(root, 'src-tauri/icons/icon.ico'), await ico('tile', [16, 32, 48, 256]));

const res = 'android/app/src/main/res';
for (const [density, scale] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
  await save(`${res}/mipmap-${density}/ic_launcher.png`, 'tile', 48 * scale);
  await save(`${res}/mipmap-${density}/ic_launcher_round.png`, 'round', 48 * scale);
  await save(`${res}/mipmap-${density}/ic_launcher_foreground.png`, 'adaptive', 108 * scale);
}
const vector = (adaptive) => `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${adaptive ? 108 : 24}dp" android:height="${adaptive ? 108 : 24}dp" android:viewportWidth="${adaptive ? 108 : 24}" android:viewportHeight="${adaptive ? 108 : 24}">\n${adaptive ? '  <group android:scaleX="2.25" android:scaleY="2.25" android:translateX="27" android:translateY="27">\n' : ''}${paths.map(d => `  <path android:pathData="${d}" android:fillColor="@android:color/transparent" android:strokeColor="#FFFFFFFF" android:strokeWidth="2" android:strokeLineCap="round" android:strokeLineJoin="round"/>`).join('\n')}\n${adaptive ? '  </group>\n' : ''}</vector>\n`;
await writeFile(path.join(root, res, 'drawable/ic_syncshot.xml'), vector(false));
await writeFile(path.join(root, res, 'drawable/ic_syncshot_launcher_foreground.xml'), vector(true));
await writeFile(path.join(root, 'syncshot-landing/app/favicon.ico'), await ico('tile', [16, 32, 48]));
await writeFile(path.join(root, 'syncshot-landing/app/icon.svg'), artwork('tile'));
await save('syncshot-landing/public/icon.png', 'tile', 512);
await save('syncshot-landing/app/apple-icon.png', 'tile', 180);
await writeFile(path.join(root, 'public/syncshot.svg'), artwork('tile'));
await copyFile(path.join(root, 'assets/brand/syncshot.svg'), path.join(root, 'syncshot-landing/public/syncshot-mark.svg'));
console.log('Generated white SyncShot icons for macOS, Android, and web.');
