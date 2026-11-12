"use client";
import { utc } from "../../lib/showcase-store";
import { useNow, useBudget, type Budget } from "./state";
import { cx, money, Pv } from "./ui";

const D = (ms: number) => { const m = Math.max(0, Math.round(ms / 60000)); const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m % 60} min` : `${m} min`; };

/* One bar for the whole hold: committed, spendable now, held back. This is where $10 versus $7 is made plain. */
function Ladder({ b }: { b: Budget }) {
  const lim = b.spendable != null;
  if (b.mode === "loading") return <div className="card d0"><p className="dim">Reading the live hold…</p></div>;
  const back = lim ? b.free - b.spendable! : 0;
  const seg = [{ k: "c", v: b.committed, l: "Committed", c: "var(--water2)" }, { k: "s", v: lim ? b.spendable! : b.free, l: lim ? "Spendable now" : "Free", c: "var(--water)" }, ...(lim ? [{ k: "h", v: back, l: b.mode === "ended" ? "Unspendable" : "Held back", c: "var(--saf)" }] : [])];
  return (
    <div className="card d0">
      <div className="ladder" role="img" aria-label={seg.map(x => `${x.l} ${money(x.v)}`).join(", ")}>
        {seg.map(x => <div key={x.k} style={{ flexGrow: Math.max(x.v, 0), background: x.c }} />)}
      </div>
      <div className="lg">
        {seg.map(x => <div key={x.k}><small><i style={{ background: x.c }} />{x.l}</small><span className="num">{money(x.v)}</span></div>)}
        <div><small><i style={{ background: "var(--n4)", boxShadow: "inset 0 0 0 1px var(--faint)" }} />Held at PayPal</small><span className="num">{money(b.cap)}</span></div>
      </div>
      <p className="note">{b.mode === "ended" ? "The spending window has ended. The journal still shows the hold balance and commitments." : b.unsettled != null ? <>The gateway allows up to <b>{money(b.unsettled)}</b> in unsettled commitments. Settlement can make room under that limit. Paid calls still have to fit the free hold balance.</> : <>The hold is {money(b.cap)}. This API read did not include a spend limit, so only free money is shown.</>}</p>
    </div>
  );
}

function Lifespan({ b }: { b: Budget }) {
  const now = useNow(30000);
  if (!b.honor || !b.expires || !b.granted) return null;
  const t0 = Date.parse(b.granted), t1 = Date.parse(b.honor), t2 = Date.parse(b.expires);
  if ([t0, t1, t2].some(Number.isNaN) || t2 <= t0) return null;
  const pc = (t: number) => Math.max(0, Math.min(100, (t - t0) / (t2 - t0) * 100));
  const left = t1 - now;
  return (
    <div className="card d0 life">
      <div className="life-bar" role="img" aria-label="Guaranteed window, then open window, with the current time marked">
        <i style={{ width: `${pc(t1)}%`, background: "var(--water)" }} /><i style={{ width: `${100 - pc(t1)}%` }} className="hatch" /><span className="nowtick" style={{ left: `${pc(now)}%` }} />
      </div>
      <div className="life-cols">
        <div><small><i style={{ background: "var(--water)" }} />Guaranteed by PayPal</small><span className="num">{utc(b.granted)} to {utc(b.honor)}</span><span className="dim">{left > 0 ? `${D(left)} left. Spending stops when it ends.` : "Ended. Spending is off."}</span></div>
        <div><small><i className="hatch" />Open, not guaranteed</small><span className="num">until {utc(b.expires)}</span><span className="dim">PayPal may still capture, but the gateway no longer accepts new calls.</span></div>
      </div>
    </div>
  );
}

function Journal({ b }: { b: Budget }) {
  if (b.entries.length === 0) return <div className="tape"><div className="tape-e">{b.mode === "loading" ? "Reading the journal…" : b.mode === "recorded" ? "The live journal is not available. Recorded run: use the checks above." : "No journal rows yet."}</div></div>;
  let gi = 0, last = "";
  return (
    <div className="tape" role="table" aria-label="Journal rows from the live hold">
      {b.entries.map((e, i) => { if (e.group !== last) { last = e.group; gi++; } return (
        <div key={i} className={cx("jr", gi % 2 === 0 && "g2")} role="row"><span className="gp" role="cell">{e.group.length > 12 ? e.group.slice(0, 8) : e.group}</span><span className="a" role="cell">{e.account}</span><span className="dc" role="cell">{e.dir === "D" ? "debit" : e.dir === "C" ? "credit" : e.dir}</span><span className="amt" role="cell">{money(e.amount)}</span></div>
      ); })}
    </div>
  );
}

export function Grant() {
  const b = useBudget();
  const src = b.mode === "live" ? <Pv k={b.stale ? "last" : "live"} /> : b.mode === "recorded" ? <Pv k="recorded" /> : null;
  return (
    <section className="stage" id="s1">
      <div className="stage-h"><span className="stage-n">1</span><h2>You grant a hold. <em>That is the budget.</em></h2></div>
      <p className="stage-lede">One PayPal authorization sets the ceiling. The gateway writes down every move against it.</p>
      <div className="blk"><h3>Where the {b.mode === "loading" ? "hold" : money(b.cap)} sits {src}</h3><Ladder b={b} /></div>
      {b.mode !== "recorded" && <div className="blk"><h3>The permission has a lifespan {src}</h3><Lifespan b={b} /></div>}
      <div className="blk"><h3>Every move is two journal rows {src}</h3><Journal b={b} /><p className="note">Double entry: each group debits one account and credits another by the same amount, so the books cannot drift from the vessel.</p></div>
    </section>
  );
}
