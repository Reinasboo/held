"use client";

import Image from "next/image";
import { useState } from "react";
import { useSignMessage } from "@solana/kit-plugin-wallet/react";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import type { Address } from "@solana/kit";
import { z } from "zod";
import type { AppClient } from "@/components/providers";
import { createEventCoverMessage } from "@/lib/event-cover-message";
import type { EventAccount } from "@/lib/held-program";

function coverImageUrl(eventAddress: string): string {
  return `/api/events/${encodeURIComponent(eventAddress)}/cover`;
}

const uploadResponseSchema = z.union([
  z.object({ sha256: z.string() }),
  z.object({ error: z.string() }),
]);

export function EventCoverImage({
  eventAddress,
  imageVersion,
}: {
  eventAddress: string;
  imageVersion?: string | null;
}) {
  const [unavailable, setUnavailable] = useState(false);
  if (unavailable) return null;
  return (
    <Image
      key={imageVersion ?? "default"}
      className="event-art-image"
      src={coverImageUrl(eventAddress)}
      alt=""
      aria-hidden="true"
      fill
      sizes="(max-width: 700px) 100vw, 50vw"
      unoptimized
      onError={() => setUnavailable(true)}
    />
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function EventCoverUpload({
  event,
  organizer,
  onUploaded,
}: {
  event: EventAccount;
  organizer: Address;
  onUploaded: () => void;
}) {
  const client = useClient<AppClient>();
  const wallet = useConnectedWallet(client);
  const { dispatchAsync: signMessage } = useSignMessage(client);
  const [imageVersion, setImageVersion] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function upload(file: File) {
    setError(null);
    setSuccess(false);
    if (!wallet || wallet.account.address !== organizer) {
      setError("Connect this event's organizer wallet before uploading a cover.");
      return;
    }
    if (file.size < 1 || file.size > 5 * 1024 * 1024) {
      setError("Cover images must be 5 MB or smaller.");
      return;
    }
    const contentType = file.type;
    if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      setError("Choose a JPEG, PNG, or WebP image.");
      return;
    }

    setUploading(true);
    try {
      const digest = await sha256(file);
      const issuedAt = Date.now().toString();
      const message = createEventCoverMessage({
        event: event.address,
        organizer,
        contentType,
        sha256: digest,
        issuedAt,
      });
      const signature = await signMessage(new TextEncoder().encode(message));
      const form = new FormData();
      form.append("file", file);
      form.append("event", event.address);
      form.append("organizer", organizer);
      form.append("contentType", contentType);
      form.append("sha256", digest);
      form.append("issuedAt", issuedAt);
      form.append("signature", toBase64Url(signature));

      const response = await fetch(coverImageUrl(event.address), {
        method: "POST",
        body: form,
      });
      const parsed = uploadResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("The cover upload returned an invalid response.");
      }
      if (!response.ok) {
        throw new Error(
          "error" in parsed.data
            ? parsed.data.error
            : "Could not upload the cover image.",
        );
      }
      if (!("sha256" in parsed.data)) {
        throw new Error("The cover upload returned no image confirmation.");
      }
      setImageVersion(parsed.data.sha256);
      setSuccess(true);
      onUploaded();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not upload the cover image.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="event-cover-upload">
      <div className="event-art event-cover-preview">
        <EventCoverImage
          key={imageVersion ?? "default"}
          eventAddress={event.address}
          imageVersion={imageVersion}
        />
        <div className="art-shape art-shape-one" />
        <div className="art-shape art-shape-two" />
        <span className="event-art-label">EVENT COVER</span>
        <span className="event-art-mark">held.</span>
      </div>
      <label className="button-secondary event-cover-button">
        {uploading ? "Uploading…" : "Upload cover image"}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={uploading}
          onChange={(change) => {
            const file = change.currentTarget.files?.[0];
            change.currentTarget.value = "";
            if (file) void upload(file);
          }}
        />
      </label>
      <p className="fine-print">
        JPEG, PNG, or WebP up to 5 MB. Your organizer wallet will sign a one-time upload authorization.
      </p>
      {success && <p className="cover-upload-success" role="status">Cover image updated.</p>}
      {error && <p className="transaction-error" role="alert">{error}</p>}
    </div>
  );
}
