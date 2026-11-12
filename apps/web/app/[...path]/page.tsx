import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Activity } from "../../components/activity";
import { Budget } from "../../components/budget";
import { Home } from "../../components/home";
import { Collect, Developers, Escrow, Proof } from "../../components/more";

/* Page titles; the root layout adds " | Pashadhara". */
const TITLES: Record<string, string> = {
  check: "Check a spend",
  review: "Recorded spending decision",
  budget: "Budget",
  activity: "Journal",
  collect: "Settle",
  escrow: "Escrow",
  developers: "Connect your agent",
  proof: "PayPal evidence",
};
/* The V3 demo views are now steps of the one journey page. Old links land on the matching step. */
const DEMO: Record<string, string> = { "": "/#s1", try: "/#s2", settle: "/#s3", connect: "/#s4" };
const MOVED: Record<string, string> = { lease: "/budget", settle: "/collect", quickstart: "/developers" };
type Props = { params: Promise<{ path: string[] }> };

async function routeKey(params: Props["params"]): Promise<string> {
  const { path } = await params;
  const key = path[0] ?? "";
  const moved = MOVED[key];
  if (moved && path.length === 1) redirect(moved);
  if (key === "demo" && path.length <= 2) { const to = DEMO[path[1] ?? ""]; if (to) redirect(to); notFound(); }
  if (path.length > 1 || !(key in TITLES)) notFound();
  return key;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: TITLES[await routeKey(params)] ?? "Pashadhara" };
}

export default async function Page({ params }: Props) {
  switch (await routeKey(params)) {
    case "check": return <Home />;
    case "review": return <Home review />;
    case "budget": return <Budget />;
    case "activity": return <Activity />;
    case "collect": return <Collect />;
    case "escrow": return <Escrow />;
    case "developers": return <Developers />;
    case "proof": return <Proof />;
    default: notFound();
  }
}
