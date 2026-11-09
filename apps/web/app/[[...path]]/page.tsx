import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CordApp } from "../../components/cord-app";

const TITLES: Record<string, string> = {
  "": "Pashadhara | A budget your agent cannot break",
  signup: "Create your account | Pashadhara",
  login: "Log in | Pashadhara",
  lease: "Lease | Pashadhara",
  approve: "New lease | Pashadhara",
  escrow: "Escrow | Pashadhara",
  settle: "Settle | Pashadhara",
  proof: "Proof | Pashadhara",
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
  await routeKey(params);
  return <CordApp />;
}
