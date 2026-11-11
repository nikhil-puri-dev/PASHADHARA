import { createHash, randomUUID } from 'node:crypto';
import { commitUsage, type Database } from '../../../packages/kernel/src/index.ts';
import { balances } from '../../../packages/kernel/src/journal.ts';
import { createMcp, registeredTools, type Meter } from '../src/mcp.ts';
import { RunStop } from './sandbox-approval.ts';

export async function sandboxSeller(db: Database, email: string) {
  return db.transaction(null, async tx => {
    await tx.query('select pg_advisory_xact_lock(234171, 1)');
    const sellers = await tx.query<{ id: string }>('select id from public.sellers where paypal_email=$1', [email]);
    if (sellers.rows.length > 1) throw new RunStop('Sandbox seller is ambiguous');
    const seller = sellers.rows[0]?.id ?? (await tx.query<{ id: string }>(
      "insert into public.sellers(name,paypal_email,payout_hold_seconds) values ('SELLER_A',$1,30) returning id", [email],
    )).rows[0].id;
    await tx.query(`insert into public.tools (id,seller_id,name,price_minor) values ('text_stats',$1,'Text stats',100)
      on conflict (id) do nothing`, [seller]);
    const result = await tx.query('select 1 from public.tools where id=\'text_stats\' and seller_id=$1 and active and price_minor=100', [seller]);
    if (result.rowCount !== 1) throw new RunStop('Existing sandbox tool differs from runner configuration');
    return seller;
  });
}

export function scriptMeter(db: Database, lease: string) {
  const token = randomUUID();
  const meter: Meter = async (id, tool, key, work) => {
    if (id !== lease || tool !== 'text_stats') return { ok: false, error: 'tool_unavailable' };
    const result = await commitUsage(db, id, { kind: 'tool', tool_id: tool, idempotency_key: key });
    if (result.status === 'served') return { ok: true, result: await work(new AbortController().signal) };
    const reasons = { refused_cap: 'cap_reached', refused_exposure: 'exposure_limit', refused_window: 'window_ended', refused_inactive: 'lease_not_active' };
    const { hold } = await db.transaction(null, tx => balances(tx, id));
    return { ok: false, reason: reasons[result.status], price_minor: Number(result.amount_minor), remaining_minor: Number(hold), lease_id: id };
  };
  const app = createMcp(meter, async request => request.headers.get('authorization') === 'Bearer ' + token ? lease : null, registeredTools(db));
  return async (text: string) => {
    const digest = createHash('sha256').update('text_stats').update('\0').update(text).digest('hex');
    const key = randomUUID() + ':' + digest;
    const response = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'text_stats', arguments: { text, idempotency_key: key } } }),
    });
    const rpc = await response.json() as { result?: { isError?: boolean; structuredContent?: { reason?: string; bytes?: number } } };
    const result = rpc.result?.structuredContent;
    if (!response.ok || !result) throw new RunStop('Unexpected MCP transport result');
    const refused = rpc.result?.isError === true && result.reason === 'exposure_limit';
    if (!refused && (rpc.result?.isError || result.bytes !== Buffer.byteLength(text))) throw new RunStop('Unexpected MCP tool result');
    const journal = await db.transaction(null, tx => tx.query<{ id: string; price_minor: string; status: string; ledger_group_id: string | null }>(
      "select id,price_minor,status,ledger_group_id from public.tool_calls where lease_id=$1 and idempotency_key=$2 and tool_id='text_stats'", [lease, key],
    ));
    const entry = journal.rows[0];
    if (journal.rows.length !== 1 || entry.price_minor !== '100' || entry.status !== (refused ? 'refused_exposure' : 'served') ||
      (entry.ledger_group_id === null) !== refused) throw new RunStop('MCP result differs from its kernel journal');
    return refused ? null : { ref_id: entry.id, amount_minor: BigInt(entry.price_minor) };
  };
}
