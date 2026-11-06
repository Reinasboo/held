import { z } from "zod";
import { queryDatabase } from "@/lib/server/database";
import {
  isValidUnsubscribeToken,
  requireResendConfig,
} from "@/lib/server/runtime";

const querySchema = z.object({
  registration: z.string().min(32).max(44),
  token: z.string().min(32).max(100),
});

function parseUnsubscribeRequest(request: Request) {
  return querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
}

export async function GET(request: Request) {
  const parsed = parseUnsubscribeRequest(request);
  if (!parsed.success) {
    return Response.json({ error: "Unsubscribe link is invalid." }, { status: 400 });
  }
  try {
    if (!isValidUnsubscribeToken(parsed.data.registration, parsed.data.token)) {
      return Response.json({ error: "Unsubscribe link is invalid." }, { status: 403 });
    }
    const actionUrl = new URL(
      "/api/notifications/unsubscribe",
      requireResendConfig().appUrl,
    );
    actionUrl.searchParams.set("registration", parsed.data.registration);
    actionUrl.searchParams.set("token", parsed.data.token);
    const action = actionUrl.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return new Response(
      `<main><h1>Unsubscribe from HELD event updates?</h1><form action="${action}" method="post"><button type="submit">Unsubscribe</button></form></main>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  } catch (reason) {
    return Response.json(
      {
        error:
          reason instanceof Error
            ? reason.message
            : "Could not validate the unsubscribe link.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const parsed = parseUnsubscribeRequest(request);
  if (!parsed.success) {
    return Response.json({ error: "Unsubscribe link is invalid." }, { status: 400 });
  }
  const { registration, token } = parsed.data;
  try {
    if (!isValidUnsubscribeToken(registration, token)) {
      return Response.json({ error: "Unsubscribe link is invalid." }, { status: 403 });
    }
    await queryDatabase(
      `update public.notification_subscriptions
       set unsubscribed_at = now(), updated_at = now()
       where registration_address = $1 and unsubscribed_at is null
       returning registration_address`,
      [registration],
    );
    return Response.json({ message: "Email notifications are disabled for this reservation." });
  } catch (reason) {
    return Response.json(
      {
        error:
          reason instanceof Error
            ? reason.message
            : "Could not disable email notifications.",
      },
      { status: 500 },
    );
  }
}
