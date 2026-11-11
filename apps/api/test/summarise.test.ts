import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summariseTool } from '../src/summarise.ts';

// Counting stubs only: no network, no spend. Micro-USD figures use the file's estimate rates.
const reply = (body: object) => async () => Response.json(body);
const usage = { input_tokens: 20, output_tokens: 6 }; // 20*1 + 6*5 = 50 micro-USD
const make = (fetcher: (url: string, init: RequestInit) => Promise<Response>, limitUsd = 2) =>
  summariseTool({ apiKey: 'fixture', limitUsd, log: () => {}, fetcher });
const run = async (tool: ReturnType<typeof make>, text = 'x') => tool.admit(text)!.run(text);

test('a complete answer is returned and its usage counted', async () => {
  const tool = make(reply({ content: [{ type: 'text', text: 'Short.' }], stop_reason: 'end_turn', usage }));
  assert.equal((await run(tool)).summary, 'Short.');
  assert.equal(tool.spend.spent_micro, 50);
});

test('stop_reason max_tokens is a failed call: no result, known usage still counted', async () => {
  const tool = make(reply({ content: [{ type: 'text', text: 'Cut off mid sen' }], stop_reason: 'max_tokens', usage }));
  await assert.rejects(run(tool));
  assert.equal(tool.spend.spent_micro, 50);
  assert.equal(tool.spend.reserved_micro, 0);
});

test('any stop_reason that is not a finished answer is a failed call', async () => {
  for (const stop_reason of ['refusal', 'tool_use', 'pause_turn', null, undefined]) {
    const tool = make(reply({ content: [{ type: 'text', text: 'Maybe fine.' }], stop_reason, usage }));
    await assert.rejects(run(tool), String(stop_reason));
    assert.equal(tool.spend.spent_micro, 50, String(stop_reason));
  }
});

test('empty text with usage is a failed call and the usage is counted', async () => {
  const tool = make(reply({ content: [{ type: 'text', text: '  ' }], stop_reason: 'end_turn', usage }));
  await assert.rejects(run(tool));
  assert.equal(tool.spend.spent_micro, 50);
  assert.equal(tool.spend.reserved_micro, 0);
});

test('unknown provider outcome (network error or abort) keeps the worst-case reservation counted', async () => {
  // limit 0.0015 USD stops at 1200 micro; one worst-case reservation for text "x" is 1121.
  const tool = make(async () => { throw new DOMException('aborted', 'AbortError'); }, 0.0015);
  await assert.rejects(run(tool));
  assert.equal(tool.spend.spent_micro, 1121, 'worst case counted as spent');
  assert.equal(tool.spend.reserved_micro, 0);
  assert.equal(tool.admit('x'), null, 'a second call no longer fits the budget');
});

test('an unreadable 200 response is also an unknown outcome', async () => {
  const tool = make(async () => new Response('not json', { status: 200 }), 0.0015);
  await assert.rejects(run(tool));
  assert.equal(tool.spend.spent_micro, 1121);
});

test('a clean HTTP error status is a known failure: reservation released with zero spend', async () => {
  const tool = make(async () => new Response('no', { status: 500 }), 0.0015);
  await assert.rejects(run(tool));
  assert.equal(tool.spend.spent_micro, 0);
  assert.notEqual(tool.admit('x'), null);
});

test('the provider call carries the caller deadline signal', async () => {
  let seen: AbortSignal | undefined;
  const tool = make(async (_url, init) => { seen = init.signal as AbortSignal; return Response.json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage }); });
  const controller = new AbortController();
  await tool.admit('x')!.run('x', controller.signal);
  controller.abort();
  assert.equal(seen?.aborted, true, 'abort of the caller signal reaches the provider fetch');
});
