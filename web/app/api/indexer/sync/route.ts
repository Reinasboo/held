import {
  getProgramAddress,
  loadEventRegistrations,
  loadEvents,
  loadRegistrationHistory,
} from "@/lib/held-program";
import {
  authorizeWorker,
  createHeldRpcClient,
} from "@/lib/server/runtime";
import {
  queryDatabase,
  upsertEventSnapshots,
  upsertRegistrationSnapshots,
  upsertTransactionSnapshots,
} from "@/lib/server/database";

async function inBatches<T, R>(
  values: T[],
  batchSize: number,
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    results.push(
      ...(await Promise.all(values.slice(offset, offset + batchSize).map(action))),
    );
  }
  return results;
}

export async function POST(request: Request) {
  const authorizationError = authorizeWorker(request);
  if (authorizationError) return authorizationError;

  try {
    const rpc = createHeldRpcClient();
    const programId = getProgramAddress();
    const events = await loadEvents(rpc);
    const registrationsByEvent = await inBatches(
      events,
      8,
      (event) => loadEventRegistrations(rpc, event.address),
    );
    const registrations = registrationsByEvent.flat();

    await upsertEventSnapshots(events);
    await upsertRegistrationSnapshots(registrations);

    const histories = await inBatches(
      registrations,
      8,
      async (registration) => ({
        registration,
        transactions: await loadRegistrationHistory(rpc, registration.address),
      }),
    );
    const transactionRows = histories.flatMap(({ registration, transactions }) =>
      transactions.map((transaction) => ({
        signature: transaction.signature,
        event_address: registration.event,
        registration_address: registration.address,
        block_time: transaction.blockTime,
        failed: transaction.failed,
        indexed_at: new Date().toISOString(),
      })),
    );
    await upsertTransactionSnapshots(transactionRows);

    const [reminders] = await queryDatabase<{ queued: number | string }>(
      "select public.queue_held_event_reminders() as queued",
    );
    if (!reminders) throw new Error("The reminder queue returned no result.");

    return Response.json({
      programId,
      eventsIndexed: events.length,
      registrationsIndexed: registrations.length,
      transactionsIndexed: transactionRows.length,
      remindersQueued: Number(reminders.queued),
      commitment: "confirmed",
    });
  } catch (reason) {
    return Response.json(
      {
        error:
          reason instanceof Error
            ? reason.message
            : "The chain indexer failed to synchronize.",
      },
      { status: 500 },
    );
  }
}
