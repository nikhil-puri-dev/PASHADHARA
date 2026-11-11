import type { Database } from '../../../packages/kernel/src/db.ts';
import { createRoutes, type Authenticate, type Contract, type RouteHandler } from './routes.ts';
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
}) {
  const handlers = { ...readHandlers(options.db), ...options.handlers };
  if (options.webhook) handlers.receivePayPalWebhook = webhookHandler(options.webhook);
  const app = createRoutes(options.contract, handlers, options.authenticate);
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
