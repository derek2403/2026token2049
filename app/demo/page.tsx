import type { Metadata } from "next";
import { DemoApp } from "@/app/components/demo/DemoApp";

export const metadata: Metadata = {
  title: "SODA Signing Demo",
  description:
    "One Phantom approval on Solana signs a Base Sepolia transaction through the SODA MPC committee, driven by the subscriber or by Chainlink CRE.",
};

export default function DemoPage() {
  return <DemoApp />;
}
