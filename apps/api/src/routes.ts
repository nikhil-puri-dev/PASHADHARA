import { Hono } from 'hono';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats, { type FormatsPlugin } from 'ajv-formats';
import { ApiError, logError, type ApiContext } from './request-log.ts';
import { hasWebhookSignature } from './webhook.ts';

type Schema = Record<string, any>;
export type Contract = { paths: Record<string, Record<string, any>>; components: Schema; security?: Schema[] };
export const API_BASE_PATH = '/api';
export type RouteInput = { params: Record<string, string>; query: Record<string, string>; body: unknown; rawBody?: string; request: Request; principal: unknown };
export type RouteResult = { status: number; body?: unknown; contentType?: string };
export type RouteHandler = (input: RouteInput) => Promise<RouteResult>;
export type Authenticate = (requirements: Schema[], request: Request, operationId: string, params: Record<string, string>, body: unknown) => Promise<unknown | null>;

const problem = (status: number, title: string) => new Response(JSON.stringify({ type: 'about:blank', title, status }), {
  status, headers: { 'content-type': 'application/problem+json' },
});
const maxBodyBytes = 64 * 1024;
const maxBuyerRefLength = 128;

async function boundedBody(request: Request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBodyBytes) {
        void reader.cancel().catch(() => {});
        return null;
      }
      if (chunk.value.byteLength) chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes));
}

function dereference(contract: Contract, value: Schema): Schema {
  if (!value.$ref) return value;
  const path = String(value.$ref).split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  return path.reduce((parent: any, key) => parent[key], contract as any);
}

/** All unspecified operations fail closed until a real handler is installed. */
export function createRoutes(contract: Contract, handlers: Record<string, RouteHandler>, authenticate: Authenticate) {
  const app = new Hono<ApiContext>().basePath(API_BASE_PATH);
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  (addFormats as unknown as FormatsPlugin)(ajv);
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  ajv.addSchema(contract, 'contract');
  const schema = (pointer: string) => ajv.compile({ $ref: `contract#${pointer}` });

  for (const [path, methods] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const name: string = operation.operationId;
      const limitBody = name === 'receivePayPalWebhook' || name === 'createLease' || name === 'createJob' || name === 'deliverJob';
      const escaped = path.replace(/~/g, '~0').replace(/\//g, '~1');
      const base = `/paths/${escaped}/${method}`;
      const bodySchema = operation.requestBody?.content?.['application/json']?.schema
        ? schema(`${base}/requestBody/content/application~1json/schema`) : null;
      const parameters = (operation.parameters ?? []).map((p: Schema) => dereference(contract, p));
      const responseValidators = new Map<string, { validate: ReturnType<typeof schema>; contentType: string }>();
      for (const [status, raw] of Object.entries(operation.responses as Schema)) {
        const response = dereference(contract, raw as Schema);
        for (const [contentType, content] of Object.entries(response.content ?? {})) {
          if (!(content as Schema).schema || contentType === 'text/event-stream') continue;
          const responsePointer = (raw as Schema).$ref ? String((raw as Schema).$ref).slice(1) : `${base}/responses/${status}`;
          const validator = schema(`${responsePointer}/content/${contentType.replace(/~/g, '~0').replace(/\//g, '~1')}/schema`);
          responseValidators.set(`${status}:${contentType}`, { validate: validator, contentType });
        }
      }
      app.on(method.toUpperCase(), path.replace(/\{([^}]+)\}/g, ':$1'), async c => {
        c.set('operation', name);
        if (name === 'receivePayPalWebhook' && !hasWebhookSignature(c.req.raw.headers)) {
          return problem(400, 'Missing PayPal signature headers');
        }
        const params: Record<string, string> = c.req.param();
        let body: unknown;
        let rawBody: string | undefined;
        if (bodySchema) {
          let text: string | null;
          try { text = limitBody ? await boundedBody(c.req.raw) : await c.req.text(); }
          catch { return problem(400, 'Unreadable request body'); }
          if (text === null) return problem(413, 'Request body exceeds 64 KB');
          rawBody = text;
          if (!rawBody && operation.requestBody?.required) return problem(400, 'Request body required');
          if (rawBody) {
            if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return problem(415, 'Expected application/json');
            try { body = JSON.parse(rawBody); } catch { return problem(400, 'Invalid JSON'); }
            if (!bodySchema(body)) return problem(400, 'Invalid request body');
            if (name === 'createJob') {
              const { max_bytes, criteria, content_type, sha256, test_command_id } = (body as { acceptance?: Record<string, unknown> }).acceptance ?? {};
              if (max_bytes !== undefined && (typeof max_bytes !== 'number' || !Number.isSafeInteger(max_bytes) || max_bytes <= 0 || max_bytes > 8192)) {
                return problem(400, 'max_bytes must be 1 to 8192');
              }
              if (typeof criteria !== 'string' || !criteria.trim() || criteria.length > 2000) return problem(400, 'Buyer criteria must contain 1 to 2000 characters');
              if (content_type !== undefined && content_type !== 'text/plain') return problem(400, 'Only text/plain deliverables are supported');
              if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256))) return problem(400, 'Invalid acceptance digest');
              if (test_command_id !== undefined) return problem(400, 'No acceptance commands are allow-listed');
            }
            if (name === 'createLease' && [...(body as { buyer_ref: string }).buyer_ref].length > maxBuyerRefLength) {
              return problem(400, 'buyer_ref exceeds 128 characters');
            }
          }
        }
        const query: Record<string, string> = c.req.query();
        for (const parameter of parameters) {
          const raw = parameter.in === 'path' ? params[parameter.name] : parameter.in === 'header' ? c.req.header(parameter.name) : query[parameter.name];
          if (raw === undefined && parameter.required) return problem(400, `Missing ${parameter.name}`);
          if (raw !== undefined) {
            const value = parameter.schema?.type === 'integer' && /^-?\d+$/.test(raw) ? Number(raw) : raw;
            const check = ajv.compile(parameter.schema ?? {});
            if (!check(value)) return problem(400, `Invalid ${parameter.name}`);
          }
        }
        const requirements = operation.security ?? contract.security ?? [];
        let principal: unknown = null;
        if (requirements.length) {
          principal = await authenticate(requirements, c.req.raw, operation.operationId, params, body);
          if (principal === null) return problem(401, 'Unauthorized');
        }
        const handler = handlers[operation.operationId];
        if (!handler) {
          logError(c.req.raw, name, new ApiError(name === 'receivePayPalWebhook' ? 'Missing webhook configuration' : 'Operation unavailable'));
          return problem(503, `Not implemented: ${name}`);
        }
        let result: RouteResult;
        try { result = await handler({ params, query, body, rawBody, request: c.req.raw, principal }); }
        catch (error) {
          logError(c.req.raw, name, error);
          return problem(500, 'Operation failed');
        }
        const response = operation.responses[String(result.status)];
        if (!response) {
          logError(c.req.raw, name, new ApiError('Undocumented response'));
          return problem(500, 'Undocumented response');
        }
        const contents = dereference(contract, response).content ?? {};
        const contentType = result.contentType ?? Object.keys(contents)[0];
        if (!contentType) return new Response(null, { status: result.status });
        const entry = responseValidators.get(`${result.status}:${contentType}`);
        if (entry && !entry.validate(result.body)) {
          logError(c.req.raw, name, new ApiError('Invalid operation response'));
          return problem(500, 'Invalid operation response');
        }
        if (!entry || contentType === 'text/event-stream') return problem(503, 'Response type not implemented');
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': contentType } });
      });
    }
  }
  return app;
}
