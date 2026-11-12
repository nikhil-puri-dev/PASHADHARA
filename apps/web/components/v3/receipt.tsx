import type { ReactNode } from "react";
import s from "../../app/v3.module.css";
import { cx } from "./bits";

export function Receipt({ refused, head, amount, rows }: { refused: boolean; head: [string, string]; amount: string; rows: [string, ReactNode][] }) {
  return (
    <div className={cx(s.rcpt, refused && s.ref)} role="status">
      {refused && <div className={s.stamp}>REFUSED</div>}
      <div className={s.hd}><span>{head[0]}</span><span>{head[1]}</span></div>
      <div className={s.amt} style={refused ? { color: "var(--red-d)" } : undefined}>{amount}</div>
      {rows.map(([k, v]) => <div className={s.row} key={k}><span>{k}</span><span className={s.num}>{v}</span></div>)}
    </div>
  );
}
