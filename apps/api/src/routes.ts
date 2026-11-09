import { Hono } from 'hono';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats, { type FormatsPlugin } from 'ajv-formats';

type Schema = Record<string, any>;
export type Contract = { paths: Record<string, Record<string, any>>; components: Schema; security?: Schema[] };
export type RouteInput = { params: Record<string, string>; query: Record<string, string>; body: unknown; request: Request; principal: unknown };
export type RouteResult = { status: number; body?: unknown; contentType?: string };
export type RouteHandler = (input: RouteInput) => Promise<RouteResult>;
export type Authenticate = (requirements: Schema[], request: Request, operationId: string, params: Record<string, string>, body: unknown) => Promise<unknown | null>;

const problem = (status: number, title: string) => new Response(JSON.stringify({ type: 'about:blank', title, status }), {
  status, headers: { 'content-type': 'application/problem+json' },
});

function dereference(contract: Contract, value: Schema): Schema {
  if (!value.$ref) return value;
  const path = String(value.$ref).split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  return path.reduce((parent: any, key) => parent[key], contract as any);
}

/** All unspecified operations fail closed until a real handler is installed. */
export function createRoutes(contract: Contract, handlers: Record<string, RouteHandler>, authenticate: Authenticate) {
  const app = new Hono();
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  (addFormats as unknown as FormatsPlugin)(ajv);
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  ajv.addSchema(contract, 'contract');
  const schema = (pointer: string) => ajv.compile({ $ref: `contract#${pointer}` });

  for (const [path, methods] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
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
        const params: Record<string, string> = c.req.param();
        let body: unknown;
        if (bodySchema) {
          const text = await c.req.text();
          if (!text && operation.requestBody?.required) return problem(400, 'Request body required');
          if (text) {
            if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return problem(415, 'Expected application/json');
            try { body = JSON.parse(text); } catch { return problem(400, 'Invalid JSON'); }
            if (!bodySchema(body)) return problem(400, 'Invalid request body');
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
        if (!handler) return problem(503, `Not implemented: ${operation.operationId}`);
        let result: RouteResult;
        try { result = await handler({ params, query, body, request: c.req.raw, principal }); }
        catch { return problem(500, 'Operation failed'); }
        const response = operation.responses[String(result.status)];
        if (!response) return problem(500, 'Undocumented response');
        const contents = dereference(contract, response).content ?? {};
        const contentType = result.contentType ?? Object.keys(contents)[0];
        if (!contentType) return new Response(null, { status: result.status });
        const entry = responseValidators.get(`${result.status}:${contentType}`);
        if (entry && !entry.validate(result.body)) return problem(500, 'Invalid operation response');
        if (!entry || contentType === 'text/event-stream') return problem(503, 'Response type not implemented');
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': contentType } });
      });
    }
  }
  return app;
}
