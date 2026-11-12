import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Database } from '../../../packages/kernel/src/db.ts';
import type { Authenticate } from './routes.ts';

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

type Scope = 'lease' | 'seller';
type Claims = { scope: Scope; id: string; exp: number };
const epochSeconds = () => Math.floor(Date.now() / 1000);
const leaseDays = 29;
export const leaseEnd = (created: Date) => Math.floor(created.getTime() / 1000) + leaseDays * 86400;
export const deriveKey = (secret: string, purpose: Scope | 'paypal-callback') =>
  createHmac('sha256', secret).update(`pashadhara/api/v1/${purpose}`).digest();
const mac = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest();
const digest = (value: string) => createHash('sha256').update(value).digest();
const sameId = (input: unknown, id: string) => typeof input === 'string' && input.toLowerCase() === id;
const bearer = (request: Request) => /^Bearer ([^\s,]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];

export function issueToken(secret: string, scope: Scope, id: string, exp = epochSeconds() + 30 * 86400) {
  if (!secret || !isUuid(id)) throw new Error('Token signing requires a configured secret and a valid subject');
  const payload = Buffer.from(JSON.stringify({ scope, id: id.toLowerCase(), exp: Math.min(exp, epochSeconds() + 30 * 86400) })).toString('base64url');
  return `${payload}.${mac(deriveKey(secret, scope), payload).toString('base64url')}`;
}

export function signatureMatches(expected: Buffer, signature: string) {
  if (!/^[\w-]{43}$/.test(signature)) return false;
  const decoded = Buffer.from(signature, 'base64url');
  return decoded.toString('base64url') === signature && timingSafeEqual(expected, decoded);
}

function verify(keys: Record<Scope, Buffer>, token: string): Claims | null {
  const parts = /^([\w-]{1,256})\.([\w-]{43})$/.exec(token);
  if (!parts) return null;
  const [, payload, signature] = parts;
  try {
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Claims;
    return (claims.scope === 'lease' || claims.scope === 'seller') && isUuid(claims.id)
      && Number.isSafeInteger(claims.exp) && claims.exp > epochSeconds()
      && signatureMatches(mac(keys[claims.scope], payload!), signature!) ? claims : null;
  } catch { return null; }
}

export function createAuth(db: Database, secret: string, adminKey: string) {
  const adminDigest = adminKey && digest(adminKey);
  const keys = { lease: deriveKey(secret, 'lease'), seller: deriveKey(secret, 'seller') };
  const leaseIsOpen = async (id: string) => db.transaction(null, async tx => Boolean((await tx.query(`
    select 1 from public.leases l
    where l.id=$1 and l.state in ('pending_approval','active')
      and not exists (select 1 from public.paypal_calls p where p.lease_id=l.id and p.op='void' and p.state='succeeded')
      and clock_timestamp() < l.created_at + $2::integer * interval '1 day'
      and clock_timestamp() < coalesce(
        (select max(a.expires_at) from public.authorizations a where a.lease_id=l.id), 'infinity'::timestamptz
      )`, [id, leaseDays])).rowCount));
  const scoped = (request: Request) => {
    const token = bearer(request);
    return secret && token ? verify(keys, token) : null;
  };
  const authenticate: Authenticate = async (requirements, request, operation, params, body) => {
    const token = bearer(request);
    if (!token) return null;
    const claims = secret ? verify(keys, token) : null;
    const fields = body as { lease_id?: unknown; seller_id?: unknown; job_id?: unknown } | undefined;
    for (const alternative of requirements) {
      const schemes = Object.keys(alternative);
      if (schemes.length !== 1) continue;
      const scheme = schemes[0];
      if (scheme === 'adminKey' && adminDigest && timingSafeEqual(adminDigest, digest(token))) return { scope: 'admin' };
      if (!claims || scheme !== (claims.scope === 'lease' ? 'leaseToken' : 'sellerKey')) continue;
      const owns = (id: unknown) => id === undefined || sameId(id, claims.id);
      if (claims.scope === 'lease' && (!owns(params.leaseId) || !owns(fields?.lease_id)
        || params.sellerId !== undefined || (operation !== 'createJob' && fields?.seller_id !== undefined))) continue;
      if (operation === 'callTool' && !sameId(request.headers.get('X-Pashadhara-Lease'), claims.id)) continue;
      if (claims.scope === 'seller' && (!owns(params.sellerId) || !owns(fields?.seller_id)
        || params.leaseId !== undefined || fields?.lease_id !== undefined)) continue;
      if (fields?.job_id !== undefined && (!isUuid(params.jobId) || !sameId(fields.job_id, params.jobId.toLowerCase()))) continue;
      if (params.jobId) {
        const owner = claims.scope === 'lease' ? 'lease_id' : 'seller_id';
        const owned = await db.transaction(null, tx => tx.query(
          `select 1 from public.jobs where id=$1 and ${owner}=$2`, [params.jobId, claims.id],
        ));
        if (!owned.rowCount) continue;
      }
      if (claims.scope === 'lease' && !await leaseIsOpen(claims.id)) continue;
      return claims;
    }
    return null;
  };
  return {
    authenticate,
    async resolveMcpLease(request: Request) {
      const claims = scoped(request);
      return claims?.scope === 'lease' && await leaseIsOpen(claims.id) ? claims.id : null;
    },
  };
}
