// Who runs a step: Solana, the SODA MPC committee, Chainlink CRE, or Base.

export type Actor = "solana" | "mpc" | "cre" | "base";

export const CHAINLINK_BLUE = "#375BD2";

const LABEL: Record<Actor, string> = {
  solana: "Solana",
  mpc: "SODA MPC (2-of-2)",
  cre: "Chainlink CRE",
  base: "Base",
};

const TITLE: Record<Actor, string> = {
  solana: "A Solana program or your Solana wallet does this",
  mpc: "The SODA 2-of-2 MPC committee (Lindell '17 ECDSA): no single party holds the key",
  cre: "Chainlink CRE: a DON workflow, written to Solana through Chainlink's forwarder",
  base: "Happens on Base Sepolia",
};

export function ActorPill({ actor, label }: { actor: Actor; label?: string }) {
  const cls =
    actor === "solana"
      ? "bg-[#9945FF]/15 text-[#c9a6ff]"
      : actor === "base"
        ? "bg-[#0052FF]/15 text-[#8fb0ff]"
        : actor === "mpc"
          ? "bg-panel-hover text-muted"
          : "text-white";
  return (
    <span
      title={TITLE[actor]}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${cls}`}
      style={actor === "cre" ? { background: CHAINLINK_BLUE } : undefined}
    >
      {label ?? LABEL[actor]}
    </span>
  );
}
