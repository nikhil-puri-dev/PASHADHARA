import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Activity } from "../../components/activity";
import { Budget } from "../../components/budget";
import { Home } from "../../components/home";
import { Collect, Developers, Escrow, Proof } from "../../components/more";

const TITLES: Record<string, string> = {
  "": "Pashadhara | A budget your AI agent cannot overspend",
  budget: "Budget | Pashadhara",
  activity: "Activity | Pashadhara",
  collect: "Collect | Pashadhara",
  escrow: "Escrow | Pashadhara",
  developers: "Connect your agent | Pashadhara",
  proof: "PayPal evidence | Pashadhara",
};
const MOVED: Record<string, string> = { lease: "/budget", settle: "/collect", quickstart: "/developers" };
type Props = { params: Promise<{ path?: string[] }> };

async function routeKey(params: Props["params"]): Promise<string> {
  const { path = [] } = await params;
  const key = path[0] ?? "";
  const moved = MOVED[key];
  if (moved) redirect(moved);
  if (path.length > 1 || !(key in TITLES)) notFound();
  return key;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: TITLES[await routeKey(params)] ?? "Pashadhara" };
}

export default async function Page({ params }: Props) {
  switch (await routeKey(params)) {
    case "": return <Home />;
    case "budget": return <Budget />;
    case "activity": return <Activity />;
    case "collect": return <Collect />;
    case "escrow": return <Escrow />;
    case "developers": return <Developers />;
    case "proof": return <Proof />;
    default: notFound();
  }
}
