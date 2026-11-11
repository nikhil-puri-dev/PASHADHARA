/**
 * Drives the contract's escrow routes against a running local API: createJob, deliverJob, getJob.
 * Env: API (origin), LEASE_ID, LEASE_TOKEN, SELLER_ID, SELLER_KEY. Prints one JSON line per step, never a token.
 * The payout is sent by the API after the seller's hold; read the rows and PayPal afterwards.
 */
const { API, LEASE_ID, LEASE_TOKEN, SELLER_ID, SELLER_KEY } = process.env;
if (!API || !LEASE_ID || !LEASE_TOKEN || !SELLER_ID || !SELLER_KEY) { console.error('API, LEASE_ID, LEASE_TOKEN, SELLER_ID and SELLER_KEY are required'); process.exit(1); }
const deliverable = process.env.DELIVERABLE ?? '2 + 2 = 4';
const amount = Number(process.env.JOB_AMOUNT_MINOR ?? 300);
const say = (line: object) => console.log(JSON.stringify(line));
async function call(method: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${API}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { http: response.status, json: await response.json().catch(() => null) as any };
}
const view = (job: any) => job && ({ id: job.id, state: job.state, amount_minor: job.amount_minor, verdicts: job.verdicts?.map((v: any) => ({ p: v.judge_provider, m: v.model, v: v.verdict, s: v.score })), decision: job.decision && { outcome: job.decision.outcome, amount_minor: job.decision.amount_minor } });

const created = await call('POST', '/v1/jobs', LEASE_TOKEN, {
  lease_id: LEASE_ID, seller_id: SELLER_ID, amount_minor: amount,
  rubric: [{ min_score: 0, pay_bps: 0 }, { min_score: 50, pay_bps: 5000 }, { min_score: 80, pay_bps: 10000 }],
  acceptance: { max_bytes: 64, content_type: 'text/plain', criteria: 'Pass if the deliverable correctly states that two plus two equals four. Score 100 when it does.' },
});
say({ step: 'createJob', http: created.http, job: view(created.json), refusal: created.http === 402 ? created.json : undefined });
if (created.http !== 201) process.exit(1);
const id = created.json.id as string;
const delivered = await call('POST', `/v1/jobs/${id}/deliver`, SELLER_KEY, { deliverable });
say({ step: 'deliverJob', http: delivered.http, job: view(delivered.json) });
for (let i = 0; i < 24; i++) {
  await new Promise(resolve => setTimeout(resolve, 5000));
  const read = await call('GET', `/v1/jobs/${id}`, LEASE_TOKEN);
  if (!['delivered', 'judging'].includes(read.json?.state)) { say({ step: 'getJob', http: read.http, job: view(read.json) }); process.exit(0); }
}
say({ step: 'getJob', error: 'still judging after 120 s' });
process.exit(1);
