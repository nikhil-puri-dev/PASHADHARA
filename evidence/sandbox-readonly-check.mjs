import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const origin = 'https://api-m.sandbox.paypal.com';
const evidence = new URL('../evidence/sandbox-readonly-20261108.jsonl', import.meta.url);
const { PAYPAL_ENV, PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
let token;

const string = (value) => typeof value === 'string' ? value : undefined;
const amount = (value) => value && {
  currency_code: string(value.currency_code),
  value: string(value.value),
};

function project(body, operation) {
  if (operation === 'oauth') return { name: string(body.name ?? body.error) };
  const batch = body.batch_header;
  return {
    name: string(body.name),
    id: string(batch?.payout_batch_id ?? body.id),
    status: string(body.status),
    amount: amount(batch?.amount ?? body.amount),
    expiration_time: string(body.expiration_time),
    create_time: string(batch?.time_created ?? body.create_time),
    update_time: string(body.update_time),
    batch_status: string(batch?.batch_status),
    time_completed: string(batch?.time_completed),
    items: Array.isArray(body.items) ? body.items.map((item) => ({
      transaction_status: string(item?.transaction_status),
      errors: item?.errors ? { name: string(item.errors.name) } : undefined,
    })) : undefined,
  };
}

async function request(operation, path, options = {}, timeout = 15_000) {
  const method = options.method ?? 'GET';
  const at = new Date().toISOString();
  let status = null;
  let response = {};
  let transport_error;
  const signal = AbortSignal.timeout(timeout);
  try {
    const result = await fetch(origin + path, {
      ...options,
      redirect: 'error',
      signal,
    });
    status = result.status;
    try {
      const body = JSON.parse(await result.text()) ?? {};
      response = project(body, operation);
      if (operation === 'oauth' && result.ok) {
        token = string(body.access_token);
        if (!token) transport_error = 'missing_access_token';
      }
    } catch {
      transport_error = signal.aborted ? 'timeout' : 'invalid_response';
    }
  } catch {
    transport_error = signal.aborted ? 'timeout' : 'request_failed';
  }

  const line = JSON.stringify({
    label: 'measured', at, operation, method, path, status, response, transport_error,
  }, (_key, value) => {
    if (typeof value !== 'string') return value;
    for (const secret of [clientId, clientSecret, token]) {
      if (secret) value = value.replaceAll(secret, '[redacted]');
    }
    return value.includes('@') ? '[redacted]' : value;
  });
  appendFileSync(evidence, line + '\n');
  return JSON.parse(line);
}

async function main() {
  if (PAYPAL_ENV !== 'sandbox' || !clientId || !clientSecret) {
    console.error('Sandbox mode and both PayPal credentials are required.');
    process.exitCode = 1;
    return;
  }

  const sentinels = JSON.parse(readFileSync(new URL('./sentinels.json', import.meta.url), 'utf8'));
  const ids = Object.values(sentinels).map((sentinel) => sentinel.authorization_id);
  if (!ids.length || ids.some((id) => typeof id !== 'string' || !/^[A-Z0-9]+$/.test(id))) {
    throw new Error('Invalid sentinel IDs');
  }
  mkdirSync(new URL('../evidence/', import.meta.url), { recursive: true });

  for (let attempt = 0; attempt < 2 && !token; attempt++) {
    const result = await request('oauth', '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    console.log(JSON.stringify({
      label: 'measured', status: result.status, name: result.response.name ?? null,
    }));
  }
  if (!token) {
    process.exitCode = 1;
    return;
  }

  const headers = { Authorization: 'Bearer ' + token };
  for (const id of ids) {
    const result = await request('authorization', '/v2/payments/authorizations/' + id, { headers });
    if (result.status !== 200 || !result.response.status) process.exitCode = 1;
  }

  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    const started = performance.now();
    const timeout = Math.min(15_000, Math.max(1, Math.floor(deadline - started)));
    const result = await request('payout', '/v1/payments/payouts/EWN23HN7964XJ', { headers }, timeout);
    if (result.status >= 400) break;
    if (result.status === 200 && result.response.batch_status === 'SUCCESS') return;
    const wait = Math.max(0, 10_000 - (performance.now() - started));
    if (performance.now() + wait >= deadline) break;
    await sleep(wait);
  }
  process.exitCode = 1;
}

main().catch(() => {
  console.error('Sandbox check stopped because of a local configuration or evidence file error.');
  process.exitCode = 1;
});
