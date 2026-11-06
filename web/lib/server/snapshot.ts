import type { EventAccount, RegistrationAccount } from "@/lib/held-program";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function eventSnapshotRow(event: EventAccount) {
  return {
    address: event.address,
    organizer: event.organizer,
    mint: event.mint,
    event_seed: bytesToHex(event.eventSeed),
    name: event.name,
    description: event.description,
    location: event.location,
    time_zone: event.timeZone,
    event_start_at: event.eventStartAt.toString(),
    deposit_amount: event.depositAmount.toString(),
    capacity: event.capacity,
    reserved_count: event.reservedCount,
    held_amount: event.heldAmount.toString(),
    registration_open_at: event.registrationOpenAt.toString(),
    registration_close_at: event.registrationCloseAt.toString(),
    cancellation_deadline: event.cancellationDeadline.toString(),
    check_in_start_at: event.checkInStartAt.toString(),
    check_in_end_at: event.checkInEndAt.toString(),
    dispute_window_seconds: event.disputeWindowSeconds.toString(),
    policy_hash: bytesToHex(event.policyHash),
    status: event.status,
    synced_at: new Date().toISOString(),
  };
}

export function registrationSnapshotRow(registration: RegistrationAccount) {
  return {
    address: registration.address,
    event_address: registration.event,
    attendee: registration.attendee,
    deposit_amount: registration.depositAmount.toString(),
    policy_hash: bytesToHex(registration.policyHash),
    reservation_status: registration.reservationStatus,
    attendance_status: registration.attendanceStatus,
    settlement_status: registration.settlementStatus,
    checked_in_by: registration.checkedInBy,
    checked_in_at: registration.checkedInAt.toString(),
    no_show_marked_at: registration.noShowMarkedAt.toString(),
    synced_at: new Date().toISOString(),
  };
}
