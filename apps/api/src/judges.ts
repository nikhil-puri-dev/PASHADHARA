import type { runJudges } from '../../../packages/kernel/src/index.ts';

type Judge = Parameters<typeof runJudges>[0]['providers'][number];
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

// Model ids come from each provider's own model list (queried 2026-11-11), not guessed.
export const OPENAI_JUDGE_MODEL = 'gpt-6-luna';
export const ANTHROPIC_JUDGE_MODEL = 'claude-haiku-5-5';
/** Worst-case cost quoted to the spend guard per provider call, in USD cents. Deliverables are capped at 8 KiB. */
export const JUDGE_MAX_COST_MINOR = 5n;

/** Two distinct providers. The kernel, not either model, maps a verdict to an amount. */
export function escrowJudges(keys: { openai: string; anthropic: string }, fetcher: Fetch = (url, init) => fetch(url, init)): readonly [Judge, Judge] {
  async function post(url: string, headers: Record<string, string>, body: object) {
    const response = await fetcher(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('Judge API rejected request');
    return response.json() as Promise<any>;
  }
  return [
    {
      id: 'openai', model: OPENAI_JUDGE_MODEL, max_cost_minor: JUDGE_MAX_COST_MINOR,
      async evaluate({ prompt, schema }) {
        const data = await post('https://api.openai.com/v1/chat/completions', { authorization: 'Bearer ' + keys.openai }, {
          model: OPENAI_JUDGE_MODEL, max_completion_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_schema', json_schema: { name: 'verdict', schema, strict: true } },
        });
        return data.choices[0].message.content as string;
      },
    },
    {
      id: 'anthropic', model: ANTHROPIC_JUDGE_MODEL, max_cost_minor: JUDGE_MAX_COST_MINOR,
      async evaluate({ prompt, schema }) {
        const data = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': keys.anthropic, 'anthropic-version': '2023-06-01' }, {
          model: ANTHROPIC_JUDGE_MODEL, max_tokens: 512, messages: [{ role: 'user', content: prompt }],
          output_config: { format: { type: 'json_schema', schema: {
            type: schema.type, required: schema.required, additionalProperties: false,
            properties: { verdict: schema.properties.verdict, score: { type: 'integer' }, reasons: { type: 'array', items: { type: 'string' } } },
          } } },
        });
        return data.content[0].text as string;
      },
    },
  ];
}
