/** Implementations must use atomic transactions and the final contract v0.5 rules. */
export interface KernelPort {
  /** Upsert by (eventId, verified), incrementing deliveries only. Return the immutable stored payload for verified rows. Never process the unverified row. */
  recordWebhook(eventId: string, event: unknown, verified: boolean): Promise<unknown>;
  /** Skip completed events and prevent overlapping reads on the same instance. */
  claimWebhook(eventId: string): Promise<'claimed' | 'processed' | 'busy'>;
  /** Lock the verified event, persist the fresh PayPal read and reconcile in one transaction. */
  reconcileWebhook(eventId: string, resource: { kind: 'capture' | 'authorization'; id: string }, response: unknown, status?: number): Promise<void>;
  /** Release the in-process read claim. The database owns the processed marker. */
  releaseWebhook(eventId: string): Promise<void>;
}
