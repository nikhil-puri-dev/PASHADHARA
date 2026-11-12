"use client";
import Link from "next/link";
import { useState } from "react";
import { cents, feeFor, hold, usd, utc, useShowcase } from "../lib/showcase-store";
import { recorded } from "../lib/recorded";
import proof from "./proof-evidence.json";
import boundary from "./boundary-record.json";
import sandboxProof from "./finance-sandbox-proof.json";
import { HoldNotice, Pill, Shell, Source, useNow } from "./site";

const fixed = (n: number) => `$${(n / 100).toFixed(2)}`;
const day = (iso: string) => { const d = new Date(iso + (iso.length === 10 ? "T00:00:00Z" : "")); return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`; };

/* ---------------- Collect ---------------- */
export function Collect() {
  const s = useShowcase();
  const h = hold(s.data, useNow(60_000));
  const f = proof.fees;
  const caps = s.data?.captures ?? [];
  const spent = h?.spent ?? null;
  const captureInFlight = caps.some(c => ["intent", "pending", "unknown"].includes(c.status ?? ""));
  const now = !captureInFlight && spent != null && spent > 0 ? { fee: feeFor(spent), net: spent - feeFor(spent) } : null;
  return (
    <Shell route="collect">
      <div className="page">
        <div className="pagehead"><h1>Collect from the hold</h1><p className="muted">Spending is metered against the hold. The budget journal shows what was committed. PayPal capture is a separate step controlled by the owner.</p></div>
        <HoldNotice d={s.data} />
        {spent == null && <p role="status">{s.loading ? "Reading settlement records…" : "Current settlement data unavailable. The comparison below is from a separate run."}</p>}
        {spent != null && (
          <section className="panel">
            <div className="cap"><span>This hold</span><span>{s.data?.read_at ? `Read ${utc(s.data.read_at)}` : ""}</span></div>
            <div className="body">
              <h2>{s.failedAt ? "Last known settlement position" : captureInFlight ? "Verify the outstanding capture" : spent === 0 ? "Nothing to collect" : h?.state === "ended" ? "Review the closed hold" : "Review before collecting"}</h2>
              <dl className="kv" style={{ fontSize: "1rem" }}>
                <dt>Committed, awaiting capture · computed</dt><dd>{usd(spent)}</dd>
                {now && <><dt>Fee estimate on unsettled balance · computed</dt><dd>{usd(now.fee)}</dd><dt>{now.net < 0 ? "Fee is more than the amount, by" : "Left after the fee"}</dt><dd>{usd(Math.abs(now.net))}</dd></>}
                <dt>Captured · journal snapshot</dt><dd>{usd(h?.collected) || "Unavailable"}</dd>
              </dl>
              {captureInFlight && <div className="act">A capture is unresolved. The owner should read its PayPal state before retrying. The unsettled journal balance can include funds already allocated to that capture.</div>}
              {now && <div className="act">{h?.state === "ended" || s.failedAt ? "The owner should verify PayPal authorization and capture state before taking action." : now.net <= 0 ? "The estimated fee exceeds the commitment. The owner should review the window before deciding when to collect." : "The owner can compare the estimated net with the time left on the authorization."} <Link href="/budget">Review the hold</Link></div>}
              <Source>Commitments and captures are from the budget journal. The fee uses an observed sandbox rate, 0.49 plus 3.49% per capture. This page does not collect funds.</Source>
            </div>
          </section>
        )}
        {caps.length > 0 && (
          <section className="panel"><div className="cap"><span>Captures on this hold</span><span>{caps.length}</span></div>
            <div className="scroll"><table className="tbl"><thead><tr><th className="amt">Amount</th><th className="amt">PayPal fee</th><th>Status</th><th>Capture</th></tr></thead><tbody>
              {caps.map((c, i) => <tr key={c.id ?? i}><td className="amt">{usd(cents(c.amount_minor))}</td><td className="amt">{c.fee_minor != null ? usd(cents(c.fee_minor)) : ""}</td><td>{c.status ?? ""}</td><td className="mono">{c.paypal_capture_id ?? ""}</td></tr>)}
            </tbody></table></div></section>
        )}
        <section className="panel">
          <div className="cap"><span>Why batching matters</span><span>Recorded sandbox run, {day(f.date)}</span></div>
          <div className="body">
            <dl className="kv" style={{ fontSize: "1rem" }}>
              <dt>{f.rows.length} separate $1.00 captures · measured</dt><dd>fees {fixed(f.feeTotal)} ({Math.round((f.feeTotal / f.total) * 100)}%)</dd>
              <dt>1 batched {fixed(f.total)} capture · computed estimate</dt><dd>fee {fixed(f.singleCaptureEstimate)} ({((f.singleCaptureEstimate / f.total) * 100).toFixed(1)}%)</dd>
              <dt><strong>Estimated fee difference</strong></dt><dd><strong>{fixed(f.feeTotal - f.singleCaptureEstimate)}</strong></dd>
            </dl>
            <Source>The {fixed(f.feeTotal)} is measured: PayPal returned a fee on each of {f.rows.length} real sandbox captures. The {fixed(f.singleCaptureEstimate)} for one capture is computed from the same rate. <Link href="/proof#captures">See the {f.rows.length} captures</Link></Source>
          </div>
        </section>
      </div>
    </Shell>
  );
}

/* ---------------- Escrow ---------------- */
export function Escrow() {
  const e = proof.escrow;
  const job = e.decision.amount;
  return (
    <Shell route="escrow">
      <div className="page">
        <div className="pagehead"><span className="eyebrow">Escrow / Recorded PayPal sandbox · {day(e.date)} 2026</span><h1>{fixed(e.payout.amount)} reached the seller</h1><p className="muted">PayPal reported a successful payout after the database released the full job price.</p></div>
        <div className="statline" role="group" aria-label="Job money">
          <div><span className="eyebrow">Released · database decision</span><strong className="mono">{fixed(job)}</strong></div>
          <div><span className="eyebrow">Captured · measured</span><strong className="mono">{fixed(e.capture.amount)}</strong></div>
          <div><span className="eyebrow">Capture fee · measured</span><strong className="mono">{fixed(e.capture.fee)}</strong></div>
          <div><span className="eyebrow">Seller payout · measured</span><strong className="mono">{fixed(e.payout.amount)}</strong></div>
        </div>
        <section className="panel">
          <div className="cap"><span><Pill kind="wait">Recorded {day(e.date)}, not live</Pill> A real PayPal sandbox run.</span><Pill kind="ok">Released</Pill></div>
          <div className="body">
            <div className="checks">
              <div className="check"><span>Buyer set the rubric before delivery</span><span>100% of job price in the score band starting at 0, subject to both judges passing</span></div>
              {e.verdicts.map(v => <div className="check" key={v.provider}><span>{v.provider} judge</span><span className="mono">{v.verdict} · {v.score}</span></div>)}
              <div className="check"><span>Database decision, applying the buyer&apos;s rubric</span><span className="mono">release {fixed(job)}</span></div>
            </div>
            <div className="act ok">Captured {fixed(e.capture.amount)}, {e.capture.status}. Seller payout {e.payout.status}, {fixed(e.payout.amount)} after PayPal&apos;s {fixed(e.capture.fee)} fee.</div>
            <details>
              <summary>How judging works</summary>
              <p>When both judges pass, the kernel uses the lower score to select a band in the buyer’s rubric. In this run the buyer set a single band that paid 100% at any passing score. Both judges passed with 100 and the kernel released {fixed(job)}.</p>
              <p className="muted small" style={{ marginTop: 8 }}>The recorded PayPal payout GET reported a separate $0.25 processing fee. The journal records the seller payout of {fixed(e.payout.amount)}.</p>
            </details>
            <Source>PayPal capture response ({e.capture.id}), PayPal payout GET (SUCCESS), OpenAI and Anthropic judge verdicts, and the database decision. Recorded {day(e.date)}. <Link href="/proof#escrow">PayPal evidence</Link></Source>
          </div>
        </section>
      </div>
    </Shell>
  );
}

/* ---------------- Developers ---------------- */
const MCP = "https://pashadhara.vercel.app/api/mcp";
const FIRST_READ = `curl -fsS -H "Authorization: Bearer $BUDGET_TOKEN" https://pashadhara.vercel.app/api/v1/leases/$BUDGET_ID`;
const CONFIGS: Record<string, { label: string; code: string; note: string }> = {
  code: { label: "Claude Code", code: `claude mcp add --transport http pashadhara \\\n  ${MCP} \\\n  --header "Authorization: Bearer $BUDGET_TOKEN"`, note: "Adds the gateway as a remote MCP server." },
  json: { label: "Cursor", code: `{\n  "mcpServers": {\n    "pashadhara": {\n      "url": "${MCP}",\n      "headers": { "Authorization": "Bearer \${env:BUDGET_TOKEN}" }\n    }\n  }\n}`, note: "Add this to .cursor/mcp.json. Set BUDGET_TOKEN in Cursor’s environment before launching it." },
  rest: { label: "Read the hold (REST)", code: `curl -H "Authorization: Bearer $BUDGET_TOKEN" \\\n  https://pashadhara.vercel.app/api/v1/leases/$BUDGET_ID`, note: "Returns hold_available, committed_unsettled and total_captured." },
};

export function Developers() {
  const [tab, setTab] = useState("code");
  const [copied, setCopied] = useState<string | null>(null);
  const cfg = CONFIGS[tab] ?? CONFIGS.code!;
  const copy = async (key: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1500); } catch {} };
  return (
    <Shell route="developers">
      <div className="page">
        <div className="pagehead"><h1>Connect your agent</h1><p className="muted">The gateway is a remote MCP server. Your agent calls paid tools. Each call is checked against the hold before it runs.</p></div>
        <section className="panel developer-setup" id="setup">
          <div className="cap"><span>Set up</span><span>Sandbox</span></div>
          <div className="body">
            <div className="tabs" role="group" aria-label="Choose a client">
              {Object.entries(CONFIGS).map(([k, v]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{v.label}</button>)}
            </div>
            <h2>Approve a sandbox hold</h2>
            <p>The sandbox buyer approves a hold created by the owner. The owner issues the lease ID and scoped token. To try the shared demo, <Link href="/check">check a spend</Link> or <Link href="/review">replay a recorded decision</Link>.</p>
            <h2>{tab === "rest" ? "Read the authorized hold" : "Add the connection"}</h2>
            <pre tabIndex={0}><code>{cfg.code}</code></pre>
            <p className="muted small">{cfg.note}{tab === "json" ? <> <a href="https://cursor.com/docs/mcp#config-interpolation">Cursor configuration reference</a>.</> : " Set your credentials locally."}</p>
            <div className="row"><button className="btn pri" type="button" onClick={() => copy("cfg", cfg.code)}>{copied === "cfg" ? "Copied" : tab === "rest" ? "Copy request" : "Copy config"}</button></div>
            {tab !== "rest" && <><h2>Make a first read</h2><pre tabIndex={0}><code>{FIRST_READ}</code></pre><div className="row"><button className="btn" onClick={() => copy("read", FIRST_READ)}>{copied === "read" ? "Copied" : "Copy first request"}</button></div></>}
            <h2>Verify before spending</h2>
            <p>Look for <code>state: active</code> and <code>guaranteed_now: true</code>. The lease read shows the free hold balance in cents. List tools in your client to confirm prices and use <code>check_budget</code> to see whether a call fits. After a paid call, compare the receipt with the lease journal. If a response is lost, check the journal and retry only with the original idempotency key and identical inputs.</p>
          </div>
        </section>
        <section className="panel">
          <div className="cap"><span>Public MCP tools</span><span>Recorded discovery · 12 Nov 2026</span></div>
          <div className="scroll"><table className="tbl"><thead><tr><th>Tool</th><th className="amt">Price</th><th>Does</th></tr></thead><tbody>
            <tr><td className="mono">summarise</td><td className="amt">$0.03</td><td>Summarises supplied text</td></tr>
            <tr><td className="mono">check_budget</td><td className="amt">Free</td><td>Checks whether a paid call would fit the lease</td></tr>
          </tbody></table></div>
        </section>
        <section className="panel" id="renew">
          <div className="cap"><span>Renewing a hold</span></div>
          <div className="body"><p style={{ maxWidth: "64ch" }}>PayPal documents a 72 hour guarantee for an authorization. When it ends the gateway refuses paid calls on that hold by design, and the record stays readable. The owner approves a new hold as the sandbox buyer and points the demo at it. No visitor action can renew or release a hold.</p></div>
        </section>
      </div>
    </Shell>
  );
}

/* ---------------- Proof ---------------- */
export function Proof() {
  const s = useShowcase();
  const h = hold(s.data, useNow(60_000));
  const auth = recorded.find(r => r.kind === "authorization");
  const caps = recorded.filter(r => r.kind === "capture");
  const sp = sandboxProof;
  const [all, setAll] = useState(false);
  return (
    <Shell route="proof">
      <div className="page">
        <div className="pagehead"><span className="eyebrow">Sources and records</span><h1>Proof</h1><p className="muted">Match each decision to its source. PayPal responses, gateway calculations and fixture inputs are labeled separately.</p></div>
        <section className="panel" id="boundary-run">
          <div className="cap"><span>Invoice evidence run · {boundary.date}</span><Pill kind="n">Recorded sandbox</Pill></div>
          <div className="body">
            <h2>{usd(boundary.blocked.price)} request stopped at {usd(boundary.blocked.remaining)}</h2>
            <dl className="kv">
              <dt>Buyer authorization · measured</dt><dd>{usd(boundary.hold)} · PayPal GET, CREATED</dd>
              <dt>Gateway result · computed</dt><dd>Cap reached · $0.00 committed</dd>
              <dt>First allowed lookup · computed</dt><dd>{usd(boundary.served.price)} committed · {usd(boundary.served.remaining)} left</dd>
            </dl>
            <p>These are the records behind the prepared replay. Invoice data are fixtures. The blocked bundle returned no tool result. The agent later used three smaller lookups; its final answer was truncated.</p>
            <details><summary>Open evidence</summary><p><a href="/finance-paypal-trace.jsonl">Gateway and agent trace (JSONL)</a> · <a href="/finance-paypal-proof.json">PayPal GET fields and journal snapshot (JSON)</a></p></details>
            <Link href="/review">Back to the prepared run</Link>
          </div>
        </section>
        <section className="panel" id="limit-check">
          <div className="cap"><span>Live amount preview</span><Pill kind="n">Computed · no posting</Pill></div>
          <div className="body"><h2>What an amount check proves</h2><p>The gateway checks the amount against the free hold balance and unsettled spending limit at the time of the request. The check runs no tool, writes no journal entry and makes no PayPal request.</p><Link href="/check">Back to the check</Link></div>
        </section>
        <section className="panel" id="hold">
          <div className="cap"><span>The live demo hold</span><span>{s.data?.read_at ? `Read ${utc(s.data.read_at)}` : ""}</span></div>
          <div className="body">
            {h?.cap != null ? (
              <dl className="kv">
                {(h.paypalId || h.last4) && <><dt>PayPal authorization</dt><dd>{h.last4 ? `Ending in ${h.last4}` : h.paypalId}</dd></>}
                {h.cap != null && <><dt>Authorized amount</dt><dd>{usd(h.cap)} USD</dd></>}
                {h.honor && <><dt>Guaranteed until</dt><dd>{utc(h.honor)}</dd></>}
                {h.expires && <><dt>PayPal authorization expires</dt><dd>{utc(h.expires)}</dd></>}
                <dt>Hold state</dt><dd className="txt">{h.state}</dd>
              </dl>
            ) : <p className="muted">{s.loading ? "Reading the live hold..." : "The live read is not answering. Nothing is shown in its place."}</p>}
            <Source>Authorization id and times were stored from PayPal&apos;s response when the buyer approved. Balances on this hold are computed from our ledger. This page did not make a PayPal call.</Source>
          </div>
        </section>
        <section className="panel" id="reads">
          <div className="cap"><span>PayPal GET of a sandbox authorization</span><Pill kind="n">measured</Pill></div>
          <div className="body">
            <dl className="kv">
              <dt>Authorization</dt><dd>{sp.paypal_get.http_status === 200 ? `HTTP ${sp.paypal_get.http_status}, id matches the local row` : ""}</dd>
              <dt>Status</dt><dd>{sp.paypal_get.status}</dd>
              <dt>Amount</dt><dd>{sp.paypal_get.amount.value} {sp.paypal_get.amount.currency_code}</dd>
              <dt>Gateway refusal · computed</dt><dd className="txt">{sp.refusal_probe.reason}; paid rows unchanged ({sp.refusal_probe.served_before.n} before, {sp.refusal_probe.served_after.n} after)</dd>
            </dl>
            <Source>Recorded 12 Nov in a PayPal sandbox run on a $0.16 hold. The tool charges are local journal commitments. Nothing was captured on that hold. Allowlisted fields only.</Source>
          </div>
        </section>
        <section className="panel" id="captures">
          <div className="cap"><span>{caps.length} captures on one authorization</span><Pill kind="n">measured</Pill></div>
          <div className="scroll"><table className="tbl"><thead><tr><th>PayPal capture</th><th className="amt">Amount</th><th className="amt">PayPal fee</th><th>Status</th><th>Time</th></tr></thead><tbody>
            {(all ? caps : caps.slice(0, 3)).map(c => <tr key={c.id}><td className="mono">{c.id}</td><td className="amt">${c.amount}</td><td className="amt">${c.fee}</td><td>{c.status}</td><td className="mono">{utc(c.at)}</td></tr>)}
          </tbody></table></div>
          <div className="body">{caps.length > 3 && <button className="btn sm" onClick={() => setAll(v => !v)}>{all ? "Show fewer" : `Show all ${caps.length}`}</button>}<dl className="kv"><dt>Total captured</dt><dd>{fixed(proof.fees.total)}</dd><dt>Total fees</dt><dd>{fixed(proof.fees.feeTotal)}</dd></dl>
            <Source>PayPal capture responses, {day(proof.fees.date)}. The two totals are computed by summing these rows. {auth ? `A later PayPal GET of the authorization returned PayPal status "${auth.status}".` : ""}</Source></div>
        </section>
        <section className="panel" id="escrow">
          <div className="cap"><span>Escrow job, recorded {day(proof.escrow.date)}</span><Pill kind="n">measured</Pill></div>
          <div className="body">
            <dl className="kv"><dt>Capture</dt><dd>{proof.escrow.capture.id}</dd><dt>Captured</dt><dd>{fixed(proof.escrow.capture.amount)} · fee {fixed(proof.escrow.capture.fee)}</dd><dt>Seller payout</dt><dd>{proof.escrow.payout.status} · {fixed(proof.escrow.payout.amount)}</dd></dl>
            <Source>PayPal capture response and payout GET. <Link href="/escrow">Back to the job</Link></Source>
          </div>
        </section>
        <section className="panel">
          <div className="cap"><span>What PayPal refused, and what we have not tested</span></div>
          <div className="body">
            <ul style={{ paddingLeft: "1.2rem", display: "flex", flexDirection: "column", gap: 6 }}>
              <li>Capture of $20.00 after $12.00 on a $20.00 authorization: 422 MAX_CAPTURE_AMOUNT_EXCEEDED. PayPal&apos;s default overage limit is 115%, so this does not prove a 100% cap. Measured.</li>
              <li>Capture after the hold was released: 422 AUTHORIZATION_VOIDED. Measured.</li>
              <li>Reauthorize on day 0: 422 REAUTHORIZATION_TOO_SOON, &quot;only allowed once from Day 4 to Day 29&quot;. Measured.</li>
              <li>Not tested: reauthorize on day 4 or later, capture after day 3, webhook latency and order.</li>
            </ul>
            <Source>Request log of the sandbox spike, {day(proof.limits.date)}. Raw rows stay out of the repository because they hold account fields.</Source>
          </div>
        </section>
      </div>
    </Shell>
  );
}
