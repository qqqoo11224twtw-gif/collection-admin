import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path)
  throw Error('Usage: node scripts/evaluate-bulk-ocr.mjs <local JSONL>');
const rows = readFileSync(path, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
if (!rows.length) throw Error('Empty evaluation set');
const keys = ['code', 'customerName', 'region'];
const seen = new Set();
for (const row of rows) {
  if (!row.sampleId || seen.has(row.sampleId))
    throw Error('Missing/duplicate sample ID');
  seen.add(row.sampleId);
  for (const key of keys)
    if (
      typeof row.truth?.[key] !== 'string' ||
      typeof row.prediction?.[key] !== 'string'
    )
      throw Error(
        'Each field needs a human truth and prediction (empty for abstention)',
      );
  if (row.humanLabeled !== true || row.requiresReview !== true)
    throw Error('Human labels and mandatory review are required');
}
const metrics = Object.fromEntries(
  keys.map((key) => {
    const labeled = rows.filter((row) => row.truth[key] !== '');
    const proposed = rows.filter((row) => row.prediction[key] !== '');
    const correct = proposed.filter(
      (row) => row.prediction[key] === row.truth[key],
    ).length;
    const auto = rows.filter((row) => row.autoAccepted === true);
    return [
      key,
      {
        labeled: labeled.length,
        proposed: proposed.length,
        correct,
        proposalPrecision: proposed.length ? correct / proposed.length : null,
        exactRecall: labeled.length
          ? labeled.filter((row) => row.prediction[key] === row.truth[key])
              .length / labeled.length
          : null,
        abstentionRate:
          rows.filter((row) => !row.prediction[key]).length / rows.length,
        manualReviewRate: 1,
        autoAccepted: auto.length,
        erroneousAutoAcceptanceRate: auto.length
          ? auto.filter((row) => row.prediction[key] !== row.truth[key])
              .length / auto.length
          : null,
      },
    ];
  }),
);
// Output aggregate metrics only; never print labels or personal information.
console.log(
  JSON.stringify(
    {
      samples: rows.length,
      fields: metrics,
      target: 0.995,
      accuracyCertified: false,
    },
    null,
    2,
  ),
);
if (rows.some((row) => row.autoAccepted === true)) process.exitCode = 1;
