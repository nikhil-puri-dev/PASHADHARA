import { SpendGuard, runJudges } from '../../../packages/kernel/src/index.ts';
import { oneShotFetch } from './one-shot-fetch.ts';

type Judge = Parameters<typeof runJudges>[0]['providers'][number];

export function realJudges(openai: string, anthropic: string, baseFetch: typeof fetch = oneShotFetch): readonly [Judge, Judge] {
  const openaiModel = 'gpt-4.1-mini-2025-04-14';
  const anthropicModel = 'claude-haiku-4-5-20251001';
  async function post(url: string, headers: Record<string, string>, body: object) {
    const response = await baseFetch(url, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('Judge API rejected request');
    return response.json();
  }
  // At documented rates even the full model input window plus 512 output tokens is below this per-call reservation.
  return [
    {
      id: 'openai', model: openaiModel, max_cost_minor: 150n,
      async evaluate({ prompt, schema }) {
        const data = await post('https://api.openai.com/v1/chat/completions', { authorization: 'Bearer ' + openai }, {
          model: openaiModel, max_completion_tokens: 512, service_tier: 'default',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_schema', json_schema: { name: 'verdict', schema, strict: true } },
        });
        return data.choices[0].message.content;
      },
    },
    {
      id: 'anthropic', model: anthropicModel, max_cost_minor: 150n,
      async evaluate({ prompt, schema }) {
        const data = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': anthropic, 'anthropic-version': '2023-06-01' }, {
          model: anthropicModel, max_tokens: 512, messages: [{ role: 'user', content: prompt }],
          output_config: { format: { type: 'json_schema', schema: {
            type: schema.type, required: schema.required, additionalProperties: false,
            properties: {
              verdict: schema.properties.verdict, score: { type: 'integer' },
              reasons: { type: 'array', items: { type: 'string' } },
            },
          } } },
        });
        return data.content[0].text;
      },
    },
  ];
}

export const judgeBudget = () => new SpendGuard(300n);
