/**
 * Evaluation labels. Withheld: never put it in a prompt or a tool. The agent script imports the scorer (which imports this file) only to score its own output after it has finished.
 * Written by the author, then checked against a blind label from a separate model that saw only the records and evidence
 * (see docs/runs/finance-eval-2026-11-12.md). 'ambiguous' means the evidence does not settle it, so abstaining is correct.
 */
export type Label = 'duplicate' | 'not_duplicate' | 'ambiguous';
export const labels: Record<string, Label> = {
  A: 'duplicate', B: 'not_duplicate', C: 'duplicate', D: 'not_duplicate',
  E: 'not_duplicate', F: 'duplicate', G: 'not_duplicate', H: 'duplicate',
  I: 'not_duplicate', J: 'not_duplicate', K: 'duplicate', L: 'ambiguous',
};
/** Development pairs were visible while the fixtures were designed; held-out pairs were added afterwards. */
export const split: Record<string, 'dev' | 'heldout'> = Object.fromEntries(Object.keys(labels).map(p => [p, 'ABCD'.includes(p) ? 'dev' : 'heldout']));
