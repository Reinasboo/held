# HELD — Codex Build Plan

## Mission

Build HELD as a polished, working hackathon MVP: an event organizer publishes a limited-capacity event with a clearly disclosed refundable USDC commitment; an attendee reserves a place; an authorized organizer checks in the attendee; and the deposit is refunded and independently verifiable on Solana Devnet.

HELD is the refundable commitment layer for events, not a replacement ticketing or event-discovery platform. Preserve the product promise:

> Your place is reserved. Your money comes back when you show up.

The attendee must understand the deposit and refund conditions before signing. The Solana program—not a backend database flag—must enforce custody and settlement rules.

## How to execute this plan

1. Inspect the existing repository, instructions, package scripts, and tests before changing anything. Preserve established frameworks, conventions, and user changes. If no application exists, scaffold the smallest maintainable implementation that satisfies this plan.
2. Implement in the phases below. Keep the reservation-to-refund path working end to end before adding optional integrations or breadth.
3. Before each phase, identify its files, risks, and acceptance checks. After it, run the smallest relevant tests and report what passed or is blocked.
4. Do not claim a Devnet transaction, integration, or user metric exists unless it has actually been exercised and verified. Keep secrets out of source control.
5. If a necessary product or security decision cannot be resolved from this plan, stop and document the specific decision rather than inventing a financial rule.

## Product and user requirements

### Attendee journey

1. Open a shareable event link. Show the event name, description, date/time and time zone, location, organizer, remaining capacity, exact deposit asset and amount, cancellation deadline, check-in window, and no-show forfeiture/refund policy before connecting a wallet or requesting payment.
2. Connect a Solana Wallet Standard-compatible wallet (Phantom is an example). Support USDC on Devnet for the hackathon. Display the exact transaction and its pending, confirmed, failed, or expired status.
3. After the on-chain reservation is confirmed, show a confirmed reservation, unique registration reference, digital QR pass, and deposit status. Provide a reservation dashboard with upcoming events, cancellation eligibility, pass, and transaction history.
4. Allow cancellation before the published deadline with a full refund. Explain and reject cancellation after the deadline according to the policy.
5. Present the QR pass to an authorized organizer. On a valid check-in, record attendance and release the refund. Show its transaction and a Solana Explorer link.

### Organizer journey

1. Connect the organizer wallet and create an event with name, description, date/time, venue/location, capacity, registration open/close dates, deposit amount, cancellation deadline, check-in window, and no-show policy.
2. Publish an event page and shareable link. Display terms in attendee-facing views before commitment. Record a policy version or hash with each reservation so later edits cannot silently change accepted terms.
3. View registrations, remaining capacity, deposits held, cancellations, attendance/check-in progress, pending no-show decisions, refund status, and final settlement.
4. Scan QR passes with the organizer check-in interface. Reject invalid, wrong-event, expired, unauthorized, and duplicate scans without moving funds.
5. Cancel an event and return every affected attendee’s full deposit. Provide a settlement report with verifiable transaction links.

### Product principles

- **Fairness:** a deposit is a disclosed commitment, not a hidden admission fee.
- **Transparency:** terms, status transitions, and on-chain deposits/refunds are visible.
- **Simplicity:** keep blockchain mechanics out of the way; explain wallet approval and transaction status in plain language.
- **Reliability:** handle confirmation delays, failed transactions, retries, and recovery without showing success prematurely.
- **Organizer independence:** provide a shareable HELD link that can accompany an existing Luma, Eventbrite, Meetup, Partiful, or other event workflow; do not require platform migration.
- **Trust:** restrict check-in authority, preserve evidence, and disclose that no-show records and refunds are controlled by the organizer.
- HELD revenue must not depend on attendees failing to attend. Do not describe the product as unprecedented; Jamao already operates in the refundable event-deposit category. Differentiate through platform independence, transparent on-chain settlement, and execution.

## MVP scope and explicit deferrals

### Required for the hackathon

- Responsive consumer and organizer web application.
- Event creation, configuration, publication, capacity enforcement, and shareable event page.
- Solana wallet connection and USDC Devnet deposits.
- Anchor/Rust program with event and registration state, program-controlled token escrow, cancellation, event cancellation, authorized check-in, refund, no-show, and safe settlement transitions.
- QR pass creation and organizer scanner with duplicate-scan protection.
- Backend persistence/indexing for event metadata and dashboards, with reconciliation against chain state.
- Confirmation/refund notifications, transaction status, Explorer links, and event settlement reporting.
- A complete demo lifecycle and meaningful failure-case coverage.

### Defer until the core lifecycle is reliable

- Full event marketplace, large-scale discovery, native mobile apps.
- Full Luma/Eventbrite integrations, public API, embeddable widgets, webhooks, and platform partnerships.
- Complex subscriptions, enterprise analytics, AI attendance prediction.
- Multi-chain funding as a dependency of core registration.
- Mainnet deployment or claims of production readiness.

### Optional bounty work

Aurora Intents may be added only after the standalone Solana reservation, check-in, refund, and cancellation flows pass their acceptance checks. Keep it behind an isolated integration boundary. If implemented, demonstrate an actual quote, source-chain authorization, settlement monitoring, Solana destination confirmation, and clear incomplete/failed-transfer handling. The Solana flow must remain complete without it. Do not add x402 solely for eligibility.

## Architecture

Use the repository’s existing stack if present. If greenfield, use the product vision’s proposed stack:

- **Web:** Next.js, TypeScript, Tailwind CSS, responsive accessible components.
- **Wallet:** Solana Wallet Standard-compatible wallet adapter and explicit Devnet configuration.
- **Program:** Solana, Anchor, Rust, SPL Token/Token-2022 only if justified by the chosen USDC mint and SDK support.
- **Application data:** Neon/PostgreSQL for event metadata, registration display/indexing, and organizer views; Neon Object Storage for private event-cover uploads; Neon Realtime for organizer-dashboard refreshes. Chain state is authoritative for funds and settlement.
- **Notifications:** Resend for confirmation, cancellation, reminder, and refund messages; make delivery failures visible and retryable.
- **Passes:** QR generation/scanning with an opaque or signed, event-scoped credential. A QR is not a wallet key, bearer right to funds, or authorization to perform a financial instruction.
- **Explorer:** Link to the relevant Devnet transaction and account.

Keep the program client, backend, and UI boundaries explicit. Validate input at boundaries. Do not trust database status for money movement, capacity, attendance authorization, or refund eligibility. Backend transaction indexing must be idempotent and reconcile pending/off-chain records with confirmed chain state.

Use environment variables for RPC, program ID, USDC mint, Neon Postgres, and email credentials. Validate required configuration at startup and clearly label network and token. Never hard-code a production secret or imply a token is USDC without verifying the configured mint and decimals.

## On-chain design and financial invariants

Design account layouts, PDA seeds, token-account ownership, and instruction authorization before implementation. Prefer isolated registration-level accounting so one attendee’s funds cannot be used to refund another attendee. The program-controlled vault/PDA must be the authority over escrowed tokens.

### Suggested accounts

- **Event:** organizer authority, unique event identifier, event status, capacity and confirmed count, deposit amount/mint, registration deadlines, cancellation deadline, check-in window, no-show forfeiture/refund policy, and policy version/hash.
- **Registration:** event reference, attendee wallet, exact deposit amount/mint, reservation/attendance/refund state, accepted policy version/hash, credential hash/reference, check-in timestamp and authority, no-show timestamp, and settlement guard.
- **Escrow vault:** registration-specific token account or equivalent isolated accounting controlled by a program PDA.

Keep layouts within Solana account-size limits and use checked arithmetic. Make PDA derivation and account constraints explicit and test them.

### Required instructions

Implement and test the equivalent of:

1. `initialize_event`
2. `update_event` (only before the affected terms are committed to; preserve accepted policy versions)
3. `reserve_seat`
4. `cancel_registration`
5. `check_in_attendee`
6. `refund_attendee`
7. `cancel_event`
8. `refund_no_show` (organizer-authorized)
9. `finalize_no_show`
10. `withdraw_eligible_funds` for the organizer's explicitly disclosed no-show payout

Names may follow existing conventions, but all financial transitions and their authorization must be equivalent. Enforce capacity on-chain in the same atomic reservation operation that accepts a deposit. Validate event status, dates, mint, token program, source/destination token accounts, signer ownership, authority, amount, and current state on every relevant instruction.

### State and invariants

Represent reservation, attendance, and financial settlement as explicit, guarded state (separate enums/fields are preferable to an ambiguous single status). Support the vision’s lifecycle concepts: `CREATED`, `DEPOSITED`, `CONFIRMED`, `CANCELLED`, `CHECKED_IN`, `REFUND_PENDING`, `REFUNDED`, `NO_SHOW_PENDING`, and `SETTLED`.

- A reservation is confirmed only after the deposit transaction is confirmed and the program records the deposit.
- Successful check-in is an attendance attestation by an authorized organizer/scanner, not independent proof of physical presence. Record who attested and when.
- A valid check-in entitles the attendee to a full refund. Cancellation before the published deadline and organizer cancellation also entitle the attendee to a full refund.
- **Selected no-show policy:** after the check-in window closes, only the event organizer may record a no-show. The attendee forfeits the deposit to the organizer; the organizer may instead choose to issue a full refund. There is no attendee dispute action or dispute window. Organizer event cancellation disables no-show payout and makes held deposits refundable. Disclose this policy before registration and enforce both organizer choices on-chain.
- A refund or settlement can move the vault’s funds at most once. Duplicate requests must be rejected safely (or return an explicitly documented idempotent result) without a second transfer.
- Organizer cancellation always produces full refunds. Ensure every affected registration can be refunded and the organizer cannot withdraw those funds.
- Reject invalid transitions, unauthorized check-ins/settlements, duplicate registration/check-in, expired credentials, and mismatched event or wallet.
- Define how a refund is retried if the transaction fails; do not mark it complete in the database until chain confirmation.

## UX and design direction

Create a calm, premium, trustworthy consumer-finance feel: refined dark surfaces, warm neutrals, restrained green for successful financial states, and clear typography. Prioritize event details, reservation status, deposit, refund conditions, and next action. Avoid neon/crypto clichés, token-price UI, unexplained jargon, and decorative blockchain graphics.

Build these MVP screens/states:

1. Landing page and concise product explanation.
2. Event list/discovery sufficient to find seeded or published events.
3. Event details and policy disclosure.
4. Wallet connect and deposit approval/status.
5. Reservation confirmation and QR pass.
6. Attendee reservations and deposit/transaction history.
7. Organizer event creation and configuration.
8. Organizer event/registration dashboard.
9. Check-in scanner and clear valid/invalid/duplicate states.
10. Settlement report and public transaction verification.

Include loading, empty, disconnected-wallet, rejected-signature, insufficient-USDC, network error, pending confirmation, failed transaction, cancelled event, expired registration, and unavailable-RPC states. Ensure keyboard accessibility, readable contrast, mobile layouts, and clear date/time zones. Never show a refund as complete based only on a wallet submission or backend write.

## Delivery phases and exit criteria

### Phase 0 — Repository reconnaissance and setup

- Inspect project structure, existing instructions, scripts, tests, and current worktree changes.
- Confirm supported Node/Rust/Anchor versions and existing conventions; document the local Devnet setup and required environment variables.
- Establish or preserve lint, type-check, unit-test, and build commands. Add only missing tooling needed by the selected architecture.

**Exit:** a concise implementation map, reproducible setup instructions, and passing baseline checks (or clearly recorded pre-existing failures).

### Phase 1 — Domain rules, data model, and UI skeleton

- Define event, policy, reservation, attendance, and settlement types; document valid transitions.
- Define chain/off-chain ownership of each field, event-policy versioning, QR credential validation, and the explicit no-show policy: organizer chooses payout or full refund after the organizer records a no-show.
- Scaffold the attendee and organizer routes and responsive design system with realistic empty/loading/error states.

**Exit:** every MVP field and state has an owner; users can navigate the main flows without misleading success states.

### Phase 2 — Anchor program and tests

- Implement accounts, PDAs, escrow, instructions, authorization, deadlines, capacity, and state guards.
- Add Anchor tests for successful deposit/refund/cancellation/event cancellation/check-in, and for unauthorized signers, full capacity/racing reservations, wrong mint/amount/event, premature/late action, duplicate action, invalid transition, disabled attendee disputes, organizer no-show refund, and immediate organizer payout.
- Verify token accounting and that funds cannot be withdrawn or cross-used contrary to policy.

**Exit:** program tests demonstrate all financial invariants locally; no mainnet deployment.

### Phase 3 — Solana client and attendee registration

- Add wallet connection and Devnet transaction client.
- Read the configured USDC mint/decimals; implement event reads, reservation, deposit confirmation, cancellation, refund status, and Explorer links.
- Generate a QR credential only after a confirmed reservation; provide a dashboard backed by verified chain state and indexed metadata.

**Exit:** an attendee can reserve with Devnet USDC and see a confirmed registration only after chain confirmation.

### Phase 4 — Organizer, check-in, settlement, and backend

- Implement event creation/publication and organizer dashboard.
- Add authorized scanner flow and on-chain check-in, duplicate prevention, cancellation, and disclosed organizer-controlled no-show refund or payout.
- Add Neon/PostgreSQL schema and idempotent transaction indexing/reconciliation. Add Resend notifications with observable delivery failures and retry handling.
- Add organizer-authorized event-cover uploads and Neon Realtime dashboard subscriptions that refresh authoritative state from Solana.

**Exit:** organizer and attendee views remain consistent with chain state; check-in refunds exactly once; event cancellation refunds deposits.

### Phase 5 — End-to-end hardening and demo

- Exercise the full lifecycle on Devnet using real configured Devnet USDC.
- Test wallet rejection, insufficient balance, transaction failure/timeout/retry, duplicate scan, invalid QR, event-capacity race, cancellation before/after deadline, organizer cancellation, unauthorized no-show actions, organizer no-show refund/payout, and refund recovery.
- Verify all displayed transaction links and amounts against the relevant Devnet accounts/transactions.
- Record only actual demo metrics (events, reservations, commitment value, successful check-ins, refunds, attendance rate, failures, duplicate attempts rejected, and check-in-to-refund confirmation time).

**Exit:** the live end-to-end demo works repeatedly; no unresolved path can silently lose, double-refund, or misrepresent funds. Clearly label prototype limitations.

### Phase 6 — Optional Aurora Intents bounty

Only begin after Phase 5 passes. Isolate the integration, track actual source and destination settlement, and test incomplete/failed transfers without falsely confirming a reservation.

**Exit:** the core Solana flow passes unchanged with the integration disabled; an end-to-end cross-chain flow is demonstrated if claiming bounty completion.

## Acceptance criteria

The MVP is complete only when all of the following hold:

- An organizer can create and publish a capacity-limited event with all financial terms.
- An attendee sees the USDC amount, cancellation deadline, check-in/no-show forfeiture policy, and organizer refund discretion before authorizing a deposit.
- A confirmed reservation corresponds to an actual confirmed Devnet deposit; the vault and registration can be inspected on-chain.
- The program enforces capacity, correct attendee/organizer authorization, event windows, accepted policy version, and valid transitions.
- A timely attendee cancellation, organizer event cancellation, and successful authorized check-in each make a full refund available exactly once.
- A check-in requires an authorized scanner and valid event registration; an invalid or repeated scan cannot trigger another refund.
- Only the organizer can record a no-show and choose a full refund or payout; an attendee cannot dispute or redirect settlement.
- Failed or pending transactions are accurately represented; retries do not duplicate money movement.
- QR data does not expose a wallet secret or grant financial authority.
- Organizer settlement totals, attendee deposit/refund state, and public Explorer links agree with confirmed chain state.
- The interface is responsive, accessible, and explicit about Devnet/prototype status.
- Tests cover the important successful and adversarial transitions; lint/type-check/build and relevant tests pass.
- The main demo follows: create a free workshop (100 seats, $5 USDC refundable commitment) → publish link → reserve → show QR → authorized scan → refund → verify both transactions and updated organizer stats. Also demonstrate timely cancellation/refund and rejected invalid or duplicate check-in. Keep the presentation near three minutes.

## Security, compliance, and launch guardrails

- Treat all funds-handling code as security-critical. Add focused tests for every state transition and authorization boundary; request an independent smart-contract security review before any mainnet deployment.
- The Devnet implementation is a prototype, not proof of regulatory clearance. Before commercial launch, obtain appropriate review of payment, custody, consumer-protection, privacy, and event-deposit requirements.
- Do not deploy to mainnet, collect real funds, promise guaranteed physical attendance, or claim the QR independently proves presence.
- Avoid logging secrets, wallet credentials, private keys, or sensitive QR payloads. Use least privilege for organizer/scanner roles and protect attendee data.
- Do not conceal RPC, indexer, email, or transaction failures. Surface actionable errors and preserve a safe pending state when chain truth is unavailable.
- Avoid invented research claims or traction in the UI/pitch. Report metrics from actual test/demo data only.

## Post-hackathon roadmap (not MVP blockers)

1. **Product hardening:** independent security review, mainnet readiness, robust refund recovery, improved wallet onboarding, attendance correction and refund support, organizer teams/permissions, notifications, and production monitoring.
2. **Platform independence:** event-platform integrations, public API, embeddable commitment widgets, webhooks, and partnerships.
3. **Cross-chain access:** Aurora Intents and additional supported funding assets/wallet experiences.
4. **Commitment infrastructure:** expand to adjacent reservation use cases only after evidence of demand.

## Commercial and success context

The organizer is the primary paying customer; attendees receive the deposit/refund experience. Subscription hypotheses in the vision are Starter (free/limited events), Organizer ($19/month), Pro ($49/month), and Enterprise (custom), with any platform fee transparent. These are hypotheses, not MVP requirements; do not build subscription billing for the hackathon. HELD must not earn money by hoping attendees no-show.

For the hackathon, report measured event count, confirmed reservations, total commitment value, successful check-ins, attendance/refund/cancellation rates, failed transactions, rejected duplicate scans, and time from check-in to confirmed refund. The key long-term outcome is the difference between registered and actual attendance; validate it with real comparable event data rather than asserting improvement from a demo.
