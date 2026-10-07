// Inline token and chain marks (simplified, no external assets).

export function SolMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="sol-g" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill="#0d0f1a" />
      <g fill="url(#sol-g)">
        <path d="M10.4 19.6h12.2l-2.4 2.4H8z" />
        <path d="M10.4 10h12.2l-2.4 2.4H8z" />
        <path d="M21.6 14.8H9.4l2.4 2.4H24z" />
      </g>
    </svg>
  );
}

export function EthMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#fff">
        <path fillOpacity=".6" d="M16.5 4v8.87l7.5 3.35z" />
        <path d="M16.5 4L9 16.22l7.5-3.35z" />
        <path fillOpacity=".6" d="M16.5 21.97v6.03L24 17.62z" />
        <path d="M16.5 28v-6.03L9 17.62z" />
        <path fillOpacity=".2" d="M16.5 20.57l7.5-4.35-7.5-3.35z" />
        <path fillOpacity=".6" d="M9 16.22l7.5 4.35v-7.7z" />
      </g>
    </svg>
  );
}

export function SolanaChainMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <defs>
        <linearGradient id="solc-g" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <rect width="16" height="16" rx="4" fill="#000" />
      <g fill="url(#solc-g)">
        <path d="M5 4.5h7l-1.3 1.3H3.7z" />
        <path d="M11 7.35H4l1.3 1.3h7z" />
        <path d="M5 10.2h7l-1.3 1.3H3.7z" />
      </g>
    </svg>
  );
}

export function BaseChainMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect width="16" height="16" rx="4" fill="#0052FF" />
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="#fff" />
    </svg>
  );
}

/** Token mark with its chain mark in the corner, as on 1inch. */
export function TokenWithChain({ token }: { token: "SOL" | "ETH" }) {
  return (
    <span className="relative inline-flex h-8 w-8 shrink-0">
      {token === "SOL" ? <SolMark /> : <EthMark />}
      <span className="absolute -right-1 -bottom-1 rounded-[5px] ring-2 ring-panel">
        {token === "SOL" ? <SolanaChainMark /> : <BaseChainMark />}
      </span>
    </span>
  );
}

export function ChainBadge({ chain }: { chain: "solana" | "base" }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-bg/60 px-2 py-0.5 text-[11px] font-medium text-muted">
      {chain === "solana" ? <SolanaChainMark size={12} /> : <BaseChainMark size={12} />}
      {chain === "solana" ? "Solana" : "Base"}
    </span>
  );
}
