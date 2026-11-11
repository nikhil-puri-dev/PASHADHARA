import assert from "node:assert/strict";
import { CAP, decide, initial, money, quotes, remaining, total } from "../lib/delegation.ts";

assert.equal(money(remaining(initial)), "$2,235.00");
assert.equal(total(initial) + remaining(initial), CAP);
const by = id => quotes.find(q => q.id === id);

const overCap = decide(initial, by("dataset"));
assert.equal(overCap.decision.outcome, "refused");
assert.match(overCap.decision.reason, /remaining authority/);
assert.equal(overCap.next.commitments.length, initial.commitments.length);

const overExposure = decide(initial, by("research"));
assert.equal(overExposure.decision.outcome, "refused");
assert.match(overExposure.decision.reason, /outstanding exposure/);
assert.equal(total(overExposure.next), total(initial));

const overRequest = decide(initial, by("analysis"));
assert.equal(overRequest.decision.outcome, "refused");
assert.match(overRequest.decision.reason, /per-request ceiling/);
assert.equal(total(overRequest.next), total(initial));

const allowed = decide(initial, by("audit"));
assert.equal(allowed.decision.outcome, "admitted");
assert.equal(money(remaining(allowed.next)), "$1,815.00");
assert.equal(total(allowed.next) + remaining(allowed.next), CAP);
assert.equal(allowed.next.commitments.at(-1).amount, 42_000n);

const after = decide(allowed.next, by("screen"));
assert.equal(after.decision.outcome, "refused");
assert.equal(total(after.next), total(allowed.next));
console.log("PASS delegation: cap, exposure, accepted journal posting, conservation, refusal has no posting");
