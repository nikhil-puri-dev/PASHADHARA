"use client";
import { runApi, RUN, useRun } from "./run";
import { cx, money, Pv } from "./ui";

/* A replay of one real agent run (12 Nov 2026). Real model, real sandbox hold, synthetic invoice data.
   The vessel beside it moves only while this view is selected. Nothing here is live. */
export function AgentRun() {
  const r = useRun();
  const done = r.step >= RUN.steps.length;
  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>A <b>{RUN.model}</b> agent was given a {money(RUN.hold)} sandbox hold and a pile of invoice pairs to review. This is what its trace says it did, one step at a time. <Pv k="recorded">recorded {RUN.date}</Pv></p>
      <div className="runbar">
        {r.playing ? <button className="btn pri" type="button" onClick={runApi.pause}>Pause</button> : <button className="btn pri" type="button" onClick={runApi.play}>{r.step === 0 ? "Play the replay" : done ? "Play again" : "Resume"}</button>}
        <button className="btn" type="button" disabled={done} onClick={runApi.next}>Next step</button>
        <button className="btn" type="button" disabled={r.step === 0} onClick={runApi.restart}>Restart</button>
        <span className="num dim">{r.step} of {r.total}</span>
      </div>
      <ol className="trace" aria-label="Recorded agent run">
        {RUN.steps.map((s, i) => {
          const st = i < r.step ? "done" : i === r.step ? "next" : "";
          return (
            <li key={i} className={cx(st, s.kind)} aria-current={i === r.step - 1 ? "step" : undefined}>
              {s.kind === "call" ? <><span><b>{s.tool}</b><span className="d">{s.why}</span></span><em>{money(s.price ?? 0)} · served · {s.ms} ms</em></>
                : s.kind === "think" ? <><span><b>{s.title}</b></span><em>model, {((s.ms ?? 0) / 1000).toFixed(1)} s</em></>
                : s.kind === "preflight" ? <><span><b>{s.title}</b><span className="d">{s.detail}</span></span><em>free</em></>
                : <><span><b>{s.title}</b>{s.detail && <span className="d">{s.detail}</span>}</span><em>{s.kind === "settle" ? `${money(RUN.settlement.captured)} captured` : ""}</em></>}
            </li>
          );
        })}
      </ol>
      {r.reconciled && <div className="verdict good" style={{ marginTop: 12 }}><span className="v1">Books match PayPal</span><span className="v2">{RUN.settlement.receipts} receipts, {RUN.settlement.groups} journal groups, 1 capture, {RUN.settlement.allocations} allocations. PayPal reads: authorization {RUN.paypal.authorization.status}, capture {RUN.paypal.capture.status}. <a className="src" href="#s3">Details in step 3</a></span><div className="v3"><Pv k="measured" /></div></div>}
      <p className="note">Its answer scored {RUN.result.score}. {RUN.result.note} Model cost about ${RUN.usage.costUsdEstimate.toFixed(3)}, an estimate at assumed rates ({RUN.usage.requests} requests, {(RUN.usage.wallMs / 1000).toFixed(0)} s). The model asked for lookups B, C, I and K in one turn; the replay shows them one by one. The agent chose five {money(2)} lookups over the {money(20)} bundle, so it never met a refusal. <Pv k="fixture">invoice data is synthetic</Pv></p>
    </>
  );
}
