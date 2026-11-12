import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHOWCASE_TEXT } from '../src/showcase.ts';
import { summariseTool } from '../src/summarise.ts';

// Counting stubs only: no network, no spend. Figures use the estimate rates in summarise.ts (micro-USD).
// index.ts sets the showcase lifetime cap, in served calls, to floor(AI_SPEND_LIMIT_USD * 100 * 0.8).
const lifetimeFor = (limitUsd: number) => Math.floor(limitUsd * 100 * 0.8);
// Worst case the provider can bill one call: every input token reserved, and max_tokens (200) of output.
const worstCall = (tool: ReturnType<typeof summariseTool>) => {
  const before = tool.spend.reserved_micro;
  const admission = tool.admit(SHOWCASE_TEXT)!;
  const reserved = tool.spend.reserved_micro - before;
  admission.cancel();
  return reserved;
};
const stub = (reserved: number) => async () => Response.json({
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
  usage: { input_tokens: reserved - 1000, output_tokens: 200 }, // input + 5 * 200 equals the reservation
});

test('the showcase lifetime cap keeps worst-case model spend under AI_SPEND_LIMIT_USD and below the guard', async () => {
  for (const limitUsd of [1, 2, 5, 20, 100]) {
    const probe = summariseTool({ apiKey: 'fixture', limitUsd, log: () => {} });
    const reserved = worstCall(probe);
    const lifetime = lifetimeFor(limitUsd);
    const tool = summariseTool({ apiKey: 'fixture', limitUsd, log: () => {}, fetcher: stub(reserved) });
    for (let served = 0; served < lifetime; served++) {
      const admission = tool.admit(SHOWCASE_TEXT);
      assert.ok(admission, `limit ${limitUsd}: the guard must not stop call ${served + 1} of ${lifetime}`);
      await admission.run(SHOWCASE_TEXT);
    }
    assert.equal(tool.spend.spent_micro, lifetime * reserved);
    assert.ok(tool.spend.spent_micro <= limitUsd * 1_000_000 * 0.8, `limit ${limitUsd}: spend stays under the guard line`);
    assert.ok(tool.spend.spent_micro < limitUsd * 1_000_000 / 5, `limit ${limitUsd}: spend is under a fifth of the limit`);
  }
});

test('the AI spend guard still stops calls once its own budget cannot cover one more', async () => {
  const probe = summariseTool({ apiKey: 'fixture', limitUsd: 1, log: () => {} });
  const reserved = worstCall(probe);
  // A limit so small that one worst-case call exceeds 80 percent of it: the guard refuses admission, nothing is billed.
  const tiny = summariseTool({ apiKey: 'fixture', limitUsd: (reserved - 1) / 1_000_000 / 0.8, log: () => {} });
  assert.equal(tiny.admit(SHOWCASE_TEXT), null);
  // A zero or missing limit never admits.
  assert.equal(summariseTool({ apiKey: 'fixture', limitUsd: Number.NaN, log: () => {} }).admit(SHOWCASE_TEXT), null);
  // With budget left for exactly two calls, a third is refused while two are in flight.
  const two = summariseTool({ apiKey: 'fixture', limitUsd: (reserved * 2) / 1_000_000 / 0.8, log: () => {} });
  const a = two.admit(SHOWCASE_TEXT), b = two.admit(SHOWCASE_TEXT);
  assert.ok(a && b);
  assert.equal(two.admit(SHOWCASE_TEXT), null);
  a.cancel(); b.cancel();
});
