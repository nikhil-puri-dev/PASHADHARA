import type { Metadata } from "next";
import { DelegationApp } from "../../components/delegation-app";

export const metadata: Metadata = { title: "Delegated authority | Pashadhara" };
export default function Page() { return <DelegationApp />; }
