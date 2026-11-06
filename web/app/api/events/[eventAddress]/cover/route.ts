import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { address, getAddressEncoder } from "@solana/kit";
import { z } from "zod";
import { createEventCoverMessage } from "@/lib/event-cover-message";
import { loadEvent } from "@/lib/held-program";
import {
  queryDatabase,
  upsertEventSnapshots,
} from "@/lib/server/database";
import {
  createEventCoverUrl,
  deleteEventCover,
  putEventCover,
} from "@/lib/server/object-storage";
import { createHeldRpcClient } from "@/lib/server/runtime";

const requestSchema = z.object({
  event: z.string().min(32).max(44),
  organizer: z.string().min(32).max(44),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.string().regex(/^\d{13}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();

type RouteContext = {
  params: Promise<{ eventAddress: string }>;
};

const maxRequestBytes = 5 * 1024 * 1024 + 64 * 1024;

class RequestBodyTooLargeError extends Error {}

async function readUploadForm(request: Request): Promise<FormData> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxRequestBytes) {
    throw new RequestBodyTooLargeError("Upload request exceeds the maximum size.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Upload request has no body.");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxRequestBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError("Upload request exceeds the maximum size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body,
  }).formData();
}

function isSupportedImage(bytes: Buffer, contentType: string): boolean {
  if (contentType === "image/png") {
    return bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return contentType === "image/webp" &&
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
}

function hasOrganizerSignature(
  organizer: string,
  message: string,
  signature: Buffer,
): boolean {
  const publicKeyBytes = Buffer.from(
    getAddressEncoder().encode(address(organizer)),
  );
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      publicKeyBytes,
    ]),
    format: "der",
    type: "spki",
  });
  return verifySignature(null, Buffer.from(message, "utf8"), publicKey, signature);
}

function coverExtension(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  return contentType === "image/png" ? "png" : "webp";
}

export async function GET(_request: Request, { params }: RouteContext) {
  let eventAddress: string;
  try {
    eventAddress = String(address((await params).eventAddress));
  } catch {
    return Response.json({ error: "Event address is invalid." }, { status: 400 });
  }

  try {
    const [image] = await queryDatabase<{ bucket_key: string }>(
      `select bucket_key from public.held_event_images where event_address = $1`,
      [eventAddress],
    );
    if (!image) {
      return Response.json({ error: "This event has no cover image." }, { status: 404 });
    }
    const url = await createEventCoverUrl(image.bucket_key);
    return new Response(null, {
      status: 302,
      headers: {
        location: url,
        "cache-control": "private, no-store",
      },
    });
  } catch (reason) {
    return Response.json(
      {
        error:
          reason instanceof Error
            ? reason.message
            : "Could not load the event cover image.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  let eventAddress: string;
  try {
    eventAddress = String(address((await params).eventAddress));
  } catch {
    return Response.json({ error: "Event address is invalid." }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await readUploadForm(request);
  } catch (reason) {
    return Response.json(
      {
        error:
          reason instanceof RequestBodyTooLargeError
            ? reason.message
            : "Upload must use multipart form data.",
      },
      { status: reason instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  const rawFile = form.get("file");
  if (!(rawFile instanceof File)) {
    return Response.json({ error: "Choose an image file to upload." }, { status: 400 });
  }
  if (rawFile.size < 1 || rawFile.size > 5 * 1024 * 1024) {
    return Response.json({ error: "Cover images must be 5 MB or smaller." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse({
    event: form.get("event"),
    organizer: form.get("organizer"),
    contentType: form.get("contentType"),
    sha256: form.get("sha256"),
    issuedAt: form.get("issuedAt"),
    signature: form.get("signature"),
  });
  if (!parsed.success || parsed.data.event !== eventAddress) {
    return Response.json({ error: "Cover image authorization is invalid." }, { status: 400 });
  }

  let organizerAddress: ReturnType<typeof address>;
  try {
    organizerAddress = address(parsed.data.organizer);
  } catch {
    return Response.json({ error: "Organizer address is invalid." }, { status: 400 });
  }

  try {
    const { contentType, sha256, issuedAt, signature: encodedSignature } = parsed.data;
    const organizer = String(organizerAddress);
    const issuedAtMs = Number(issuedAt);
    if (!Number.isSafeInteger(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > 5 * 60_000) {
      return Response.json({ error: "Upload authorization expired. Please try again." }, { status: 401 });
    }

    const bytes = Buffer.from(await rawFile.arrayBuffer());
    if (!isSupportedImage(bytes, contentType)) {
      return Response.json({ error: "Image contents do not match the selected image type." }, { status: 400 });
    }
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== sha256) {
      return Response.json({ error: "Image changed after it was signed. Please try again." }, { status: 400 });
    }

    const signature = Buffer.from(encodedSignature, "base64url");
    const message = createEventCoverMessage({
      event: eventAddress,
      organizer,
      contentType,
      sha256,
      issuedAt,
    });
    if (signature.length !== 64 || !hasOrganizerSignature(organizer, message, signature)) {
      return Response.json({ error: "Organizer signature is invalid." }, { status: 403 });
    }

    const event = await loadEvent(createHeldRpcClient(), address(eventAddress));
    if (event.organizer !== address(organizer)) {
      return Response.json({ error: "Only this event's organizer can change its cover image." }, { status: 403 });
    }

    await upsertEventSnapshots([event]);
    const key = `events/${eventAddress}/cover-${sha256}.${coverExtension(contentType)}`;
    const [previousImage] = await queryDatabase<{ bucket_key: string }>(
      `select bucket_key from public.held_event_images where event_address = $1`,
      [eventAddress],
    );
    await putEventCover(key, bytes, contentType);
    try {
      await queryDatabase(
        `insert into public.held_event_images (event_address, bucket_key, content_type, sha256)
         values ($1, $2, $3, $4)
         on conflict (event_address) do update set
           bucket_key = excluded.bucket_key,
           content_type = excluded.content_type,
           sha256 = excluded.sha256,
           updated_at = now()`,
        [eventAddress, key, contentType, sha256],
      );
    } catch (error) {
      if (previousImage?.bucket_key !== key) {
        try {
          await deleteEventCover(key);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Could not save the image metadata or clean up the uploaded object.",
          );
        }
      }
      throw error;
    }

    if (previousImage && previousImage.bucket_key !== key) {
      await deleteEventCover(previousImage.bucket_key);
    }
    return Response.json({ event: eventAddress, sha256 });
  } catch (reason) {
    return Response.json(
      {
        error:
          reason instanceof Error
            ? reason.message
            : "Could not upload the event cover image.",
      },
      { status: 500 },
    );
  }
}
