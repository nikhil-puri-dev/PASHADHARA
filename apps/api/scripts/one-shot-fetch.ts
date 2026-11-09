import { request as httpsRequest } from 'node:https';

/** Node's fetch can transparently retry HTTP 421. Make one wire request per counted dispatch. */
export function oneShotFetch(input: string | URL | Request, init?: RequestInit, request = httpsRequest): Promise<Response> {
  const url = new URL(String(input));
  if (init?.body != null && typeof init.body !== 'string') throw new TypeError('Expected a text request body');
  const body = init?.body ?? undefined;
  const headers = new Headers(init?.headers);
  if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)));
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: init?.method, headers: Object.fromEntries(headers), signal: init?.signal ?? undefined, agent: false,
    }, incoming => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2_000_000) incoming.destroy(new Error('Provider response too large'));
        else chunks.push(chunk);
      });
      incoming.once('error', reject);
      incoming.once('end', () => {
        if (!incoming.complete || !incoming.statusCode) return reject(new Error('Incomplete provider response'));
        try {
          resolve(new Response(size ? Buffer.concat(chunks) : null, { status: incoming.statusCode }));
        } catch (error) { reject(error); }
      });
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}
