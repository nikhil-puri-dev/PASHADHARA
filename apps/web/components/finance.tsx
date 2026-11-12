"use client";
import Link from "next/link";
import run from "./v5/agent-run.json";
import { Pv } from "./v5/ui";
import { Shell, Source } from "./site";

const D = (c: number) => `$${(c / 100).toFixed(2)}`;

/* The finance agent: three recorded sandbox runs, newest first. Each row says what was real and what was fixture.
   Figures come from docs/runs/finance-investigation-2026-11-12.md and evidence/finance-*.json; nothing here is live. */
export function Finance() {
  const S = run.settlement, P = run.paypal;
  return (
    <Shell route="finance">
      <div className="page">
        <div className="pagehead">
          <p className="eyebrow">Finance agent · recorded runs, 12 Nov 2026</p>
          <h1>An agent that buys evidence, within a hold.</h1>
          <p>A model reviews pairs of invoices for duplicate payments. Looking up payment evidence costs money, so it has to choose what is worth buying. The invoice and payment data is synthetic. The PayPal holds, the captures and the model calls were real sandbox calls.</p>
        </div>

        <section className="panel">
          <div className="cap"><span>Run 3 · a {D(run.hold)} hold, settled</span><span><Pv k="recorded" /> <Pv k="measured" /> <Pv k="fixture">invoice data</Pv></span></div>
          <div className="body">
            <p>The agent asked the free <span className="mono">check_budget</span> about the {D(20)} bundle, found it affordable, and still chose five {D(2)} lookups (pairs B, C, I, K, J). It spent {D(10)} and never met a refusal. The operator then captured the five commitments once.</p>
            <dl className="kv">
              <dt>Captured · PayPal GET</dt><dd>{D(S.captured)} ({P.capture.status})</dd>
              <dt>PayPal fee · PayPal GET</dt><dd>{D(S.fee)}, the whole capture</dd>
              <dt>Authorization · PayPal GET</dt><dd>{P.authorization.status}, USD {P.authorization.amount}</dd>
              <dt>Journal · computed</dt><dd>{S.receipts} receipts, {S.groups} groups, {S.allocations} allocations</dd>
              <dt>Answer scored</dt><dd>{run.result.score}, on synthetic labels</dd>
            </dl>
            <Source>Allowlisted from evidence/finance-sandbox-run2 and proof2, PayPal reads at {P.readAt.slice(11, 16)} UTC. The other {D(run.hold - S.captured)} stayed an open authorization; it was not voided. One nondeterministic sample, no advantage over the baselines is claimed. <Link href="/#s2">Replay it</Link></Source>
          </div>
        </section>

        <section className="panel">
          <div className="cap"><span>Run 2 · a {D(16)} hold</span><span><Pv k="recorded" /> <Pv k="measured" /></span></div>
          <div className="body">
            <p>Twelve invoice pairs. The agent bought five {D(2)} lookups ({D(10)}) and scored 9 of 12 on synthetic labels (5 of 8 on the held-out pairs). A separate probe tried a {D(20)} bundle against what was left: refused, <span className="mono">cap_reached</span>, no rows added. A repeat of the first paid lookup came back as a free replay.</p>
            <Source>A PayPal GET of the authorization matched the local row (status CREATED, USD 0.16). The {D(10)} are journal commitments. No capture, no payout, no PayPal call per tool. The model did not hit the cap on its own, so the refusal was probed directly.</Source>
          </div>
        </section>

        <section className="panel">
          <div className="cap"><span>Run 1 · a {D(6)} hold</span><span><Pv k="recorded" /> <Pv k="measured" /></span></div>
          <div className="body">
            <p>Four invoice pairs. The agent asked for a {D(7)} bundle first. The kernel refused it before any provider was called and wrote no ledger commitment. The agent then adapted and chose three {D(2)} lookups (A, B, C).</p>
            <Source>Its final answer was cut off by an output limit and a separate model call rebuilt the review queue from the recorded results. That weakness was fixed afterward: the answer is now a strict tool call. The run had no capture. <a href="/finance-paypal-trace.jsonl">Read the trace</a> · <a href="/finance-paypal-proof.json">proof file</a></Source>
          </div>
        </section>

        <section className="panel">
          <div className="cap"><span>Limits</span><span>Read before citing</span></div>
          <div className="body">
            <p>Each run is one sample from a model that is not deterministic. Twelve synthetic pairs are not an accuracy benchmark. Model cost is an estimate at assumed rates. The finance tools are not in the public MCP catalog on the deployed site; only <span className="mono">summarise</span> and <span className="mono">check_budget</span> are. <Link href="/proof">PayPal evidence</Link></p>
          </div>
        </section>
      </div>
    </Shell>
  );
}
