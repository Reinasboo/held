# HELD

HELD is a refundable commitment layer for events. The hackathon MVP targets Solana Devnet and demonstrates a single attendee lifecycle: reserve with USDC, check in through an authorized organizer, and receive the deposit back.

## Project layout

- `web/` — Next.js attendee/organizer interface and Wallet Standard connection.
- `programs/held/` — Anchor escrow program.
- `CODEX_BUILD_PLAN.md` — product requirements, implementation phases, and acceptance criteria.

## Local web development

```powershell
Set-Location web
npm ci
Copy-Item .env.example .env.local
npm run dev
```

The sample event is explicitly a preview. The Devnet HELD program and supported Devnet USDC mint are configured in `web/.env.local`; the public values are also shown in `web/.env.example`. The app reads active events and attendee/organizer account state directly from Solana Devnet. Published event links use `/?event=<event-address>`. Do not enter real funds or treat preview content as a live event.

The current UI includes event publishing, attendee reservation/refund actions, QR passes, organizer scanning/check-in, event cancellation, dispute-to-refund handling, undisputed no-show settlement to the event organizer after the dispute window, RPC-backed registration transaction links, and organizer settlement reports.

## Vercel deployment

The Next.js app is deployed from `web/` to the Vercel project `heldevents`. Use the Vercel CLI with the approved account:

```powershell
Set-Location web
vercel link --yes --project heldevents
vercel deploy --prod --project heldevents --yes --verify
```

The project is configured for Node.js 24 and the public Devnet program, USDC mint, and RPC endpoint. The local `.env.local` and generated build files are excluded from deployment. Server-only Neon and Object Storage credentials, plus optional notification/email settings, must be configured in Vercel before their corresponding API routes can operate; do not commit or upload local secret files.

## Solana program

The configured HELD program ID is `6eCgrBQEMM3oo4AgvvvXwiEkd7zFKVQF983HwpwCZLDU`, and the Anchor provider targets Devnet. The repository provides `anchor-docker.ps1` to run the pinned Anchor 0.32.1 toolchain through Docker Desktop:

```powershell
.\anchor-docker.ps1 --version
.\anchor-docker.ps1 build
cargo test -p held --lib
```

The Docker wrapper reads the Devnet fee payer from `%USERPROFILE%\.config\solana-held\deployer.json` by default, or from `HELD_SOLANA_KEYS_PATH` if set. The fee-payer key stays outside the repository and is mounted read-only into the container. `.\anchor-docker.ps1 deploy` checks that the fee payer is `FEHuZ3HFUASS2rjrcgTE6k1DSTteqKH5mXbXG3irpRDc` and the existing Anchor program signer in `target/deploy/held-keypair.json` matches the configured program ID before submitting Devnet transactions. The program signer is ignored under `target/`; never commit it. Never share a seed phrase or secret key file. Use only Devnet for the hackathon. The program accepts a configured SPL Token mint; the UI and deployment process must verify the mint address and decimals before describing it as USDC.

The initial upgradeable Devnet deployment is finalized at program ID `6eCgrBQEMM3oo4AgvvvXwiEkd7zFKVQF983HwpwCZLDU` (transaction `5ccdKd7fP1rNmfsPKzpvJnmVdvtVsZgErXJMYx3VUeAW6mtUznEQ1mchnkRzEtBT6Znr3fPrx5fUcxRAuX5EfsdS`). The upgrade authority is the fee-payer wallet. Verify the deployment with `solana program show 6eCgrBQEMM3oo4AgvvvXwiEkd7zFKVQF983HwpwCZLDU --url devnet`; run local program tests with `cargo test -p held --lib`.

Post-deployment verification: the finalized Devnet ProgramData contains the same 415,112-byte executable as `target/deploy/held.so` (SHA-256 `4FE0591A58240B9B18F4F1408350FDC8CA86F3B440EBAE855CB5B36DFC90A19F`). The web production build, lint, TypeScript check, production HTTP smoke test, and all 7 Rust unit tests pass. The attendee test wallet has 20 Devnet USDC and the organizer fee payer has approximately 2.887 SOL. No HELD event accounts exist on Devnet yet, so the transaction lifecycle has not been exercised against the deployed program. Creating an event allocates a public on-chain account and currently requires 0.00610616 SOL in rent plus the transaction fee.

The selected no-show policy is: once the organizer records a no-show, the attendee has the event's disclosed dispute window to dispute it. An undisputed deposit can then be paid to the event organizer. A disputed deposit remains locked until the organizer resolves it with a full attendee refund. Cancelling an event makes every held deposit refundable and prevents no-show settlement. These terms are included in the on-chain policy hash and shown before reservation.

## Neon indexing and email notifications

The indexer and Resend notification routes use the linked Neon Postgres database:

1. Pull Neon credentials into `web/.env.local` with `neon env pull --file web/.env.local`, then set `INDEXER_CRON_SECRET` (at least 32 characters), `NOTIFICATION_TOKEN_SECRET` (at least 32 characters), `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `APP_BASE_URL` there. Never prefix service or signing secrets with `NEXT_PUBLIC_`.
2. Apply pending SQL migrations by running `npm run db:migrate` from `web/`; the migration runner uses the direct `DATABASE_URL_UNPOOLED` connection and records checksums.
3. Configure a scheduler to `POST /api/indexer/sync` and `POST /api/notifications/dispatch` with `Authorization: Bearer <INDEXER_CRON_SECRET>`. Run the indexer frequently enough to keep chain snapshots and 24-hour event reminders current; run the dispatcher frequently to deliver queued messages.
4. Retry delivery failures with `POST /api/notifications/retry` using the same authorization header. The dispatcher records failure and backoff state in `notification_outbox`; recipients can unsubscribe from any email.

Attendees may opt into email updates after a confirmed reservation. HELD verifies the reservation transaction and sends a separate email-verification link before enabling notifications. Chain accounts remain authoritative; a failed indexer or notification does not change transaction status or eligibility. Configure these services before advertising notifications as available.

Organizer event covers use Neon Object Storage's private `assets` bucket. Uploads accept JPEG, PNG, or WebP up to 5 MB and require a short-lived message signature from the on-chain event organizer. The server verifies the event against Solana before storing the image; the database stores only its key and checksum, and readers receive short-lived signed URLs. The corresponding table is created by the normal `db:migrate` command.

Organizer dashboards subscribe through Neon Realtime using a sealed, server-issued query limited to public event snapshot fields. Set `NEXT_PUBLIC_NEON_REALTIME_URL` to the Neon-generated `NEON_REALTIME_URL`; keep `NEON_REALTIME_SECRET` server-only. If the production branch uses an origin allowlist, add the deployed app's exact origin under the branch policy before deployment. Realtime changes trigger a refresh from Solana; Neon snapshots are not authoritative for funds or settlement.

## Validation

```powershell
Set-Location web
npm run lint
npx tsc --noEmit
npm run build

Set-Location ..
cargo test -p held --lib
```

The Anchor CLI and Solana CLI are required to build the SBF artifact, run validator/integration tests, and deploy. A plain Rust unit test does not replace program-runtime tests or an independent security review.
