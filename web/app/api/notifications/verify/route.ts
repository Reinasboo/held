import { createHash } from "node:crypto";
import { queryDatabase } from "@/lib/server/database";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token || token.length > 100) {
    return Response.json({ error: "Verification token is missing or invalid." }, { status: 400 });
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");

  try {
    const verified = await queryDatabase<{ registration_address: string }>(
      `update public.notification_subscriptions
       set verified_at = now(), verification_token_hash = null,
           verification_expires_at = null, updated_at = now()
       where verification_token_hash = $1
         and verification_expires_at > now()
         and verified_at is null
       returning registration_address`,
      [tokenHash],
    );
    if (!verified.length) {
      return Response.json(
        { error: "This verification link has expired or has already been used." },
        { status: 400 },
      );
    }
    return Response.json({
      message: "Email verified. You will receive updates for this HELD reservation.",
    });
  } catch (reason) {
    return Response.json(
      {
        error:
          reason instanceof Error
            ? reason.message
            : "Could not verify email notifications.",
      },
      { status: 500 },
    );
  }
}
