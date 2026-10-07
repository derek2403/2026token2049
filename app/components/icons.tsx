// Inline token and chain marks (simplified, no external assets).

import type { ReactNode } from "react";

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

// Line icons for the header and swap card (1.5px stroke, currentColor).

function Line({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const BellIcon = ({ size = 20 }: { size?: number }) => (
  <Line size={size}>
    <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </Line>
);

export const GridIcon = ({ size = 20 }: { size?: number }) => (
  <Line size={size}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="0.5" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="0.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="0.5" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="0.5" />
  </Line>
);

export const ChevronDown = ({ size = 16 }: { size?: number }) => (
  <Line size={size}>
    <path d="m6 9 6 6 6-6" />
  </Line>
);

export const ArrowDown = ({ size = 20 }: { size?: number }) => (
  <Line size={size}>
    <path d="M12 5v14" />
    <path d="m6 13 6 6 6-6" />
  </Line>
);

export const RefreshIcon = ({ size = 16 }: { size?: number }) => (
  <Line size={size}>
    <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" />
    <path d="M20 20v-4h-4" />
  </Line>
);

export const PencilIcon = ({ size = 14 }: { size?: number }) => (
  <Line size={size}>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </Line>
);

export const CloseIcon = ({ size = 18 }: { size?: number }) => (
  <Line size={size}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Line>
);

/** Deterministic gradient avatar for a wallet address. */
export function AddressAvatar({ address, size = 24 }: { address: string; size?: number }) {
  let h = 0;
  for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 80 + ((h >> 9) % 120)) % 360;
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 30% 30%, hsl(${a} 75% 62%), hsl(${b} 70% 42%))`,
      }}
    />
  );
}

export const WalletIcon = ({ size = 22 }: { size?: number }) => (
  <Line size={size}>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" />
    <path d="M4 7.5V17a2 2 0 0 0 2 2h14V8H6.5A2.5 2.5 0 0 1 4 5.5" />
    <circle cx="16" cy="13.5" r="1" fill="currentColor" stroke="none" />
  </Line>
);

export const InfoIcon = ({ size = 14 }: { size?: number }) => (
  <Line size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <circle cx="12" cy="7.8" r="0.6" fill="currentColor" />
  </Line>
);

export const SwitchIcon = ({ size = 14 }: { size?: number }) => (
  <Line size={size}>
    <path d="M4 8h15l-3.5-3.5" />
    <path d="M20 16H5l3.5 3.5" />
  </Line>
);

export const PenIcon = ({ size = 100 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden>
    <circle cx="50" cy="50" r="48" fill="var(--panel-hover)" />
    <path d="M34 66l4-14 24-24 10 10-24 24z" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />
    <path d="M56 34l10 10" stroke="#fff" strokeWidth="3" />
    <path d="M30 72h40" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

// Destination network marks (simplified, no external assets).

type ChainKey = "solana" | "base" | "ethereum" | "arbitrum" | "optimism" | "polygon" | "sui";

export function ChainMark({ chain, size = 14 }: { chain: ChainKey; size?: number }) {
  if (chain === "solana") return <SolanaChainMark size={size} />;
  if (chain === "base") return <BaseChainMark size={size} />;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      {chain === "ethereum" && (
        <>
          <rect width="16" height="16" rx="4" fill="#627EEA" />
          <path d="M8 2.5 4.5 8.2 8 10.2l3.5-2z" fill="#fff" />
          <path d="M4.5 8.9 8 13.5l3.5-4.6L8 10.9z" fill="#fff" fillOpacity=".7" />
        </>
      )}
      {chain === "arbitrum" && (
        <>
          <rect width="16" height="16" rx="4" fill="#213147" />
          <path d="M8 3 12.5 5.6v4.8L8 13 3.5 10.4V5.6z" fill="none" stroke="#9DCCED" strokeWidth="1.2" />
          <path d="M6.6 10.6 8.8 5h1.3l-2.2 5.6zM9.2 10.6 10.4 7.5l.7 1.6-.6 1.5z" fill="#28A0F0" />
        </>
      )}
      {chain === "optimism" && (
        <>
          <rect width="16" height="16" rx="4" fill="#FF0420" />
          <circle cx="5.6" cy="8" r="2" fill="none" stroke="#fff" strokeWidth="1.3" />
          <path d="M9 10V6h2a1.3 1.3 0 0 1 0 2.6H9" fill="none" stroke="#fff" strokeWidth="1.3" />
        </>
      )}
      {chain === "polygon" && (
        <>
          <rect width="16" height="16" rx="4" fill="#8247E5" />
          <path d="M10.5 6.2 8.9 5.3 6.4 6.7v2.6L5.1 10 3.8 9.3V7.8l1.3-.7.8.4V6.6l-.8-.4-2.1 1.2v2.4l2.1 1.2 2.1-1.2V6.9L8.9 6.2l1.3.7v1.5l-1.3.7-.8-.4v.9l.8.4 2.1-1.2V6.4z" fill="#fff" />
        </>
      )}
      {chain === "sui" && (
        <>
          <rect width="16" height="16" rx="4" fill="#4DA2FF" />
          <path d="M8 2.8c2 2.4 3.6 4.4 3.6 6.4A3.6 3.6 0 0 1 4.4 9.2c0-2 1.6-4 3.6-6.4z" fill="#fff" />
        </>
      )}
    </svg>
  );
}

/** Token mark for a destination: ETH, POL or SUI, with the network badge in the corner. */
export function DestTokenMark({
  token,
  chain,
  size = 32,
  ring = "ring-panel",
}: {
  token: "ETH" | "POL" | "SUI";
  chain: ChainKey;
  size?: number;
  ring?: string;
}) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {token === "ETH" ? (
        <EthMark size={size} />
      ) : (
        <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
          <circle cx="16" cy="16" r="16" fill={token === "SUI" ? "#4DA2FF" : "#8247E5"} />
          {token === "SUI" ? (
            <path d="M16 6c4 4.8 7.2 8.8 7.2 12.8a7.2 7.2 0 0 1-14.4 0C8.8 14.8 12 10.8 16 6z" fill="#fff" />
          ) : (
            <path d="M21 12.4 17.8 10.6 12.8 13.4v5.2L10.2 20l-2.6-1.4v-3l2.6-1.4 1.6.8v-1.8l-1.6-.8-4.2 2.4v4.8l4.2 2.4 4.2-2.4v-5.2l2.6-1.4 2.6 1.4v3l-2.6 1.4-1.6-.8v1.8l1.6.8 4.2-2.4v-4.8z" fill="#fff" />
          )}
        </svg>
      )}
      <span className={`absolute -right-1 -bottom-1 rounded-[5px] ring-2 ${ring}`}>
        <ChainMark chain={chain} size={Math.round(size * 0.44)} />
      </span>
    </span>
  );
}

/** 1inch's "+" after SELECT TOKEN: a full-bleed cross with square ends. */
export const PlusIcon = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden>
    <path d="M12 2v20M2 12h20" />
  </svg>
);
