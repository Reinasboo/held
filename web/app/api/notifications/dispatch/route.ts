import { z } from "zod";
import { formatUsdc } from "@/lib/held-program";
import {
  authorizeWorker,
  createUnsubscribeToken,
  requireResendConfig,
  sendResendEmail,
} from "@/lib/server/runtime";
import { queryDatabase } from "@/lib/server/database";

const notificationSchema = z.object({
  id: z.string().uuid(),
  registration_address: z.string(),
  event_address: z.string(),
  notification_type: z.enum([
    "reservation_confirmed",
    "event_cancelled",
    "check_in_recorded",
    "refund_issued",
    "no_show_recorded",
    "no_show_settled",
    "event_reminder",
  ]),
  attendee_email: z.string().email(),
  event_name: z.string(),
  event_start_at: z.union([z.string(), z.number()]),
  event_time_zone: z.string(),
  deposit_amount: z.union([z.string(), z.number()]),
  attendee_wallet: z.string(),
  organizer_wallet: z.string(),
  attempt_count: z.number().int().positive(),
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function notificationContent(
  notification: z.infer<typeof notificationSchema>,
  eventUrl: string,
  unsubscribeUrl: string,
) {
  const date = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: notification.event_time_zone,
  }).format(new Date(Number(notification.event_start_at) * 1000));
  const amount = `${formatUsdc(BigInt(notification.deposit_amount))} USDC`;
  const copy: Record<
    z.infer<typeof notificationSchema>["notification_type"],
    { subject: string; message: string }
  > = {
    reservation_confirmed: {
      subject: "Your HELD reservation is confirmed",
      message: `Your ${amount} refundable commitment for ${notification.event_name} is confirmed on Solana Devnet. Keep your QR pass ready for check-in.`,
    },
    event_cancelled: {
      subject: "Your HELD event was cancelled",
      message: `${notification.event_name} was cancelled. Your ${amount} deposit is eligible for a full refund claim from your reservations dashboard.`,
    },
    check_in_recorded: {
      subject: "Your HELD check-in is recorded",
      message: `The organizer recorded your check-in for ${notification.event_name}. Your ${amount} refund is available to claim from your reservations dashboard.`,
    },
    refund_issued: {
      subject: "Your HELD refund is confirmed",
      message: `Your full ${amount} refund for ${notification.event_name} is confirmed on-chain.`,
    },
    no_show_recorded: {
      subject: "A no-show was recorded for your HELD event",
      message: `The organizer recorded a no-show for ${notification.event_name}. Your deposit is now eligible to be paid to the organizer, who may instead choose to issue you a full refund. Contact the organizer directly if you believe the record is incorrect.`,
    },
    no_show_settled: {
      subject: "Your HELD no-show deposit was paid to the organizer",
      message: `The ${amount} deposit for ${notification.event_name} was paid to the event organizer after a no-show was recorded.`,
    },
    event_reminder: {
      subject: `Reminder: ${notification.event_name}`,
      message: `${notification.event_name} is coming up on ${date}. Your HELD reservation and attendance pass are ready.`,
    },
  };
  const content = copy[notification.notification_type];
  return {
    subject: content.subject,
    html: `<p>${escapeHtml(content.message)}</p><p><a href="${eventUrl}">View your event</a></p><p>Organizer wallet: ${escapeHtml(notification.organizer_wallet)}</p><p><a href="${unsubscribeUrl}">Unsubscribe from HELD event updates</a></p>`,
  };
}

export async function POST(request: Request) {
  const authorizationError = authorizeWorker(request);
  if (authorizationError) return authorizationError;

  try {
    const resend = requireResendConfig();
    const claimed = await queryDatabase(
      "select * from public.claim_held_notifications($1)",
      [25],
    );

    let sent = 0;
    let failed = 0;
    const errors: { id: string; error: string }[] = [];
    for (const rawNotification of claimed) {
      const parsed = notificationSchema.safeParse(rawNotification);
      if (!parsed.success) {
        failed += 1;
        errors.push({ id: "unknown", error: "The notification queue row is invalid." });
        continue;
      }
      const notification = parsed.data;
      try {
        const eventUrl = new URL("/", resend.appUrl);
        eventUrl.searchParams.set("event", notification.event_address);
        const unsubscribeUrl = new URL(
          "/api/notifications/unsubscribe",
          resend.appUrl,
        );
        unsubscribeUrl.searchParams.set(
          "registration",
          notification.registration_address,
        );
        unsubscribeUrl.searchParams.set(
          "token",
          createUnsubscribeToken(notification.registration_address),
        );
        const content = notificationContent(
          notification,
          eventUrl.toString(),
          unsubscribeUrl.toString(),
        );
        await sendResendEmail({
          apiKey: resend.apiKey,
          from: resend.from,
          to: notification.attendee_email,
          subject: content.subject,
          html: content.html,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl.toString()}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
        await queryDatabase(
          `update public.notification_outbox
           set status = 'sent', sent_at = now(), last_error = null, updated_at = now()
           where id = $1`,
          [notification.id],
        );
        sent += 1;
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : "Email delivery failed.";
        const backoffMinutes = Math.min(360, 2 ** Math.min(notification.attempt_count, 8));
        try {
          await queryDatabase(
            `update public.notification_outbox
             set status = 'failed', last_error = $2,
                 next_attempt_at = $3, updated_at = now()
             where id = $1`,
            [
              notification.id,
              message.slice(0, 1000),
              new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
            ],
          );
          errors.push({ id: notification.id, error: message });
        } catch (updateError) {
          errors.push({
            id: notification.id,
            error: `${message}; failed to save retry state: ${
              updateError instanceof Error
                ? updateError.message
                : "unknown database error"
            }`,
          });
        }
        failed += 1;
      }
    }
    return Response.json({ claimed: claimed.length, sent, failed, errors });
  } catch (reason) {
    return Response.json(
      {
        error:
          reason instanceof Error
            ? reason.message
            : "The notification dispatcher failed.",
      },
      { status: 500 },
    );
  }
}
