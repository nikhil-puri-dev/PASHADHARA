"use client";
import { Fleet } from "./fleet";
import { Held } from "./held";
import { Hero } from "./hero";
import { ProofRow, SiteFooter } from "./proof-truths";
import { V3Shell } from "./shell";
import { useBudget } from "./state";

function Body() {
  const b = useBudget();
  return <>
    <Hero b={b} />
    <Held b={b} />
    <Fleet />
    <ProofRow />
    <SiteFooter />
  </>;
}

export function Landing() { return <V3Shell view="landing"><Body /></V3Shell>; }
