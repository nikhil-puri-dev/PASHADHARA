/** Operator-only: write a lease token to a new local file without logging it. */
import { writeFile } from 'node:fs/promises';
import { issueToken, isUuid } from '../src/auth.ts';

const [lease, destination] = process.argv.slice(2);
const secret = process.env.LEASE_TOKEN_SECRET;
if (!isUuid(lease) || !destination || !secret || [...secret].length < 32) {
  throw new Error('Provide a lease UUID and a new private output path; set LEASE_TOKEN_SECRET in the environment.');
}
await writeFile(destination, issueToken(secret, 'lease', lease), { flag: 'wx', mode: 0o600 });
console.log('Token written to the requested file.');
