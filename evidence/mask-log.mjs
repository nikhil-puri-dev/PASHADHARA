// Writes a public, masked copy of a raw PayPal sandbox log.
// Usage: node evidence/mask-log.mjs evidence/spike2-log.jsonl evidence/spike2-log.masked.jsonl
// Structure, amounts, ids, statuses, times and fees are copied unchanged.
// Account and contact fields are replaced with "[masked]". Any email-shaped
// string anywhere is replaced too, as a second net.
import { readFileSync, writeFileSync } from 'node:fs';

const MASK = '[masked]';
const KEYS = new Set([
  'email_address', 'receiver', 'account_id', 'payer_id', 'merchant_id',
  'given_name', 'surname', 'full_name',
  'address_line_1', 'address_line_2', 'admin_area_1', 'admin_area_2', 'postal_code',
]);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;

const clean = (value) => {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      k,
      KEYS.has(k) && (v === null || typeof v !== 'object') ? MASK : clean(v),
    ]));
  }
  return typeof value === 'string' ? value.replace(EMAIL, MASK) : value;
};

const [src, dest] = process.argv.slice(2);
if (!src || !dest) throw new Error('usage: node evidence/mask-log.mjs <raw.jsonl> <masked.jsonl>');
const rows = readFileSync(src, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
writeFileSync(dest, rows.map((row) => JSON.stringify(clean(row))).join('\n') + '\n');
console.log(`masked ${rows.length} rows -> ${dest}`);
