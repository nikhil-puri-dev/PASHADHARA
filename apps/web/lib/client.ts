import type { components, operations } from "./contract";

export type Schema<K extends keyof components["schemas"]> = components["schemas"][K];

type Ok<T> = T extends { responses: { 200: { content: { "application/json": infer Result } } } } ? Result : never;

export interface LeaseReader {
  lease(id: string): Promise<Ok<operations["getLease"]>>;
  journal(id: string, after?: number): Promise<Ok<operations["getJournal"]>>;
  captures(id: string): Promise<Ok<operations["listCaptures"]>>;
  job(id: string): Promise<Ok<operations["getJob"]>>;
  proof(id: string): Promise<Ok<operations["getProof"]>>;
}

export function apiClient(baseUrl: string, token: string, transport = fetch) {
  async function read<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await transport(new URL(path, baseUrl), {
      cache: "no-store",
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...init?.headers },
    });
    if (!response.ok) throw new Error(`PASHADHARA API returned HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  const leasePath = (id: string) => `/v1/leases/${encodeURIComponent(id)}`;
  return {
    lease: id => read(leasePath(id)),
    journal: (id, after) => read(`${leasePath(id)}/journal${after === undefined ? "" : `?after=${after}`}`),
    captures: id => read(`${leasePath(id)}/captures`),
    job: id => read(`/v1/jobs/${encodeURIComponent(id)}`),
    proof: id => read(`${leasePath(id)}/proof`),
    settle: (id: string, body: NonNullable<operations["settleLease"]["requestBody"]>["content"]["application/json"]) =>
      read<Ok<operations["settleLease"]>>(`${leasePath(id)}/settle`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }),
  } satisfies LeaseReader & { settle: unknown };
}
