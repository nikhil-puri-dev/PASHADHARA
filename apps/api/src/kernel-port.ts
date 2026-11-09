/** Implementations must use atomic transactions and the final contract v0.5 rules. */
export interface KernelPort {
  /** Upsert by (eventId, verified), incrementing deliveries only. Return the immutable stored payload for verified rows. Never process the unverified row. */
  recordWebhook(eventId: string, event: unknown, verified: boolean): Promise<unknown>;
  /** Atomically claim an unprocessed verified event. Distinguish active work from completed delivery. */
  claimWebhook(eventId: string): Promise<'claimed' | 'processed' | 'busy'>;
  /** Persist the freshly read PayPal response and reconcile it transactionally. */
  reconcileWebhook(eventId: string, resource: { kind: 'capture' | 'authorization'; id: string }, response: unknown): Promise<void>;
  /** Release a failed claim without marking the event processed. */
  releaseWebhook(eventId: string): Promise<void>;
}
