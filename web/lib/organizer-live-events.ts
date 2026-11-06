export type OrganizerLiveEvent = {
  address: string;
  reserved_count: number;
  held_amount: string;
  status: "active" | "cancelled";
  synced_at: Date;
  image_sha256: string | null;
};
