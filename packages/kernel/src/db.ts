import pg, { type PoolClient, type QueryResultRow } from 'pg';

export type LeaseState = 'pending_approval' | 'active' | 'closed' | 'expired' | 'failed';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Tx = PoolClient;

export async function one<T extends QueryResultRow>(db: Tx, sql: string, values: unknown[]): Promise<T> {
  const row = (await db.query<T>(sql, values)).rows[0];
  if (!row) throw new Error('Kernel record not found or no longer in the required state');
  return row;
}

export function sqlState(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

export class Database {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    const url = new URL(connectionString);
    const sessionPooler = /^(?:aws|gcp)-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) &&
      url.port === '5432' && /^kernel_login\.[a-z0-9]{20}$/.test(url.username) &&
      [...url.searchParams.keys()].every(key => key === 'sslmode');
    if (url.username !== 'kernel_login' && !sessionPooler) {
      throw new Error('Kernel requires a direct Postgres connection as kernel_login');
    }
    this.pool = new pg.Pool({ connectionString });
  }

  end() {
    return this.pool.end();
  }

  async transaction<T>(leaseId: string | null, work: (db: Tx, state: LeaseState | null) => Promise<T>, isolation: 'read committed' | 'repeatable read' = 'read committed'): Promise<T> {
    if (leaseId !== null && isolation !== 'read committed') throw new Error('Lease writes require read committed isolation');
    for (let attempt = 0; ; attempt++) {
      const db = await this.pool.connect();
      let discard = false;
      try {
        await db.query(`begin isolation level ${isolation}`);
        await db.query('set local role pashadhara_app');
        await db.query("set local time zone 'UTC'");
        const identity = await one<{ session_user: string; current_user: string }>(
          db, 'select session_user, current_user', [],
        );
        if (identity.session_user !== 'kernel_login' || identity.current_user !== 'pashadhara_app') {
          throw new Error('Unexpected kernel database identity');
        }
        const state = leaseId === null ? null : (await one<{ state: LeaseState }>(
          db, 'select public.lock_lease($1) as state', [leaseId],
        )).state;
        const result = await work(db, state);
        await db.query('commit');
        return result;
      } catch (error) {
        try {
          await db.query('rollback');
        } catch {
          discard = true;
        }
        if (discard || sqlState(error) !== '40001' || attempt === 3) throw error;
      } finally {
        db.release(discard);
      }
    }
  }
}
