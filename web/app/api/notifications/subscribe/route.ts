import { createHash, randomBytes } from "node:crypto";
import { address } from "@solana/kit";
import { z } from "zod";
import {
  loadEvent,
  loadRegistrations,
} from "@/lib/held-program";
import {
  createHeldRpcClient,
  requireResendConfig,
  sendResendEmail,
} from "@/lib/server/runtime";
import {
  queryDatabase,
  upsertEventSnapshots,
  upsertRegistrationSnapshots,
} from "@/lib/server/database";
import {
  InvalidReservationProofError,
  verifyConfirmedReservationTransaction,
} from "@/lib/server/solana-verification";

const requestSchema = z.object({
  attendee: z.string().min(32).max(44).refine(isAddress),
  email: z.string().trim().email().max(254),
  event: z.string().min(32).max(44).refine(isAddress),
  registration: z.string().min(32).max(44).refine(isAddress),
  signature: z.string().min(64).max(100).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),
}).strict();

function isAddress(value: string): boolean {
  try {
    address(value);
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  let input: z.infer<typeof requestSchema>;
  try {
    const body: unknown = await request.json();
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "Provide a valid event reservation, signature, and email address." },
        { status: 400 },
      );
    }
    input = parsed.data;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    const attendee = address(input.attendee);
    const eventAddress = address(input.event);
    const registrationAddress = address(input.registration);
    const rpc = createHeldRpcClient();
    const [registrations, event] = await Promise.all([
      loadRegistrations(rpc, attendee),
      loadEvent(rpc, eventAddress),
    ]);
    const registration = registrations.find(
      (candidate) => candidate.address === registrationAddress,
    );
    if (
      !registration ||
      registration.event !== eventAddress ||
      registration.attendee !== attendee ||
      registration.reservationStatus !== "confirmed"
    ) {
      return Response.json(
        { error: "No confirmed reservation matches this wallet and event." },
        { status: 400 },
      );
    }
    await verifyConfirmedReservationTransaction({
      signature: input.signature,
      event: eventAddress,
      registration: registrationAddress,
      attendee,
    });

    const resend = requireResendConfig();
    await upsertEventSnapshots([event]);
    await upsertRegistrationSnapshots([registration]);
    const [existing] = await queryDatabase<{
      verified_at: string | null;
      last_verification_sent_at: string | null;
      unsubscribed_at: string | null;
    }>(
      `select verified_at, last_verification_sent_at, unsubscribed_at
       from public.notification_subscriptions
       where registration_address = $1`,
      [registrationAddress],
    );
    if (existing?.verified_at && !existing.unsubscribed_at) {
      return Response.json(
        { error: "Email notifications are already verified for this reservation." },
        { status: 409 },
      );
    }
    const now = Date.now();
    const lastSentAt = existing?.last_verification_sent_at
      ? Date.parse(existing.last_verification_sent_at)
      : 0;
    if (lastSentAt && now - lastSentAt < 60_000) {
      return Response.json(
        { error: "A verification email was sent recently. Check your inbox before retrying." },
        { status: 429 },
      );
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const sentAt = new Date(now).toISOString();
    await queryDatabase(
      `insert into public.notification_subscriptions (
         registration_address, attendee_wallet, email, verified_at,
         verification_token_hash, verification_expires_at,
         last_verification_sent_at, unsubscribed_at, updated_at
       ) values ($1, $2, $3, null, $4, $5, $6, null, $6)
       on conflict (registration_address) do update set
         attendee_wallet = excluded.attendee_wallet,
         email = excluded.email,
         verified_at = null,
         verification_token_hash = excluded.verification_token_hash,
         verification_expires_at = excluded.verification_expires_at,
         last_verification_sent_at = excluded.last_verification_sent_at,
         unsubscribed_at = null,
         updated_at = excluded.updated_at`,
      [
        registrationAddress,
        attendee,
        input.email.trim().toLowerCase(),
        tokenHash,
        new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        sentAt,
      ],
    );

    const verificationUrl = new URL("/api/notifications/verify", resend.appUrl);
    verificationUrl.searchParams.set("token", token);
    try {
      await sendResendEmail({
        apiKey: resend.apiKey,
        from: resend.from,
        to: input.email.trim().toLowerCase(),
        subject: "Verify your HELD event updates",
        html: `<p>Confirm that you want reservation and event updates for <strong>${event.name.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)}</strong>.</p><p><a href="${verificationUrl.toString()}">Verify email notifications</a></p><p>This link expires in 24 hours. If you did not request updates, ignore this message.</p>`,
      });
    } catch (reason) {
      console.error("HELD notification verification email failed", reason);
      return Response.json(
        { error: "The verification email could not be sent. Retry after one minute." },
        { status: 502 },
      );
    }

    return Response.json(
      { message: "Check your inbox and verify the address to enable event notifications." },
      { status: 202 },
    );
  } catch (reason) {
    if (reason instanceof InvalidReservationProofError) {
      return Response.json({ error: reason.message }, { status: 400 });
    }
    return Response.json(
      {
        error:
          reason instanceof Error
            ? reason.message
            : "Could not enable event notifications.",
      },
      { status: 500 },
    );
  }
}
