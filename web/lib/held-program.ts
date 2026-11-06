import {
  AccountRole,
  address,
  compileTransaction,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token";
import type { AppClient } from "@/components/providers";

export const DEVNET_USDC_MINT =
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const SYSTEM_PROGRAM_ADDRESS =
  address("11111111111111111111111111111111");
export const RENT_SYSVAR_ADDRESS =
  address("SysvarRent111111111111111111111111111111111");

const EVENT_DISCRIMINATOR = new Uint8Array([
  125, 192, 125, 158, 9, 115, 152, 233,
]);
const REGISTRATION_DISCRIMINATOR = new Uint8Array([
  158, 129, 230, 90, 93, 95, 101, 55,
]);
const IX = {
  initializeEvent: [126, 249, 86, 221, 202, 171, 134, 20],
  updateEvent: [70, 108, 211, 125, 171, 176, 25, 217],
  reserveSeat: [42, 147, 222, 136, 162, 134, 183, 168],
  cancelRegistration: [238, 114, 1, 94, 90, 159, 183, 53],
  checkIn: [149, 45, 160, 150, 236, 156, 168, 14],
  refund: [127, 171, 91, 29, 143, 55, 70, 98],
  cancelEvent: [55, 143, 36, 45, 59, 241, 89, 119],
  refundNoShow: [83, 21, 254, 51, 123, 143, 30, 125],
  finalizeNoShow: [246, 224, 115, 223, 47, 71, 68, 116],
  withdrawEligibleFunds: [125, 209, 36, 132, 152, 88, 148, 105],
} as const;

const encoder = new TextEncoder();
const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

export type EventAccount = {
  address: Address;
  organizer: Address;
  mint: Address;
  eventSeed: Uint8Array;
  name: string;
  description: string;
  location: string;
  timeZone: string;
  eventStartAt: bigint;
  depositAmount: bigint;
  capacity: number;
  reservedCount: number;
  heldAmount: bigint;
  registrationOpenAt: bigint;
  registrationCloseAt: bigint;
  cancellationDeadline: bigint;
  checkInStartAt: bigint;
  checkInEndAt: bigint;
  legacyDisputeWindowSeconds: bigint;
  policyHash: Uint8Array;
  status: "active" | "cancelled";
};

export type RegistrationAccount = {
  address: Address;
  event: Address;
  attendee: Address;
  depositAmount: bigint;
  policyHash: Uint8Array;
  reservationStatus: "confirmed" | "cancelled";
  attendanceStatus: "not_checked_in" | "checked_in" | "no_show_pending" | "disputed";
  settlementStatus: "held" | "refunded" | "paid_to_organizer";
  checkedInBy: Address;
  checkedInAt: bigint;
  noShowMarkedAt: bigint;
};

export type HeldRpcClient = Pick<AppClient, "rpc">;

export type NewEventInput = {
  name: string;
  description: string;
  location: string;
  timeZone: string;
  eventStartAt: bigint;
  depositAmount: bigint;
  capacity: number;
  registrationOpenAt: bigint;
  registrationCloseAt: bigint;
  cancellationDeadline: bigint;
  checkInStartAt: bigint;
  checkInEndAt: bigint;
};

export function getProgramAddress(): Address {
  const raw = process.env.NEXT_PUBLIC_HELD_PROGRAM_ID;
  if (!raw) throw new Error("HELD Devnet program ID is not configured.");
  if (raw === String(SYSTEM_PROGRAM_ADDRESS)) {
    throw new Error("HELD Devnet program ID is still the undeployed placeholder.");
  }
  return address(raw);
}

export function isHeldConfigured(): boolean {
  const programId = process.env.NEXT_PUBLIC_HELD_PROGRAM_ID;
  return Boolean(
    programId &&
      programId !== String(SYSTEM_PROGRAM_ADDRESS) &&
      process.env.NEXT_PUBLIC_USDC_MINT === DEVNET_USDC_MINT,
  );
}

export function getUsdcMintAddress(): Address {
  const raw = process.env.NEXT_PUBLIC_USDC_MINT;
  if (!raw || raw !== DEVNET_USDC_MINT) {
    throw new Error(
      "Configure NEXT_PUBLIC_USDC_MINT with the supported Solana Devnet USDC mint.",
    );
  }
  return address(raw);
}

function assertMintData(
  mintAddress: Address,
  info: { owner: Address; data: readonly [string, "base64"] } | null,
): number {
  if (!info) throw new Error("The configured USDC mint does not exist on Devnet.");
  if (info.owner !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error("The configured USDC mint is not owned by the SPL Token program.");
  }
  const bytes = decodeBase64(info.data[0]);
  if (bytes.length !== 82 || bytes[45] !== 1 || bytes[44] !== 6) {
    throw new Error("The configured Devnet USDC mint has an unexpected layout or decimals.");
  }
  if (mintAddress !== DEVNET_USDC_MINT) {
    throw new Error("The configured mint does not match the supported Devnet USDC mint.");
  }
  return bytes[44];
}

export async function verifyUsdcMint(client: HeldRpcClient): Promise<number> {
  const mint = getUsdcMintAddress();
  const account = await client.rpc
    .getAccountInfo(mint, { commitment: "confirmed", encoding: "base64" })
    .send();
  return assertMintData(mint, account.value);
}

export async function deriveEventAddress(
  programId: Address,
  organizer: Address,
  eventSeed: Uint8Array,
): Promise<Address> {
  const [eventAddress] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["event", addressEncoder.encode(organizer), eventSeed],
  });
  return eventAddress;
}

export async function deriveRegistrationAddress(
  programId: Address,
  eventAddress: Address,
  attendee: Address,
): Promise<Address> {
  const [registrationAddress] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      "registration",
      addressEncoder.encode(eventAddress),
      addressEncoder.encode(attendee),
    ],
  });
  return registrationAddress;
}

async function deriveVaultAddress(
  programId: Address,
  registrationAddress: Address,
): Promise<Address> {
  const [vaultAddress] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["vault", addressEncoder.encode(registrationAddress)],
  });
  return vaultAddress;
}

export async function createEventInstruction(
  client: AppClient,
  programId: Address,
  organizer: Address,
  input: NewEventInput,
): Promise<{ instruction: Instruction; eventAddress: Address }> {
  await validateNewEventInput(input);
  await verifyUsdcMint(client);
  const mint = getUsdcMintAddress();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const policyHash = await hashBytes(
    encoder.encode(
      JSON.stringify({
        version: 3,
        mint,
        depositAmount: input.depositAmount.toString(),
        eventStartAt: input.eventStartAt.toString(),
        timeZone: input.timeZone,
        cancellationDeadline: input.cancellationDeadline.toString(),
        checkInStartAt: input.checkInStartAt.toString(),
        checkInEndAt: input.checkInEndAt.toString(),
        attendanceRefund: "full",
        timelyCancellationRefund: "full",
        organizerCancellationRefund: "full",
        noShowDisposition: "organizer_decides_refund_or_payout_after_no_show",
      }),
    ),
  );
  const eventAddress = await deriveEventAddress(programId, organizer, seed);
  const writer = new ByteWriter();
  writer.bytes(IX.initializeEvent);
  writer.bytes(seed);
  writer.string(input.name, 96);
  writer.string(input.description, 512);
  writer.string(input.location, 160);
  writer.string(input.timeZone, 64);
  writer.i64(input.eventStartAt);
  writer.u64(input.depositAmount);
  writer.u32(input.capacity);
  writer.i64(input.registrationOpenAt);
  writer.i64(input.registrationCloseAt);
  writer.i64(input.cancellationDeadline);
  writer.i64(input.checkInStartAt);
  writer.i64(input.checkInEndAt);
  writer.i64(0n);
  writer.bytes(policyHash);

  return {
    eventAddress,
    instruction: {
      programAddress: programId,
      accounts: [
        { address: organizer, role: AccountRole.WRITABLE_SIGNER },
        { address: eventAddress, role: AccountRole.WRITABLE },
        { address: mint, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: writer.finish(),
    },
  };
}

export async function updateEventInstruction(
  programId: Address,
  organizer: Address,
  event: Address,
  input: Pick<NewEventInput, "name" | "description" | "location">,
): Promise<Instruction> {
  const writer = new ByteWriter();
  writer.bytes(IX.updateEvent);
  writer.string(input.name, 96);
  writer.string(input.description, 512);
  writer.string(input.location, 160);
  return {
    programAddress: programId,
    accounts: [
      { address: organizer, role: AccountRole.READONLY_SIGNER },
      { address: event, role: AccountRole.WRITABLE },
    ],
    data: writer.finish(),
  };
}

export async function reserveSeatInstructions(
  client: AppClient,
  programId: Address,
  event: EventAccount,
  attendee: Address,
): Promise<{
  instructions: Instruction[];
  qrPayload: string;
  registrationAddress: Address;
}> {
  await verifyUsdcMint(client);
  const registration = await deriveRegistrationAddress(
    programId,
    event.address,
    attendee,
  );
  const vault = await deriveVaultAddress(programId, registration);
  const credentialPayload = `HELD1|${event.address}|${attendee}|${registration}`;
  const credentialHash = await hashBytes(encoder.encode(credentialPayload));
  const mint = getUsdcMintAddress();
  const [attendeeToken] = await findAssociatedTokenPda({
    owner: attendee,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint,
  });

  if (!client.payer) throw new Error("Connect a Solana wallet before reserving.");
  const createAta =
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: client.payer,
      ata: attendeeToken,
      owner: attendee,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

  const writer = new ByteWriter();
  writer.bytes(IX.reserveSeat);
  writer.bytes(credentialHash);
  return {
    instructions: [
      createAta,
      {
        programAddress: programId,
        accounts: [
          { address: attendee, role: AccountRole.WRITABLE_SIGNER },
          { address: event.address, role: AccountRole.WRITABLE },
          { address: registration, role: AccountRole.WRITABLE },
          { address: vault, role: AccountRole.WRITABLE },
          { address: mint, role: AccountRole.READONLY },
          { address: attendeeToken, role: AccountRole.WRITABLE },
          { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
          { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
          { address: RENT_SYSVAR_ADDRESS, role: AccountRole.READONLY },
        ],
        data: writer.finish(),
      },
    ],
    qrPayload: credentialPayload,
    registrationAddress: registration,
  };
}

export async function cancelRegistrationInstruction(
  programId: Address,
  client: AppClient,
  event: EventAccount,
  attendee: Address,
): Promise<Instruction[]> {
  const registration = await deriveRegistrationAddress(
    programId,
    event.address,
    attendee,
  );
  const vault = await deriveVaultAddress(programId, registration);
  const mint = getUsdcMintAddress();
  const [attendeeToken] = await findAssociatedTokenPda({
    owner: attendee,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint,
  });
  await verifyUsdcMint(client);
  if (!client.payer) {
    throw new Error("Connect a Solana wallet before preparing this cancellation.");
  }
  const createAttendeeAta =
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: client.payer,
      ata: attendeeToken,
      owner: attendee,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
  return [createAttendeeAta, {
    programAddress: programId,
    accounts: [
      { address: attendee, role: AccountRole.READONLY_SIGNER },
      { address: event.address, role: AccountRole.WRITABLE },
      { address: registration, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: attendeeToken, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: Uint8Array.from(IX.cancelRegistration),
  }];
}

export function checkInInstruction(
  programId: Address,
  event: EventAccount,
  organizer: Address,
  credentialPayload: string,
): Promise<Instruction> {
  return (async () => {
    const parsed = parseCredential(credentialPayload);
    if (parsed.event !== event.address) {
      throw new Error("This QR pass belongs to a different event.");
    }
    const derivedRegistration = await deriveRegistrationAddress(
      programId,
      event.address,
      parsed.attendee,
    );
    if (derivedRegistration !== parsed.registration) {
      throw new Error("This QR pass has an invalid registration reference.");
    }
    const writer = new ByteWriter();
    writer.bytes(IX.checkIn);
    writer.bytes(await hashBytes(encoder.encode(credentialPayload)));
    return {
      programAddress: programId,
      accounts: [
        { address: organizer, role: AccountRole.READONLY_SIGNER },
        { address: event.address, role: AccountRole.READONLY },
        { address: parsed.registration, role: AccountRole.WRITABLE },
      ],
      data: writer.finish(),
    };
  })();
}

export function cancelEventInstruction(
  programId: Address,
  event: EventAccount,
  organizer: Address,
): Instruction {
  return {
    programAddress: programId,
    accounts: [
      { address: organizer, role: AccountRole.READONLY_SIGNER },
      { address: event.address, role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.from(IX.cancelEvent),
  };
}

export function refundInstruction(
  programId: Address,
  client: AppClient,
  event: EventAccount,
  registration: RegistrationAccount,
  caller: Address,
): Promise<Instruction[]> {
  return refundLikeInstructions(
    programId,
    client,
    event,
    registration,
    caller,
    "refund",
  );
}

export function refundNoShowInstruction(
  programId: Address,
  client: AppClient,
  event: EventAccount,
  registration: RegistrationAccount,
  organizer: Address,
): Promise<Instruction[]> {
  return refundLikeInstructions(
    programId,
    client,
    event,
    registration,
    organizer,
    "refundNoShow",
  );
}

export function finalizeNoShowInstruction(
  programId: Address,
  event: EventAccount,
  caller: Address,
  registration: RegistrationAccount,
): Instruction {
  return {
    programAddress: programId,
    accounts: [
      { address: caller, role: AccountRole.READONLY_SIGNER },
      { address: event.address, role: AccountRole.READONLY },
      { address: registration.address, role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.from(IX.finalizeNoShow),
  };
}

export async function withdrawEligibleFundsInstructions(
  client: AppClient,
  programId: Address,
  event: EventAccount,
  organizer: Address,
  registration: RegistrationAccount,
): Promise<Instruction[]> {
  await verifyUsdcMint(client);
  const mint = getUsdcMintAddress();
  const vault = await deriveVaultAddress(programId, registration.address);
  const [organizerToken] = await findAssociatedTokenPda({
    owner: organizer,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint,
  });
  if (!client.payer) {
    throw new Error("Connect a Solana wallet before settling a no-show deposit.");
  }
  const createOrganizerAta =
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: client.payer,
      ata: organizerToken,
      owner: organizer,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
  return [createOrganizerAta, {
    programAddress: programId,
    accounts: [
      { address: organizer, role: AccountRole.WRITABLE_SIGNER },
      { address: event.address, role: AccountRole.WRITABLE },
      { address: registration.address, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: organizerToken, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: Uint8Array.from(IX.withdrawEligibleFunds),
  }];
}

async function refundLikeInstructions(
  programId: Address,
  client: AppClient,
  event: EventAccount,
  registration: RegistrationAccount,
  caller: Address,
  instructionName: "refund" | "refundNoShow",
): Promise<Instruction[]> {
  const mint = getUsdcMintAddress();
  const vault = await deriveVaultAddress(programId, registration.address);
  const [beneficiaryToken] = await findAssociatedTokenPda({
    owner: registration.attendee,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint,
  });
  if (!client.payer) throw new Error("Connect a Solana wallet before preparing this refund.");
  const createBeneficiaryAta =
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: client.payer,
      ata: beneficiaryToken,
      owner: registration.attendee,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
  const writer = new ByteWriter();
  writer.bytes(IX[instructionName]);
  return [createBeneficiaryAta, {
    programAddress: programId,
    accounts: [
      { address: caller, role: AccountRole.READONLY_SIGNER },
      { address: event.address, role: AccountRole.WRITABLE },
      { address: registration.address, role: AccountRole.WRITABLE },
      { address: registration.attendee, role: AccountRole.READONLY },
      { address: vault, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: beneficiaryToken, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: writer.finish(),
  }];
}

export async function loadEvents(client: HeldRpcClient): Promise<EventAccount[]> {
  const programId = getProgramAddress();
  const filter = {
    memcmp: {
      offset: 0n,
      bytes: encodeBase58(EVENT_DISCRIMINATOR),
      encoding: "base58" as const,
    },
  };
  const response = await client.rpc
    .getProgramAccounts(programId, {
      commitment: "confirmed",
      encoding: "base64",
      filters: [filter],
    })
    .send();
  return Promise.all(
    response.map(async ({ pubkey, account }) => {
      if (account.owner !== programId) {
        throw new Error("RPC returned an event account with an unexpected owner.");
      }
      const event = decodeEventAccount(pubkey, decodeBase64(account.data[0]));
      const expectedAddress = await deriveEventAddress(
        programId,
        event.organizer,
        event.eventSeed,
      );
      if (event.address !== expectedAddress) {
        throw new Error("Event PDA does not match its stored organizer and seed.");
      }
      return event;
    }),
  );
}

export async function loadEvent(
  client: HeldRpcClient,
  rawAddress: string,
): Promise<EventAccount> {
  const programId = getProgramAddress();
  const eventAddress = address(rawAddress);
  const response = await client.rpc
    .getAccountInfo(eventAddress, {
      commitment: "confirmed",
      encoding: "base64",
    })
    .send();
  if (!response.value || response.value.owner !== programId) {
    throw new Error("Event not found on the configured HELD program.");
  }
  const event = decodeEventAccount(eventAddress, decodeBase64(response.value.data[0]));
  const expectedAddress = await deriveEventAddress(
    programId,
    event.organizer,
    event.eventSeed,
  );
  if (event.address !== expectedAddress) {
    throw new Error("Event PDA does not match its stored organizer and seed.");
  }
  return event;
}

export async function loadRegistrations(
  client: HeldRpcClient,
  attendee: Address,
): Promise<RegistrationAccount[]> {
  const programId = getProgramAddress();
  const filter = {
    memcmp: {
      offset: 0n,
      bytes: encodeBase58(REGISTRATION_DISCRIMINATOR),
      encoding: "base58" as const,
    },
  };
  const attendeeFilter = {
    memcmp: {
      offset: 40n,
      bytes: encodeBase58(addressEncoder.encode(attendee)),
      encoding: "base58" as const,
    },
  };
  const response = await client.rpc
    .getProgramAccounts(programId, {
      commitment: "confirmed",
      encoding: "base64",
      filters: [filter, attendeeFilter],
    })
    .send();
  return Promise.all(response.map(async ({ pubkey, account }) => {
    if (account.owner !== programId) {
      throw new Error("RPC returned a registration with an unexpected owner.");
    }
    const registration = decodeRegistrationAccount(
      pubkey,
      decodeBase64(account.data[0]),
    );
    const expectedAddress = await deriveRegistrationAddress(
      programId,
      registration.event,
      attendee,
    );
    if (
      registration.attendee !== attendee ||
      registration.address !== expectedAddress
    ) {
      throw new Error("Registration attendee does not match the RPC query.");
    }
    return registration;
  }));
}

export async function loadRegistrationHistory(
  client: HeldRpcClient,
  registrationAddress: Address,
): Promise<
  { signature: string; blockTime: number | null; failed: boolean }[]
> {
  const transactions = await client.rpc
    .getSignaturesForAddress(registrationAddress, {
      commitment: "confirmed",
      limit: 20,
    })
    .send();
  return transactions.map(({ signature, blockTime, err }) => ({
    signature: String(signature),
    blockTime: blockTime == null ? null : Number(blockTime),
    failed: err !== null,
  }));
}

export async function loadEventRegistrations(
  client: HeldRpcClient,
  eventAddress: Address,
): Promise<RegistrationAccount[]> {
  const programId = getProgramAddress();
  const filter = {
    memcmp: {
      offset: 0n,
      bytes: encodeBase58(REGISTRATION_DISCRIMINATOR),
      encoding: "base58" as const,
    },
  };
  const eventFilter = {
    memcmp: {
      offset: 8n,
      bytes: encodeBase58(addressEncoder.encode(eventAddress)),
      encoding: "base58" as const,
    },
  };
  const response = await client.rpc
    .getProgramAccounts(programId, {
      commitment: "confirmed",
      encoding: "base64",
      filters: [filter, eventFilter],
    })
    .send();
  return Promise.all(
    response.map(async ({ pubkey, account }) => {
      if (account.owner !== programId) {
        throw new Error("RPC returned a registration with an unexpected owner.");
      }
      const registration = decodeRegistrationAccount(
        pubkey,
        decodeBase64(account.data[0]),
      );
      if (registration.event !== eventAddress) {
        throw new Error("Registration event does not match the RPC query.");
      }
      const expectedAddress = await deriveRegistrationAddress(
        programId,
        eventAddress,
        registration.attendee,
      );
      if (registration.address !== expectedAddress) {
        throw new Error("Registration PDA does not match its stored owner and event.");
      }
      return registration;
    }),
  );
}

export async function prepareTransaction(
  client: AppClient,
  instructions: readonly Instruction[],
): Promise<{ logs: string[]; unitsConsumed: number | null }> {
  const message = await client.planTransaction(instructions);
  const transaction = compileTransaction(message);
  const simulation = await client.rpc
    .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
      commitment: "confirmed",
      encoding: "base64",
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  if (simulation.value.err) {
    throw new Error(
      simulation.value.logs?.join("\n") || "Transaction simulation failed.",
    );
  }
  return {
    logs: simulation.value.logs ?? [],
    unitsConsumed:
      simulation.value.unitsConsumed == null
        ? null
        : Number(simulation.value.unitsConsumed),
  };
}

export async function sendTransaction(
  client: AppClient,
  instructions: readonly Instruction[],
): Promise<string> {
  const result = await client.sendTransaction(instructions);
  return result.context.signature;
}

export function parseCredential(payload: string): {
  event: Address;
  attendee: Address;
  registration: Address;
} {
  const [version, rawEvent, rawAttendee, rawRegistration, ...rest] =
    payload.split("|");
  if (version !== "HELD1" || !rawEvent || !rawAttendee || !rawRegistration || rest.length) {
    throw new Error("This is not a valid HELD attendance pass.");
  }
  return {
    event: address(rawEvent),
    attendee: address(rawAttendee),
    registration: address(rawRegistration),
  };
}

export function formatUsdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fractional = (amount % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `$${whole.toLocaleString("en-US")}.${fractional.padEnd(2, "0")}`;
}

function decodeEventAccount(
  accountAddress: Address,
  data: Uint8Array,
): EventAccount {
  const reader = new ByteReader(data);
  reader.assertDiscriminator(EVENT_DISCRIMINATOR);
  const organizer = reader.address();
  const mint = reader.address();
  const eventSeed = reader.bytes(32);
  const name = reader.string(96);
  const description = reader.string(512);
  const location = reader.string(160);
  const timeZone = reader.string(64);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error("Event account contains an unsupported time zone.");
  }
  const eventStartAt = reader.i64();
  const depositAmount = reader.u64();
  const capacity = reader.u32();
  const reservedCount = reader.u32();
  const heldAmount = reader.u64();
  const registrationOpenAt = reader.i64();
  const registrationCloseAt = reader.i64();
  const cancellationDeadline = reader.i64();
  const checkInStartAt = reader.i64();
  const checkInEndAt = reader.i64();
  const legacyDisputeWindowSeconds = reader.i64();
  const policyHash = reader.bytes(32);
  const statusValue = reader.u8();
  if (statusValue > 1) throw new Error("Event account has an unknown status.");
  reader.u8();
  return {
    address: accountAddress,
    organizer,
    mint,
    eventSeed,
    name,
    description,
    location,
    timeZone,
    eventStartAt,
    depositAmount,
    capacity,
    reservedCount,
    heldAmount,
    registrationOpenAt,
    registrationCloseAt,
    cancellationDeadline,
    checkInStartAt,
    checkInEndAt,
    legacyDisputeWindowSeconds,
    policyHash,
    status: statusValue === 0 ? "active" : "cancelled",
  };
}

function decodeRegistrationAccount(
  accountAddress: Address,
  data: Uint8Array,
): RegistrationAccount {
  const reader = new ByteReader(data);
  reader.assertDiscriminator(REGISTRATION_DISCRIMINATOR);
  const event = reader.address();
  const attendee = reader.address();
  const depositAmount = reader.u64();
  const policyHash = reader.bytes(32);
  reader.bytes(32);
  const reservationStatusValue = reader.u8();
  const attendanceStatusValue = reader.u8();
  const settlementStatusValue = reader.u8();
  const checkedInBy = reader.address();
  const checkedInAt = reader.i64();
  reader.u8();
  reader.u8();
  const noShowMarkedAt = reader.i64();
  if (
    reservationStatusValue > 1 ||
    attendanceStatusValue > 3 ||
    settlementStatusValue > 2
  ) {
    throw new Error("Registration account has an unknown status.");
  }
  return {
    address: accountAddress,
    event,
    attendee,
    depositAmount,
    policyHash,
    reservationStatus: reservationStatusValue === 0 ? "confirmed" : "cancelled",
    attendanceStatus: [
      "not_checked_in",
      "checked_in",
      "no_show_pending",
      "disputed",
    ][attendanceStatusValue] as RegistrationAccount["attendanceStatus"],
    settlementStatus: ["held", "refunded", "paid_to_organizer"][
      settlementStatusValue
    ] as RegistrationAccount["settlementStatus"],
    checkedInBy,
    checkedInAt,
    noShowMarkedAt,
  };
}

async function validateNewEventInput(input: NewEventInput): Promise<void> {
  const nameLength = encoder.encode(input.name.trim()).length;
  const descriptionLength = encoder.encode(input.description).length;
  const locationLength = encoder.encode(input.location).length;
  const timeZoneLength = encoder.encode(input.timeZone.trim()).length;
  if (
    !nameLength ||
    nameLength > 96 ||
    descriptionLength > 512 ||
    locationLength > 160 ||
    !timeZoneLength ||
    timeZoneLength > 64
  ) {
    throw new Error("Event text exceeds the supported limits.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(new Date(0));
  } catch {
    throw new Error("Select a valid event time zone.");
  }
  if (
    input.depositAmount <= 0n ||
    !Number.isInteger(input.capacity) ||
    input.capacity < 1 ||
    input.capacity > 100_000
  ) {
    throw new Error("Enter a positive deposit and a capacity between 1 and 100,000.");
  }
  if (
    input.registrationOpenAt >= input.registrationCloseAt ||
    input.registrationCloseAt > input.checkInStartAt ||
    input.checkInStartAt > input.eventStartAt ||
    input.eventStartAt >= input.checkInEndAt ||
    input.cancellationDeadline < input.registrationOpenAt ||
    input.cancellationDeadline > input.checkInStartAt
  ) {
    throw new Error("The event schedule or cancellation deadline is inconsistent.");
  }
}

async function hashBytes(data: Uint8Array): Promise<Uint8Array> {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function encodeBase58(bytes: ArrayLike<number>): Base58EncodedBytes {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (let index = 0; index < bytes.length; index += 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = alphabet[remainder] + encoded;
    value /= 58n;
  }
  for (let index = 0; index < bytes.length && bytes[index] === 0; index += 1) {
    encoded = `1${encoded}`;
  }
  return (encoded || "1") as Base58EncodedBytes;
}

class ByteWriter {
  private readonly parts: Uint8Array[] = [];

  bytes(value: Uint8Array | readonly number[]) {
    this.parts.push(Uint8Array.from(value));
  }

  string(value: string, maxBytes: number) {
    const encoded = encoder.encode(value);
    if (encoded.length > maxBytes) {
      throw new Error(`Text must not exceed ${maxBytes} UTF-8 bytes.`);
    }
    this.u32(encoded.length);
    this.bytes(encoded);
  }

  u32(value: number) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error("Integer is outside the supported u32 range.");
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    this.bytes(bytes);
  }

  u64(value: bigint) {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw new Error("Amount is outside the supported u64 range.");
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    this.bytes(bytes);
  }

  i64(value: bigint) {
    if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) {
      throw new Error("Timestamp is outside the supported i64 range.");
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, value, true);
    this.bytes(bytes);
  }

  finish(): Uint8Array {
    const length = this.parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of this.parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }
}

class ByteReader {
  private offset = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly data: Uint8Array) {}

  assertDiscriminator(expected: Uint8Array) {
    const actual = this.bytes(expected.length);
    if (!actual.every((byte, index) => byte === expected[index])) {
      throw new Error("Account discriminator does not match the HELD account type.");
    }
  }

  bytes(length: number): Uint8Array {
    const end = this.offset + length;
    if (length < 0 || end > this.data.length) {
      throw new Error("Account data is truncated.");
    }
    const result = this.data.slice(this.offset, end);
    this.offset = end;
    return result;
  }

  address(): Address {
    return this.decoderAddress(this.bytes(32));
  }

  string(maxBytes: number): string {
    const length = this.u32();
    if (length > maxBytes) throw new Error("Account text exceeds its size limit.");
    return this.decoder.decode(this.bytes(length));
  }

  u8(): number {
    return this.bytes(1)[0];
  }

  u32(): number {
    return new DataView(this.bytes(4).buffer).getUint32(0, true);
  }

  u64(): bigint {
    return new DataView(this.bytes(8).buffer).getBigUint64(0, true);
  }

  i64(): bigint {
    return new DataView(this.bytes(8).buffer).getBigInt64(0, true);
  }

  private decoderAddress(bytes: Uint8Array): Address {
    return addressDecoder.decode(bytes);
  }
}
