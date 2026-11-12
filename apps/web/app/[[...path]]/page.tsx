import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Activity } from "../../components/activity";
import { Budget } from "../../components/budget";
import { Home } from "../../components/home";
import { Collect, Developers, Escrow, Proof } from "../../components/more";
import { Demo, type DemoView } from "../../components/v3/demo";
import { Landing } from "../../components/v3/landing";

const TITLES: Record<string, string> = {
  "": "Pashadhara | Your agent can spend $20.00. Not $20.01.",
  check: "Can this agent make this spend? | Pashadhara",
  demo: "Demo | Pashadhara",
  review: "Recorded spending decision | Pashadhara",
  budget: "Budget | Pashadhara",
  activity: "Journal | Pashadhara",
  collect: "Collect | Pashadhara",
  escrow: "Escrow | Pashadhara",
  developers: "Connect your agent | Pashadhara",
  proof: "PayPal evidence | Pashadhara",
};
const DEMO: Record<string, DemoView> = { try: "try", settle: "settle", connect: "connect" };
const MOVED: Record<string, string> = { lease: "/budget", settle: "/collect", quickstart: "/developers" };
type Props = { params: Promise<{ path?: string[] }> };

async function routeKey(params: Props["params"]): Promise<string> {
  const { path = [] } = await params;
  const key = path[0] ?? "";
  const moved = MOVED[key];
  if (moved) redirect(moved);
  const sub = path[1];
  if (key === "demo" && path.length <= 2 && (sub === undefined || sub in DEMO)) return key;
  if (path.length > 1 || !(key in TITLES)) notFound();
  return key;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: TITLES[await routeKey(params)] ?? "Pashadhara" };
}

export default async function Page({ params }: Props) {
  switch (await routeKey(params)) {
    case "": return <Landing />;
    case "check": return <Home />;
    case "demo": return <Demo view={DEMO[(await params).path?.[1] ?? ""] ?? "budget"} />;
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
