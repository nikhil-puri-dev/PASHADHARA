import { readFileSync } from 'node:fs';
import { Database } from '../../../packages/kernel/src/index.ts';
import { compareJournal, type Resource } from '../src/compare-journal.ts';

async function main() {
  const [lease, date] = process.argv.slice(2);
  if (!/^[\da-f-]{36}$/.test(lease ?? '') || !/^\d{8}(?:-replacement)?$/.test(date ?? '') || !process.env.DATABASE_URL) throw new Error();
  const rows = readFileSync(new URL('../../../evidence/live-' + date + '.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
    lease?: string; event: string; op: string; call: number; call_id?: string; request_id?: string; http_status?: number; body?: Resource;
  });
  const reads = rows.filter(row => row.lease === lease && row.event === 'response');
  const auth = reads.filter(row => row.op === 'get_authorization').at(-1)?.body;
  const captures = new Map<string, Resource>();
  for (const row of reads) {
    if (row.op === 'get_capture' && row.body?.id) captures.set(row.body.id, row.body);
  }
  if (!auth || !captures.size) throw new Error();
  const db = new Database(process.env.DATABASE_URL);
  try {
    const lines = await compareJournal(db, lease, auth, [...captures.values()], 'measured');
    const correlation = await db.transaction(null, async tx => {
      const expected = reads.filter(r => r.op === 'get_authorization' || r.op === 'get_capture');
      const { rows } = await tx.query<{ matched: number }>(`select count(distinct c.id)::int as matched
        from jsonb_to_recordset($2::jsonb) as r(call_id uuid, request_id uuid, http_status integer, body jsonb)
        join public.paypal_calls c on c.id=r.call_id and c.request_id=r.request_id and c.http_status=r.http_status
          and c.response @> r.body
        where c.lease_id=$1 and c.op='get' and c.state='succeeded'`, [lease, JSON.stringify(expected)]);
      return rows[0].matched === expected.length;
    });
    console.log(JSON.stringify({ provenance: 'computed', fields: lines.length, mismatches: lines.filter(line => !line.match).map(line => line.field), readIntentsMatch: correlation }));
    if (!correlation || lines.some(line => !line.match)) process.exitCode = 1;
  } finally { await db.end(); }
}
main().catch(() => { console.error('computed: evidence replay failed'); process.exitCode = 1; });
