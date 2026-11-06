"use client";

import { createContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createClient } from "@solana/kit";
import { ClientProvider } from "@solana/react";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { walletSigner } from "@solana/kit-plugin-wallet";
import { createRealtimeClient } from "@neon/realtime/client";
import type { RealtimeClient } from "@neon/realtime/client";
import { RealtimeProvider } from "@neon/realtime-react";

const rpcUrl =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

export const client = createClient()
  .use(walletSigner({ chain: "solana:devnet" }))
  .use(solanaRpc({ rpcUrl, transactionConfig: { version: 1 } }));

export type AppClient = Awaited<typeof client>;

export const RealtimeReadyContext = createContext(false);

export function Providers({ children }: { children: ReactNode }) {
  const [realtimeClient, setRealtimeClient] = useState<RealtimeClient | null>(null);

  useEffect(() => {
    let nextClient: RealtimeClient | null = null;
    const timer = window.setTimeout(() => {
      const url = process.env.NEXT_PUBLIC_NEON_REALTIME_URL;
      if (url) {
        nextClient = createRealtimeClient({ url });
        setRealtimeClient(nextClient);
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      nextClient?.close();
    };
  }, []);

  return (
    <ClientProvider client={client}>
      <RealtimeReadyContext.Provider value={realtimeClient !== null}>
        {realtimeClient ? (
          <RealtimeProvider client={realtimeClient}>{children}</RealtimeProvider>
        ) : children}
      </RealtimeReadyContext.Provider>
    </ClientProvider>
  );
}
