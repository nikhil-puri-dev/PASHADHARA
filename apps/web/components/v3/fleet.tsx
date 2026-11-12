import s from "../../app/v3.module.css";
import { cx } from "./bits";

/* Fleet graph. Topology is illustrative and labelled so. Agents, tools and the hold are drawn; no number is claimed. */
export function Fleet() {
  return (
    <section className={cx(s.sec, s.fleet, s.band0)} id="fleet" aria-labelledby="fleet-h">
      <div className={s.wrap}>
        <div className={s.flHead}><h2 id="fleet-h">Many agents. <em>One</em> end-stop.</h2><p>Every agent, tool and judge passes the same gateway. One pulse of spend stops at the gate.</p></div>
        <div className={s.graph}>
          <svg viewBox="0 0 1000 440" role="img" aria-label="Three agents connect through the Pashadhara gateway to tools, with the PayPal hold underneath. One pulse is stopped at the gateway.">
            <path className={s.pipe} d="M190 80 C 330 80, 330 210, 430 210" /><path className={s.pipe} d="M190 220 L 430 220" /><path className={s.pipe} d="M190 360 C 330 360, 330 230, 430 230" />
            <path className={s.pipe} d="M570 210 C 680 210, 700 80, 810 80" /><path className={s.pipe} d="M570 220 L 810 220" /><path className={s.pipe} d="M570 230 C 680 230, 700 360, 810 360" /><path className={s.pipe} d="M500 262 L 500 366" />
            <path className={s.pulse} d="M190 80 C 330 80, 330 210, 430 210" /><path className={cx(s.pulse, s.p2)} d="M190 220 L 430 220" /><path className={cx(s.pulse, s.bad, s.p3)} d="M190 360 C 330 360, 330 230, 430 230" />
            <path className={cx(s.pulse, s.p2)} d="M570 210 C 680 210, 700 80, 810 80" /><path className={cx(s.pulse, s.p3)} d="M570 220 L 810 220" />
            <g className={s.gN}><rect x="40" y="55" width="150" height="50" rx="3" /><text x="58" y="85">agent · research</text></g>
            <g className={s.gN}><rect x="40" y="195" width="150" height="50" rx="3" /><text x="58" y="225">agent · finance</text></g>
            <g className={s.gN}><rect x="40" y="335" width="150" height="50" rx="3" /><text x="58" y="365">agent · runaway</text></g>
            <g className={s.gGw}><rect x="430" y="170" width="140" height="92" rx="3" /><text x="452" y="206">PASHADHARA</text><text x="452" y="226">check · commit</text><text x="452" y="246">or refuse</text></g>
            <g className={s.gN}><rect x="810" y="55" width="150" height="50" rx="3" /><text x="828" y="85">tool · summarise</text></g>
            <g className={s.gN}><rect x="810" y="195" width="150" height="50" rx="3" /><text x="828" y="225">tool · lookup</text></g>
            <g className={s.gN}><rect x="810" y="335" width="150" height="50" rx="3" /><text x="828" y="365">judge · escrow</text></g>
            <g className={s.gH}><rect x="400" y="366" width="200" height="50" rx="3" /><text x="428" y="396">PayPal hold</text></g>
            <g><circle cx="378" cy="226" r="14" fill="#090507" stroke="#ea4a35" strokeWidth="2.6" /><path d="M371 219 L385 233 M385 219 L371 233" stroke="#ea4a35" strokeWidth="2.6" strokeLinecap="round" /></g>
          </svg>
        </div>
        <div className={s.key}><span><i style={{ background: "var(--tide)" }} />served, committed</span><span><i style={{ background: "var(--red)" }} />refused at the gate</span><span className={cx(s.tag, s.dm)}>Topology is illustrative</span></div>
      </div>
    </section>
  );
}
