// Optional asset-generation helper. The checked-in ICO is used directly by build.ps1.
// Requires sharp only when regenerating the icon, not to build or run the relay.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_MODULE_PATH || 'sharp');
const svg = await readFile(new URL('../icon-concepts/02-switch.svg', import.meta.url));
await writeFile(new URL('relay.svg', import.meta.url), svg);
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map(size => sharp(svg).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const at = 6 + index * 16;
  header[at] = size === 256 ? 0 : size; header[at + 1] = header[at];
  header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(pngs[index].length, at + 8); header.writeUInt32LE(offset, at + 12);
  offset += pngs[index].length;
});
await writeFile(new URL('relay.ico', import.meta.url), Buffer.concat([header, ...pngs]));
await writeFile(new URL('relay.png', import.meta.url), pngs[pngs.length - 1]);
console.log('Automatic-switch icon saved with sizes: ' + sizes.join(', '));
