import { authorizeWorker } from "@/lib/server/runtime";
import { queryDatabase } from "@/lib/server/database";

export async function POST(request: Request) {
  const authorizationError = authorizeWorker(request);
  if (authorizationError) return authorizationError;

  try {
    const [result] = await queryDatabase<{ retried: number | string }>(
      "select public.retry_held_notifications() as retried",
    );
    if (!result) throw new Error("The notification retry returned no result.");
    return Response.json({ retried: Number(result.retried) });
  } catch (reason) {
    return Response.json(
      {
        error:
          reason instanceof Error
            ? reason.message
            : "Could not retry failed notifications.",
      },
      { status: 500 },
    );
  }
}
