"use client";
import { About } from "./About";
import { Connect } from "./Connect";
import { Grant } from "./Grant";
import { Hero } from "./Hero";
import { V5Shell } from "./Shell";
import { Settle } from "./Settle";
import { Spend } from "./Spend";
import { Why } from "./Why";

/* The whole financial journey on one page: hold, spend and refuse, settle, connect. One instrument stays beside it. */
export function Journey() {
  return <V5Shell><Hero /><Why /><Grant /><Spend /><Settle /><Connect /><About /></V5Shell>;
}
