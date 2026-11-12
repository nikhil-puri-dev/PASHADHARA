import type { Metadata } from "next";
import { Finance } from "../../components/finance";

export const metadata: Metadata = { title: "Finance agent" };
export default function Page() { return <Finance />; }
