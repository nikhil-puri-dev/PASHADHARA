import { createHash, randomUUID } from 'node:crypto';
import { SUMMARISE_MODEL } from '../src/summarise.ts';

/**
 * A real agent loop: Claude Haiku 5.5 decides to call the paid `summarise` tool and this script
 * carries each call to the MCP gateway with the lease token. Prints one JSON line per event.
 * Usage: MCP_URL=... LEASE_TOKEN=... ANTHROPIC_API_KEY=... tsx scripts/live-agent.ts
 */
const { MCP_URL, LEASE_TOKEN, ANTHROPIC_API_KEY, AI_SPEND_LIMIT_USD } = process.env;
if (!MCP_URL || !LEASE_TOKEN || !ANTHROPIC_API_KEY) { console.error('MCP_URL, LEASE_TOKEN and ANTHROPIC_API_KEY are required'); process.exit(1); }
const stopAtMicro = Math.floor(Number(AI_SPEND_LIMIT_USD) * 1_000_000 * 0.8);
if (!(stopAtMicro > 0)) { console.error('AI_SPEND_LIMIT_USD is required'); process.exit(1); }

const docs = [
  'Pashadhara gives an AI agent a spending budget backed by one PayPal authorization hold. A gateway meters each paid tool call against the hold and a deterministic kernel refuses any call that would pass the cap.',
  'The kernel is a Postgres journal with double entry postings. Every amount is an integer number of cents. No model ever chooses an amount: models only propose a verdict and the kernel maps it to money using a rubric the buyer set first.',
  'Webhooks from PayPal are delivered at least once and in any order, so the system verifies the signature, deduplicates by event id and re-reads PayPal state through the API before it changes any record.',
];
const tools = [{
  name: 'summarise', description: 'Summarise text in at most three sentences. Each call costs 3 cents from a prepaid budget.',
  input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}];
let spentMicro = 0;
const say = (line: object) => console.log(JSON.stringify(line));

async function paidCall(text: string) {
  const idempotency_key = `${randomUUID()}:${createHash('sha256').update('summarise').update('\0').update(text).digest('hex')}`;
  const response = await fetch(MCP_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26', authorization: `Bearer ${LEASE_TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summarise', arguments: { text, idempotency_key } } }),
  });
  const rpc = await response.json() as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
  return { http: response.status, idempotency_key, isError: rpc.result?.isError === true, result: rpc.result?.structuredContent ?? {} };
}

const messages: object[] = [{ role: 'user', content: `Summarise each of these ${docs.length} documents with the summarise tool, one call per document, then tell me what you got.\n\n` + docs.map((d, i) => `Document ${i + 1}: ${d}`).join('\n\n') }];
for (let turn = 0; turn < 8; turn++) {
  if (spentMicro >= stopAtMicro) { say({ event: 'stopped', reason: 'AI spend 80 percent reached', spent_micro_usd: spentMicro }); break; }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: SUMMARISE_MODEL, max_tokens: 600, tools, messages }),
  });
  if (!response.ok) { say({ event: 'model_error', http: response.status }); process.exitCode = 1; break; }
  const body = await response.json() as { stop_reason: string; content: { type: string; id?: string; name?: string; input?: { text?: string }; text?: string }[]; usage: { input_tokens: number; output_tokens: number } };
  // Estimate only: documented Haiku 4.5 rates, USD 1 and 5 per million tokens. Haiku 5.5 rates unverified.
  const micro = body.usage.input_tokens + body.usage.output_tokens * 5;
  spentMicro += micro;
  say({ event: 'agent_turn', turn, input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens, estimated_micro_usd: micro, label: 'estimate' });
  messages.push({ role: 'assistant', content: body.content });
  const uses = body.content.filter(part => part.type === 'tool_use');
  if (!uses.length) { say({ event: 'agent_final', text: body.content.filter(p => p.type === 'text').map(p => p.text).join('') }); break; }
  const results = [];
  for (const use of uses) {
    const text = use.input?.text ?? '';
    const paid = await paidCall(text);
    say({ event: 'paid_call', http: paid.http, refused: paid.isError, result: paid.isError ? paid.result : { model: paid.result.model, input_tokens: paid.result.input_tokens, output_tokens: paid.result.output_tokens }, idempotency_key: paid.idempotency_key });
    results.push({ type: 'tool_result', tool_use_id: use.id, is_error: paid.isError, content: JSON.stringify(paid.result) });
  }
  messages.push({ role: 'user', content: results });
}
say({ event: 'done', agent_spent_micro_usd: spentMicro, label: 'estimate' });
