import type { Database } from '../../../packages/kernel/src/db.ts';
import { API_BASE_PATH, createRoutes, type Authenticate, type Contract, type RouteHandler } from './routes.ts';
import { readHandlers } from './read-handlers.ts';
import { createMcp, unavailableKernelMeter, registeredTools, type Meter, type ToolDef } from './mcp.ts';
import { webhookHandler, type WebhookDependencies } from './webhook.ts';
import { logError } from './request-log.ts';

/** Authentication callbacks must enforce lease and seller ownership, including body identifiers. */
export function createApp(options: {
  contract: Contract;
  db: Database;
  authenticate: Authenticate;
  resolveMcpLease: (request: Request) => Promise<string | null>;
  handlers?: Record<string, RouteHandler>;
  webhook?: WebhookDependencies;
  /** Defaults to the fail-closed meter and the deterministic tools. The entry point passes the real ones. */
  meter?: Meter;
  tools?: readonly ToolDef[];
  mcpAllowedOrigins?: readonly string[];
  publishImplementedContract?: boolean;
}) {
  const handlers: Record<string, RouteHandler> = { ...readHandlers(options.db), listTools: async () => ({ status: 200, body: { tools: await registeredTools(options.db, options.tools?.map(tool => tool.name))() } }), ...options.handlers };
  if (options.webhook) handlers.receivePayPalWebhook = webhookHandler(options.webhook);
  const contract = options.publishImplementedContract ? {
    ...options.contract, paths: Object.fromEntries(Object.entries(options.contract.paths).flatMap(([path, methods]) => {
      const implemented = Object.fromEntries(Object.entries(methods).filter(([, op]) => Object.hasOwn(handlers, op.operationId)));
      return Object.keys(implemented).length ? [[path, implemented]] : [];
    })),
  } : options.contract;
  const app = createRoutes(contract, handlers, options.authenticate);
  if (options.publishImplementedContract) app.get('/openapi.json', c => c.json({ ...contract, servers: [{ url: API_BASE_PATH }] }));
  app.use('/mcp', async (c, next) => { c.set('operation', 'mcp'); await next(); });
  app.route('/', createMcp(
    options.meter ?? unavailableKernelMeter, options.resolveMcpLease,
    options.tools ? registeredTools(options.db, options.tools.map(tool => tool.name)) : registeredTools(options.db),
    options.tools,
    { allowedOrigins: options.mcpAllowedOrigins },
  ));
  app.onError((error, c) => {
    logError(c.req.raw, c.get('operation') ?? 'apiRequest', error);
    return c.json({ status: 'unavailable' }, 503);
  });
  return app;
}
