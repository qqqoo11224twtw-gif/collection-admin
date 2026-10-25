import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { unzipSync } from '../apps/server/node_modules/fflate/esm/index.mjs';

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'production-baseline/2026-10-25');
const manifest = JSON.parse(
  readFileSync(resolve(directory, 'manifest.json'), 'utf8'),
);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (
  manifest.format !== 'zip-parts-v1' ||
  manifest.parts.length !== 31 ||
  manifest.sha256 !==
    '8f8e617b0df7e4590ff1a245ec949b53b9df92a45f17a655222e549835f04b2c'
)
  throw Error('UNEXPECTED_BASELINE_ARCHIVE');
const zip = Buffer.concat(
  manifest.parts.map((part) => {
    if (!/^part-\d{3}\.bin$/.test(part.name)) throw Error('INVALID_PART_NAME');
    const bytes = readFileSync(resolve(directory, part.name));
    if (bytes.length !== part.bytes || sha(bytes) !== part.sha256)
      throw Error('BASELINE_PART_HASH_MISMATCH');
    return bytes;
  }),
);
if (zip.length !== manifest.archiveBytes || sha(zip) !== manifest.sha256)
  throw Error('BASELINE_ARCHIVE_HASH_MISMATCH');
const target = resolve(root, '../production-backup/2026-10-25T07-26-10-034Z');
const files = unzipSync(zip, {
  filter: (file) => {
    if (file.originalSize > 16 * 1024 * 1024)
      throw Error('ARCHIVE_ENTRY_LIMIT');
    return true;
  },
});
let total = 0;
for (const [name, bytes] of Object.entries(files)) {
  total += bytes.length;
  if (total > 64 * 1024 * 1024) throw Error('ARCHIVE_SIZE_LIMIT');
  const destination = resolve(target, name);
  if (
    !destination.toLowerCase().startsWith((target + sep).toLowerCase()) ||
    name.includes('\\')
  )
    throw Error('ARCHIVE_PATH_ESCAPE');
  if (existsSync(destination)) {
    if (sha(readFileSync(destination)) !== sha(bytes))
      throw Error('EXISTING_BACKUP_DIFFERS');
    continue;
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { flag: 'wx' });
}
console.log(
  JSON.stringify({
    restoredFiles: Object.keys(files).length,
    archiveVerified: true,
    originalSourceMapsAvailable: false,
    productionChanged: false,
  }),
);
