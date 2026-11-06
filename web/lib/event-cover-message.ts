export function createEventCoverMessage(input: {
  event: string;
  organizer: string;
  contentType: string;
  sha256: string;
  issuedAt: string;
}): string {
  return [
    "HELD event cover image upload v1",
    `Event: ${input.event}`,
    `Organizer: ${input.organizer}`,
    `Content-Type: ${input.contentType}`,
    `SHA-256: ${input.sha256}`,
    `Issued-At: ${input.issuedAt}`,
  ].join("\n");
}
