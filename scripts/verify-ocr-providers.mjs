import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { deflateSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const require = createRequire(
  realpathSync(resolve(root, 'node_modules/wrangler/package.json')),
);
const { build } = require('esbuild');
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    hash = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  hash.writeUInt32BE(crc(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, hash]);
}
let stage = 'prepare';
const diagnostics = {};
function recordDiagnostic(value) {
  mkdirSync(resolve(root, '.secrets'), { recursive: true });
  writeFileSync(
    resolve(root, '.secrets/ocr-provider-diagnostic.json'),
    JSON.stringify(value, null, 2),
  );
}
function safeCode(value) {
  return typeof value === 'string' && /^[A-Za-z_]{1,70}$/.test(value)
    ? value
    : null;
}
try {
  const vars = parseEnv(
    readFileSync(resolve(root, 'apps/server/.dev.vars'), 'utf8'),
  );
  await build({
    entryPoints: ['packages/api/src/bulk-ocr-engine.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: '.wrangler/provider-engine.mjs',
    logLevel: 'silent',
  });
  const width = 200,
    height = 100,
    rows = Buffer.alloc(height * (width * 4 + 1), 255);
  for (let y = 0; y < height; y++) rows[y * (width * 4 + 1)] = 0;
  const glyphs = [
    '01110 10001 10001 11111 10001 10001 10001',
    '11111 00100 00100 00100 00100 00100 00100',
    '10001 11011 10101 10101 10001 10001 10001',
  ];
  for (const [index, glyph] of glyphs.entries()) {
    for (const [y, line] of glyph.split(' ').entries()) {
      for (const [x, bit] of [...line].entries()) {
        if (bit !== '1') continue;
        for (let dy = 0; dy < 8; dy++)
          for (let dx = 0; dx < 8; dx++) {
            const offset =
              (24 + y * 8 + dy) * (width * 4 + 1) +
              1 +
              (24 + index * 48 + x * 8 + dx) * 4;
            rows[offset] = rows[offset + 1] = rows[offset + 2] = 0;
          }
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync('.wrangler/synthetic-ocr-provider-test.png', png);
  const { recognizeOcrBytes } = await import(
    new URL('../.wrangler/provider-engine.mjs', import.meta.url)
  );
  const result = await recognizeOcrBytes(
    {
      GOOGLE_VISION_API_KEY: vars.GOOGLE_VISION_API_KEY,
      OPENAI_API_KEY: vars.OPENAI_API_KEY,
      BULK_OCR_MODEL: vars.BULK_OCR_MODEL,
    },
    new Uint8Array(png),
    'image/png',
    async (url, init) => {
      stage = String(url).startsWith('https://vision.googleapis.com/')
        ? 'google'
        : 'openai';
      const response = await fetch(url, init);
      const info = { httpStatus: response.status };
      try {
        const payload = await response.clone().json();
        const error = payload.error ?? payload.responses?.[0]?.error;
        if (error) {
          info.errorCode =
            typeof error.code === 'number' ? error.code : safeCode(error.code);
          info.errorStatus = safeCode(error.status);
          info.errorType = safeCode(error.type);
          info.reasons = (Array.isArray(error.details) ? error.details : [])
            .map((detail) => safeCode(detail.reason))
            .filter(Boolean);
        }
        if (stage === 'google' && response.ok && !error)
          info.hasRecognizedText = Boolean(
            payload.responses?.[0]?.fullTextAnnotation?.text?.trim(),
          );
      } catch {
        info.responseReadable = false;
      }
      diagnostics[stage] = info;
      return response;
    },
  );
  if (Object.values(result.fields).some((field) => field.value))
    throw Error('SYNTHETIC_FALSE_POSITIVE');
  recordDiagnostic({
    passed: true,
    diagnostics,
    credentialsPrinted: false,
    responseBodyPrinted: false,
  });
  console.log(
    JSON.stringify({
      googleAndOpenAiLiveCheckPassed: true,
      syntheticImageOnly: true,
      personalDataTransmitted: false,
      atmAcceptedAsCode: false,
      realImageAccuracyVerified: false,
    }),
  );
} catch (error) {
  const networkCode = [
    'ENOTFOUND',
    'EACCES',
    'ECONNREFUSED',
    'ETIMEDOUT',
  ].includes(error?.cause?.code)
    ? error.cause.code
    : null;
  recordDiagnostic({
    passed: false,
    stage,
    networkCode,
    diagnostics,
    credentialsPrinted: false,
    responseBodyPrinted: false,
  });
  console.error(
    JSON.stringify({
      error: 'OCR_PROVIDER_CHECK_FAILED',
      stage,
      networkCode,
      diagnostics,
      credentialsPrinted: false,
      responseBodyPrinted: false,
    }),
  );
  process.exitCode = 1;
}
