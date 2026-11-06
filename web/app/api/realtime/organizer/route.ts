import { address } from "@solana/kit";
import { z } from "zod";
import { sealOrganizerEventsQuery } from "@/lib/server/realtime";

const requestSchema = z.object({
  organizer: z.string().min(32).max(44),
}).strict();

export async function POST(request: Request) {
  let organizer: string;
  try {
    const body: unknown = await request.json();
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Provide a valid organizer address." }, { status: 400 });
    }
    organizer = String(address(parsed.data.organizer));
  } catch {
    return Response.json({ error: "Request body must contain a valid wallet address." }, { status: 400 });
  }

  try {
    const query = await sealOrganizerEventsQuery(organizer);
    return Response.json({ query });
  } catch (reason) {
    return Response.json(
      {
        error:
          reason instanceof Error
            ? reason.message
            : "Could not prepare live organizer updates.",
      },
      { status: 503 },
    );
  }
}
