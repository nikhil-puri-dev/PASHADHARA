import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CordApp } from "../../components/cord-app";
import { DelegationApp } from "../../components/delegation-app";

const TITLES: Record<string, string> = {
  "": "Pashadhara | A budget your agent cannot break",
  signup: "Create your account | Pashadhara",
  login: "Log in | Pashadhara",
  lease: "Lease | Pashadhara",
  approve: "New lease | Pashadhara",
  escrow: "Escrow | Pashadhara",
  settle: "Settle | Pashadhara",
  proof: "Proof | Pashadhara",
  quickstart: "Developer quickstart | Pashadhara",
  delegation: "Delegated authority | Pashadhara",
};
type Props = { params: Promise<{ path?: string[] }> };

async function routeKey(params: Props["params"]): Promise<string> {
  const { path = [] } = await params;
  const key = path[0] ?? "";
  if (path.length > 1 || !(key in TITLES)) notFound();
  return key;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: TITLES[await routeKey(params)] ?? "Pashadhara" };
}

export default async function Page({ params }: Props) {
  const route = await routeKey(params);
  return route === "delegation" ? <DelegationApp /> : <CordApp />;
}
