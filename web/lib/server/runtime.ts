import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient as createSolanaClient } from "@solana/kit";
import { solanaRpcConnection } from "@solana/kit-plugin-rpc";
import type { HeldRpcClient } from "@/lib/held-program";

export function getSolanaRpcUrl(): string {
  const rpcUrl =
    process.env.SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL is not configured.");
  return rpcUrl;
}

export function createHeldRpcClient(): HeldRpcClient {
  return createSolanaClient().use(
    solanaRpcConnection({ rpcUrl: getSolanaRpcUrl() }),
  );
}

export function authorizeWorker(request: Request): Response | null {
  const expected = process.env.INDEXER_CRON_SECRET;
  if (!expected || expected.length < 32) {
    return Response.json(
      { error: "INDEXER_CRON_SECRET must be configured with at least 32 characters." },
      { status: 503 },
    );
  }
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!provided) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (
    expectedBytes.length !== providedBytes.length ||
    !timingSafeEqual(expectedBytes, providedBytes)
  ) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
}

export function requireResendConfig(): { apiKey: string; from: string; appUrl: string } {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const appUrl = process.env.APP_BASE_URL;
  if (!apiKey || !from || !appUrl) {
    throw new Error(
      "RESEND_API_KEY, RESEND_FROM_EMAIL, and APP_BASE_URL are required for email.",
    );
  }
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new Error("APP_BASE_URL must be a valid absolute URL.");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("APP_BASE_URL must use HTTPS in production.");
  }
  return { apiKey, from, appUrl: url.origin };
}

export function createUnsubscribeToken(registrationAddress: string): string {
  const secret = process.env.NOTIFICATION_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("NOTIFICATION_TOKEN_SECRET must contain at least 32 characters.");
  }
  return createHmac("sha256", secret)
    .update(registrationAddress)
    .digest("base64url");
}

export function isValidUnsubscribeToken(
  registrationAddress: string,
  token: string,
): boolean {
  const expected = Buffer.from(createUnsubscribeToken(registrationAddress));
  const provided = Buffer.from(token);
  return (
    expected.length === provided.length &&
    timingSafeEqual(expected, provided)
  );
}

export async function sendResendEmail(input: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
}): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: input.from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      headers: input.headers,
    }),
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend rejected the email (${response.status}): ${body}`);
  }
}
