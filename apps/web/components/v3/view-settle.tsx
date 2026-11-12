"use client";
import { useState } from "react";
import s from "../../app/v3.module.css";
import sp from "../settlement-proof.json";
import { cx } from "./bits";
import type { Fx } from "./state";
import { Thurible } from "./thurible";

/* Settle: one recorded sandbox run on a $10.00 hold. Every figure is read from settlement-proof.json
   (an allowlisted copy of evidence/settlement-sandbox-20261112.json). Each line carries its tag.
   The step 3 refusal amount is the design's example and is tagged replay. */
type T = "measured" | "computed" | "replay";
const D = (c: number) => `$${(c / 100).toFixed(2)}`;
const toC = (v: string) => Math.round(Number(v) * 100);

const HOLD = toC(sp.measured.authorization.amount);
const GROSS = sp.computed.journal_minor.CAPTURED_GROSS;
const FEE = sp.computed.journal_minor.PAYPAL_FEES;
const REL = sp.computed.journal_minor.RELEASED;
const NET = GROSS - FEE;
const FREE = HOLD - GROSS;
const OVER = FREE + 1;

type Step = { free: number; committed: number; fee?: number; released?: number; caption: string; led: [string, string, T[]][]; tot: [string, string, T]; labels: [string, string]; fx: "pour" | "steam" | null };
const STEPS: Step[] = [
  { free: HOLD, committed: 0, caption: `You approve a ${D(HOLD)} hold. That amount is the whole budget.`, led: [["Hold approved", D(HOLD), ["measured"]]], tot: ["Free to spend", D(HOLD), "computed"], labels: ["Free", "Committed"], fx: null },
  { free: FREE, committed: GROSS, caption: `Calls commit against the hold. ${D(GROSS)} is committed and ${D(FREE)} is still free. These three commitments are kernel fixtures, no model ran.`, led: [["Hold approved", D(HOLD), ["measured"]], ["Committed by calls", D(GROSS), ["computed"]]], tot: ["Free to spend", D(FREE), "computed"], labels: ["Free", "Committed"], fx: "pour" },
  { free: FREE, committed: GROSS, caption: `A call for ${D(OVER)} cannot fit in ${D(FREE)}. It is refused, the tool never starts, $0.00 is charged.`, led: [["Free to spend", D(FREE), ["computed"]], ["Call attempted", D(OVER), ["replay"]], ["Charged", "$0.00", ["computed"]]], tot: ["Result", "cap_reached", "replay"], labels: ["Free", "Committed"], fx: "steam" },
  { free: 0, committed: NET, fee: FEE, released: REL, caption: `PayPal captured the ${D(GROSS)} that was used and kept ${D(FEE)} as its fee, leaving ${D(NET)}. The other ${D(REL)} was released and the authorization is ${sp.measured.authorization.status.toLowerCase()}.`, led: [["Captured", D(toC(sp.measured.capture.amount)), ["measured"]], ["PayPal fee", D(toC(sp.measured.capture.paypal_fee)), ["measured"]], ["Left after the fee", D(NET), ["computed"]], ["Released back", D(REL), ["computed"]]], tot: [GROSS + REL === HOLD ? "Hold fully accounted" : "Does not add up to the hold", D(GROSS + REL), "computed"], labels: ["Free", "After fee"], fx: null },
];
const NAMES = ["Approve", "Spend", "Refuse", "Settle"];

export function SettleView() {
  const [i, setI] = useState(0);
  const [fx, setFx] = useState<Fx>({ n: 0, kind: "pour", price: null });
  const st = STEPS[i]!;
  const go = (k: number) => { setI(k); const f = STEPS[k]!.fx; if (f) setFx(p => ({ n: p.n + 1, kind: f, price: null })); };
  return (
    <section aria-labelledby="set-h">
      <div className={s.mh}><h2 id="set-h" className={s.mhT}>Settle</h2><span className={cx(s.tag, s.dm)}>recorded sandbox run, {D(HOLD)} hold · each line is tagged</span></div>
      <div className={s.steps} role="group" aria-label="Steps">
        {NAMES.map((n, k) => <button key={n} className={s.step} type="button" aria-pressed={i === k} onClick={() => go(k)}>{n}</button>)}
      </div>
      <div className={s.bgrid}>
        <div>
          <Thurible id="S" levels={{ cap: HOLD, free: st.free, committed: st.committed, ...(st.fee ? { fee: st.fee } : {}), ...(st.released ? { released: st.released } : {}) }} fx={fx} />
          <div className={s.read}>
            <div><small><i style={{ background: "hsl(188 58% 42%)" }} />{st.labels[0]}</small><div className={s.num}>{D(st.free)}</div></div>
            <div><small><i style={{ background: "hsl(188 62% 64%)" }} />{st.labels[1]}</small><div className={s.num}>{D(st.committed)}</div></div>
            <div><small><i style={{ background: "hsl(8 84% 58%)" }} />Refused</small><div className={s.num}>{i === 2 ? "1 (replay)" : 0}</div></div>
          </div>
        </div>
        <div>
          <p className={s.cap} aria-live="polite">{st.caption}</p>
          <div className={s.led}>
            {st.led.map(([k, v, tags]) => <div key={k}><span>{k}</span><b className={s.num}>{v}{tags.map(t => <span key={t} className={cx(s.tag, t !== "measured" && s.dm)}>{t}</span>)}</b></div>)}
            <div className={s.tot}><span>{st.tot[0]}</span><b className={s.num} style={{ fontSize: 20 }}>{st.tot[1]}<span className={cx(s.tag, st.tot[2] !== "measured" && s.dm)}>{st.tot[2]}</span></b></div>
          </div>
          <p className={s.srcNote}>Measured: PayPal GETs of one capture and one authorization on a sandbox hold. Computed: journal sums from the same run. The readout beside the thurible is computed from the same sums. Replay: the refused amount is the design's example, not a recorded call. {sp.fixture} The payout figure of $2.41 on the Escrow page is a different, measured run.</p>
        </div>
      </div>
    </section>
  );
}
