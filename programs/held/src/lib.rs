use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("6eCgrBQEMM3oo4AgvvvXwiEkd7zFKVQF983HwpwCZLDU");

const EVENT_SEED: &[u8] = b"event";
const REGISTRATION_SEED: &[u8] = b"registration";
const VAULT_SEED: &[u8] = b"vault";
const MAX_NAME_LEN: usize = 96;
const MAX_DESCRIPTION_LEN: usize = 512;
const MAX_LOCATION_LEN: usize = 160;

#[program]
pub mod held {
    use super::*;

    pub fn initialize_event(
        ctx: Context<InitializeEvent>,
        event_seed: [u8; 32],
        name: String,
        description: String,
        location: String,
        time_zone: String,
        event_start_at: i64,
        deposit_amount: u64,
        capacity: u32,
        registration_open_at: i64,
        registration_close_at: i64,
        cancellation_deadline: i64,
        check_in_start_at: i64,
        check_in_end_at: i64,
        dispute_window_seconds: i64,
        policy_hash: [u8; 32],
    ) -> Result<()> {
        validate_metadata(&name, &description, &location)?;
        require!(
            !time_zone.trim().is_empty() && time_zone.len() <= 64,
            HeldError::InvalidMetadata
        );
        require!(deposit_amount > 0, HeldError::InvalidDeposit);
        require!(capacity > 0, HeldError::InvalidCapacity);
        require!(
            registration_open_at < registration_close_at
                && registration_close_at <= check_in_start_at
                && check_in_start_at <= event_start_at
                && event_start_at < check_in_end_at,
            HeldError::InvalidEventSchedule
        );
        require!(
            registration_open_at <= cancellation_deadline
                && cancellation_deadline <= check_in_start_at
                && dispute_window_seconds == 0,
            HeldError::InvalidEventSchedule
        );

        let event = &mut ctx.accounts.event;
        event.organizer = ctx.accounts.organizer.key();
        event.mint = ctx.accounts.mint.key();
        event.event_seed = event_seed;
        event.name = name;
        event.description = description;
        event.location = location;
        event.time_zone = time_zone;
        event.event_start_at = event_start_at;
        event.deposit_amount = deposit_amount;
        event.capacity = capacity;
        event.reserved_count = 0;
        event.held_amount = 0;
        event.registration_open_at = registration_open_at;
        event.registration_close_at = registration_close_at;
        event.cancellation_deadline = cancellation_deadline;
        event.check_in_start_at = check_in_start_at;
        event.check_in_end_at = check_in_end_at;
        event.dispute_window_seconds = dispute_window_seconds;
        event.policy_hash = policy_hash;
        event.status = EventStatus::Active;
        event.bump = ctx.bumps.event;
        emit!(EventCreated {
            event: event.key(),
            organizer: event.organizer,
            mint: event.mint,
        });
        Ok(())
    }

    pub fn update_event(
        ctx: Context<UpdateEvent>,
        name: String,
        description: String,
        location: String,
    ) -> Result<()> {
        validate_metadata(&name, &description, &location)?;
        require!(
            ctx.accounts.event.status == EventStatus::Active,
            HeldError::EventNotActive
        );
        require!(
            ctx.accounts.event.reserved_count == 0,
            HeldError::EventHasReservations
        );
        let event = &mut ctx.accounts.event;
        event.name = name;
        event.description = description;
        event.location = location;
        Ok(())
    }

    pub fn reserve_seat(ctx: Context<ReserveSeat>, credential_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ensure_reservation_open(
            now,
            ctx.accounts.event.registration_open_at,
            ctx.accounts.event.registration_close_at,
            ctx.accounts.event.capacity,
            ctx.accounts.event.reserved_count,
            ctx.accounts.event.status,
        )?;

        let amount = ctx.accounts.event.deposit_amount;
        let decimals = ctx.accounts.mint.decimals;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.attendee_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.attendee.to_account_info(),
                },
            ),
            amount,
            decimals,
        )?;

        let event = &mut ctx.accounts.event;
        event.reserved_count = event
            .reserved_count
            .checked_add(1)
            .ok_or(HeldError::ArithmeticOverflow)?;
        event.held_amount = event
            .held_amount
            .checked_add(amount)
            .ok_or(HeldError::ArithmeticOverflow)?;

        let registration = &mut ctx.accounts.registration;
        registration.event = event.key();
        registration.attendee = ctx.accounts.attendee.key();
        registration.deposit_amount = amount;
        registration.policy_hash = event.policy_hash;
        registration.credential_hash = credential_hash;
        registration.reservation_status = ReservationStatus::Confirmed;
        registration.attendance_status = AttendanceStatus::NotCheckedIn;
        registration.settlement_status = SettlementStatus::Held;
        registration.checked_in_by = Pubkey::default();
        registration.checked_in_at = 0;
        registration.no_show_marked_at = 0;
        registration.bump = ctx.bumps.registration;
        registration.vault_bump = ctx.bumps.vault;

        emit!(ReservationCreated {
            event: event.key(),
            registration: registration.key(),
            attendee: registration.attendee,
            amount,
            policy_hash: registration.policy_hash,
        });
        Ok(())
    }

    pub fn cancel_registration(ctx: Context<CancelRegistration>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ensure_can_cancel_registration(
            now,
            ctx.accounts.event.cancellation_deadline,
            ctx.accounts.event.status,
            ctx.accounts.registration.reservation_status,
            ctx.accounts.registration.attendance_status,
            ctx.accounts.registration.settlement_status,
        )?;

        transfer_from_vault(
            &ctx.accounts.event,
            &ctx.accounts.registration,
            &ctx.accounts.vault,
            &ctx.accounts.attendee_token,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
        )?;

        let event = &mut ctx.accounts.event;
        event.reserved_count = event
            .reserved_count
            .checked_sub(1)
            .ok_or(HeldError::ArithmeticOverflow)?;
        event.held_amount = event
            .held_amount
            .checked_sub(ctx.accounts.registration.deposit_amount)
            .ok_or(HeldError::ArithmeticOverflow)?;
        ctx.accounts.registration.reservation_status = ReservationStatus::Cancelled;
        ctx.accounts.registration.settlement_status = SettlementStatus::Refunded;

        emit!(RegistrationCancelled {
            event: event.key(),
            registration: ctx.accounts.registration.key(),
            attendee: ctx.accounts.attendee.key(),
        });
        emit_refund(&ctx.accounts.registration);
        Ok(())
    }

    pub fn check_in_attendee(
        ctx: Context<CheckInAttendee>,
        credential_hash: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let event = &ctx.accounts.event;
        let registration = &mut ctx.accounts.registration;
        ensure_can_check_in(
            now,
            event.check_in_start_at,
            event.check_in_end_at,
            event.status,
            registration.reservation_status,
            registration.attendance_status,
            registration.settlement_status,
        )?;
        require!(
            registration.credential_hash == credential_hash,
            HeldError::InvalidCredential
        );
        registration.attendance_status = AttendanceStatus::CheckedIn;
        registration.checked_in_by = ctx.accounts.organizer.key();
        registration.checked_in_at = now;
        emit!(AttendeeCheckedIn {
            event: event.key(),
            registration: registration.key(),
            attendee: registration.attendee,
            organizer: ctx.accounts.organizer.key(),
            timestamp: now,
        });
        Ok(())
    }

    pub fn refund_attendee(ctx: Context<RefundAttendee>) -> Result<()> {
        let registration = &ctx.accounts.registration;
        let refund_amount = registration.deposit_amount;
        ensure_can_refund(
            ctx.accounts.event.status,
            registration.reservation_status,
            registration.attendance_status,
            registration.settlement_status,
        )?;

        transfer_from_vault(
            &ctx.accounts.event,
            &ctx.accounts.registration,
            &ctx.accounts.vault,
            &ctx.accounts.beneficiary_token,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
        )?;

        ctx.accounts.registration.settlement_status = SettlementStatus::Refunded;
        ctx.accounts.event.held_amount = ctx
            .accounts
            .event
            .held_amount
            .checked_sub(refund_amount)
            .ok_or(HeldError::ArithmeticOverflow)?;
        emit_refund(&ctx.accounts.registration);
        Ok(())
    }

    pub fn cancel_event(ctx: Context<CancelEvent>) -> Result<()> {
        require!(
            ctx.accounts.event.status == EventStatus::Active,
            HeldError::EventNotActive
        );
        ctx.accounts.event.status = EventStatus::Cancelled;
        emit!(EventCancelled {
            event: ctx.accounts.event.key(),
            organizer: ctx.accounts.organizer.key(),
        });
        Ok(())
    }

    pub fn dispute_registration(_ctx: Context<DisputeRegistration>) -> Result<()> {
        err!(HeldError::DisputeNotSupported)
    }

    pub fn refund_no_show(ctx: Context<RefundNoShow>) -> Result<()> {
        ensure_can_refund_no_show(
            ctx.accounts.registration.reservation_status,
            ctx.accounts.registration.attendance_status,
            ctx.accounts.registration.settlement_status,
        )?;
        transfer_from_vault(
            &ctx.accounts.event,
            &ctx.accounts.registration,
            &ctx.accounts.vault,
            &ctx.accounts.beneficiary_token,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
        )?;
        ctx.accounts.registration.settlement_status = SettlementStatus::Refunded;
        ctx.accounts.event.held_amount = ctx
            .accounts
            .event
            .held_amount
            .checked_sub(ctx.accounts.registration.deposit_amount)
            .ok_or(HeldError::ArithmeticOverflow)?;
        emit_refund(&ctx.accounts.registration);
        Ok(())
    }

    pub fn finalize_no_show(ctx: Context<FinalizeNoShow>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ensure_can_finalize_no_show(
            now,
            ctx.accounts.event.check_in_end_at,
            ctx.accounts.event.status,
            ctx.accounts.registration.reservation_status,
            ctx.accounts.registration.attendance_status,
            ctx.accounts.registration.settlement_status,
        )?;
        ctx.accounts.registration.attendance_status = AttendanceStatus::NoShowPending;
        ctx.accounts.registration.no_show_marked_at = now;
        emit!(NoShowMarked {
            event: ctx.accounts.event.key(),
            registration: ctx.accounts.registration.key(),
            no_show_marked_at: now,
        });
        Ok(())
    }

    pub fn withdraw_eligible_funds(ctx: Context<WithdrawEligibleFunds>) -> Result<()> {
        ensure_can_withdraw_no_show(
            ctx.accounts.event.status,
            ctx.accounts.registration.reservation_status,
            ctx.accounts.registration.attendance_status,
            ctx.accounts.registration.settlement_status,
        )?;

        transfer_from_vault(
            &ctx.accounts.event,
            &ctx.accounts.registration,
            &ctx.accounts.vault,
            &ctx.accounts.organizer_token,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
        )?;
        ctx.accounts.registration.settlement_status = SettlementStatus::PaidToOrganizer;
        ctx.accounts.event.held_amount = ctx
            .accounts
            .event
            .held_amount
            .checked_sub(ctx.accounts.registration.deposit_amount)
            .ok_or(HeldError::ArithmeticOverflow)?;
        emit!(NoShowSettledToOrganizer {
            event: ctx.accounts.event.key(),
            registration: ctx.accounts.registration.key(),
            organizer: ctx.accounts.organizer.key(),
            amount: ctx.accounts.registration.deposit_amount,
        });
        Ok(())
    }
}

fn validate_metadata(name: &str, description: &str, location: &str) -> Result<()> {
    require!(!name.trim().is_empty(), HeldError::InvalidMetadata);
    require!(name.len() <= MAX_NAME_LEN, HeldError::InvalidMetadata);
    require!(
        description.len() <= MAX_DESCRIPTION_LEN,
        HeldError::InvalidMetadata
    );
    require!(
        location.len() <= MAX_LOCATION_LEN,
        HeldError::InvalidMetadata
    );
    Ok(())
}

fn ensure_reservation_open(
    now: i64,
    opens_at: i64,
    closes_at: i64,
    capacity: u32,
    reserved: u32,
    status: EventStatus,
) -> Result<()> {
    require!(status == EventStatus::Active, HeldError::EventNotActive);
    require!(
        now >= opens_at && now <= closes_at,
        HeldError::RegistrationClosed
    );
    require!(reserved < capacity, HeldError::EventFull);
    Ok(())
}

fn ensure_can_cancel_registration(
    now: i64,
    deadline: i64,
    event_status: EventStatus,
    reservation_status: ReservationStatus,
    attendance_status: AttendanceStatus,
    settlement_status: SettlementStatus,
) -> Result<()> {
    require!(
        event_status == EventStatus::Active,
        HeldError::EventNotActive
    );
    require!(now <= deadline, HeldError::CancellationDeadlinePassed);
    require!(
        reservation_status == ReservationStatus::Confirmed
            && attendance_status == AttendanceStatus::NotCheckedIn
            && settlement_status == SettlementStatus::Held,
        HeldError::InvalidTransition
    );
    Ok(())
}

fn ensure_can_check_in(
    now: i64,
    opens_at: i64,
    closes_at: i64,
    event_status: EventStatus,
    reservation_status: ReservationStatus,
    attendance_status: AttendanceStatus,
    settlement_status: SettlementStatus,
) -> Result<()> {
    require!(
        event_status == EventStatus::Active,
        HeldError::EventNotActive
    );
    require!(
        now >= opens_at && now <= closes_at,
        HeldError::OutsideCheckInWindow
    );
    require!(
        reservation_status == ReservationStatus::Confirmed
            && attendance_status == AttendanceStatus::NotCheckedIn
            && settlement_status == SettlementStatus::Held,
        HeldError::InvalidTransition
    );
    Ok(())
}

fn ensure_can_refund(
    event_status: EventStatus,
    reservation_status: ReservationStatus,
    attendance_status: AttendanceStatus,
    settlement_status: SettlementStatus,
) -> Result<()> {
    let may_refund = event_status == EventStatus::Cancelled
        || reservation_status == ReservationStatus::Cancelled
        || attendance_status == AttendanceStatus::CheckedIn;
    require!(may_refund, HeldError::RefundNotEligible);
    require!(
        settlement_status == SettlementStatus::Held,
        HeldError::InvalidTransition
    );
    Ok(())
}

fn ensure_can_refund_no_show(
    reservation_status: ReservationStatus,
    attendance_status: AttendanceStatus,
    settlement_status: SettlementStatus,
) -> Result<()> {
    require!(
        reservation_status == ReservationStatus::Confirmed
            && matches!(
                attendance_status,
                AttendanceStatus::NoShowPending | AttendanceStatus::Disputed
            )
            && settlement_status == SettlementStatus::Held,
        HeldError::InvalidTransition
    );
    Ok(())
}

fn ensure_can_withdraw_no_show(
    event_status: EventStatus,
    reservation_status: ReservationStatus,
    attendance_status: AttendanceStatus,
    settlement_status: SettlementStatus,
) -> Result<()> {
    require!(
        event_status == EventStatus::Active,
        HeldError::EventNotActive
    );
    require!(
        reservation_status == ReservationStatus::Confirmed
            && attendance_status == AttendanceStatus::NoShowPending
            && settlement_status == SettlementStatus::Held,
        HeldError::InvalidTransition
    );
    Ok(())
}

fn ensure_can_finalize_no_show(
    now: i64,
    check_in_end_at: i64,
    event_status: EventStatus,
    reservation_status: ReservationStatus,
    attendance_status: AttendanceStatus,
    settlement_status: SettlementStatus,
) -> Result<()> {
    require!(
        event_status == EventStatus::Active,
        HeldError::EventNotActive
    );
    require!(now > check_in_end_at, HeldError::OutsideCheckInWindow);
    require!(
        reservation_status == ReservationStatus::Confirmed
            && attendance_status == AttendanceStatus::NotCheckedIn
            && settlement_status == SettlementStatus::Held,
        HeldError::InvalidTransition
    );
    Ok(())
}

fn transfer_from_vault<'info>(
    event: &Account<'info, Event>,
    registration: &Account<'info, Registration>,
    vault: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    let event_key = event.key();
    let bump = [registration.bump];
    let signer_seeds: &[&[u8]] = &[
        REGISTRATION_SEED,
        event_key.as_ref(),
        registration.attendee.as_ref(),
        &bump,
    ];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: registration.to_account_info(),
            },
            &[signer_seeds],
        ),
        registration.deposit_amount,
        mint.decimals,
    )
}

fn emit_refund(registration: &Account<Registration>) {
    emit!(RefundIssued {
        event: registration.event,
        registration: registration.key(),
        attendee: registration.attendee,
        amount: registration.deposit_amount,
    });
}

#[derive(Accounts)]
#[instruction(event_seed: [u8; 32])]
pub struct InitializeEvent<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,
    #[account(
        init,
        payer = organizer,
        space = 8 + Event::INIT_SPACE,
        seeds = [EVENT_SEED, organizer.key().as_ref(), event_seed.as_ref()],
        bump
    )]
    pub event: Account<'info, Event>,
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateEvent<'info> {
    pub organizer: Signer<'info>,
    #[account(
        mut,
        has_one = organizer @ HeldError::Unauthorized,
        seeds = [EVENT_SEED, organizer.key().as_ref(), event.event_seed.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
}

#[derive(Accounts)]
pub struct ReserveSeat<'info> {
    #[account(mut)]
    pub attendee: Signer<'info>,
    #[account(
        mut,
        seeds = [EVENT_SEED, event.organizer.as_ref(), event.event_seed.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
    #[account(
        init,
        payer = attendee,
        space = 8 + Registration::INIT_SPACE,
        seeds = [REGISTRATION_SEED, event.key().as_ref(), attendee.key().as_ref()],
        bump
    )]
    pub registration: Account<'info, Registration>,
    #[account(
        init,
        payer = attendee,
        seeds = [VAULT_SEED, registration.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = registration
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        address = event.mint,
        constraint = *mint.to_account_info().owner == token_program.key()
            @ HeldError::InvalidTokenProgram
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = attendee
    )]
    pub attendee_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CancelRegistration<'info> {
    pub attendee: Signer<'info>,
    #[account(
        mut,
        seeds = [EVENT_SEED, event.organizer.as_ref(), event.event_seed.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        has_one = event,
        constraint = registration.attendee == attendee.key() @ HeldError::Unauthorized,
        seeds = [REGISTRATION_SEED, event.key().as_ref(), attendee.key().as_ref()],
        bump = registration.bump
    )]
    pub registration: Account<'info, Registration>,
    #[account(
        mut,
        seeds = [VAULT_SEED, registration.key().as_ref()],
        bump = registration.vault_bump,
        token::mint = mint,
        token::authority = registration
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = event.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = attendee
    )]
    pub attendee_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CheckInAttendee<'info> {
    pub organizer: Signer<'info>,
    #[account(
        seeds = [EVENT_SEED, organizer.key().as_ref(), event.event_seed.as_ref()],
        bump = event.bump,
        has_one = organizer @ HeldError::Unauthorized
    )]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        has_one = event,
        seeds = [REGISTRATION_SEED, event.key().as_ref(), registration.attendee.as_ref()],
        bump = registration.bump
    )]
    pub registration: Account<'info, Registration>,
}

#[derive(Accounts)]
pub struct RefundAttendee<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [EVENT_SEED, event.organizer.as_ref(), event.event_seed.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        has_one = event,
        constraint = registration.attendee == beneficiary.key() @ HeldError::InvalidBeneficiary,
        seeds = [REGISTRATION_SEED, event.key().as_ref(), beneficiary.key().as_ref()],
        bump = registration.bump
    )]
    pub registration: Account<'info, Registration>,
    pub beneficiary: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, registration.key().as_ref()],
        bump = registration.vault_bump,
        token::mint = mint,
        token::authority = registration
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = event.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = beneficiary
    )]
    pub beneficiary_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelEvent<'info> {
    pub organizer: Signer<'info>,
    #[account(
        mut,
        has_one = organizer @ HeldError::Unauthorized,
        seeds = [EVENT_SEED, organizer.key().as_ref(), event.event_seed.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
}

#[derive(Accounts)]
pub struct DisputeRegistration<'info> {
    pub attendee: Signer<'info>,
    #[account(
        seeds = [EVENT_SEED, event.organizer.as_ref(), event.event_seed.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        has_one = event,
        constraint = registration.attendee == attendee.key() @ HeldError::Unauthorized,
        seeds = [REGISTRATION_SEED, event.key().as_ref(), attendee.key().as_ref()],
        bump = registration.bump
    )]
    pub registration: Account<'info, Registration>,
}

#[derive(Accounts)]
pub struct RefundNoShow<'info> {
    pub organizer: Signer<'info>,
    #[account(
        mut,
        has_one = organizer @ HeldError::Unauthorized,
        seeds = [EVENT_SEED, organizer.key().as_ref(), event.event_seed.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        has_one = event,
        constraint = registration.attendee == beneficiary.key() @ HeldError::InvalidBeneficiary,
        seeds = [REGISTRATION_SEED, event.key().as_ref(), beneficiary.key().as_ref()],
        bump = registration.bump
    )]
    pub registration: Account<'info, Registration>,
    pub beneficiary: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, registration.key().as_ref()],
        bump = registration.vault_bump,
        token::mint = mint,
        token::authority = registration
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = event.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = beneficiary
    )]
    pub beneficiary_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FinalizeNoShow<'info> {
    pub organizer: Signer<'info>,
    #[account(
        has_one = organizer @ HeldError::Unauthorized,
        seeds = [EVENT_SEED, organizer.key().as_ref(), event.event_seed.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        has_one = event,
        seeds = [REGISTRATION_SEED, event.key().as_ref(), registration.attendee.as_ref()],
        bump = registration.bump
    )]
    pub registration: Account<'info, Registration>,
}

#[derive(Accounts)]
pub struct WithdrawEligibleFunds<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,
    #[account(
        mut,
        has_one = organizer @ HeldError::Unauthorized,
        seeds = [EVENT_SEED, organizer.key().as_ref(), event.event_seed.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        has_one = event,
        seeds = [REGISTRATION_SEED, event.key().as_ref(), registration.attendee.as_ref()],
        bump = registration.bump
    )]
    pub registration: Account<'info, Registration>,
    #[account(
        mut,
        seeds = [VAULT_SEED, registration.key().as_ref()],
        bump = registration.vault_bump,
        token::mint = mint,
        token::authority = registration
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = event.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = organizer
    )]
    pub organizer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Event {
    pub organizer: Pubkey,
    pub mint: Pubkey,
    pub event_seed: [u8; 32],
    #[max_len(96)]
    pub name: String,
    #[max_len(512)]
    pub description: String,
    #[max_len(160)]
    pub location: String,
    #[max_len(64)]
    pub time_zone: String,
    pub event_start_at: i64,
    pub deposit_amount: u64,
    pub capacity: u32,
    pub reserved_count: u32,
    pub held_amount: u64,
    pub registration_open_at: i64,
    pub registration_close_at: i64,
    pub cancellation_deadline: i64,
    pub check_in_start_at: i64,
    pub check_in_end_at: i64,
    pub dispute_window_seconds: i64,
    pub policy_hash: [u8; 32],
    pub status: EventStatus,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Registration {
    pub event: Pubkey,
    pub attendee: Pubkey,
    pub deposit_amount: u64,
    pub policy_hash: [u8; 32],
    pub credential_hash: [u8; 32],
    pub reservation_status: ReservationStatus,
    pub attendance_status: AttendanceStatus,
    pub settlement_status: SettlementStatus,
    pub checked_in_by: Pubkey,
    pub checked_in_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
    pub no_show_marked_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EventStatus {
    Active,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ReservationStatus {
    Confirmed,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum AttendanceStatus {
    NotCheckedIn,
    CheckedIn,
    NoShowPending,
    Disputed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SettlementStatus {
    Held,
    Refunded,
    PaidToOrganizer,
}

#[event]
pub struct EventCreated {
    pub event: Pubkey,
    pub organizer: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct ReservationCreated {
    pub event: Pubkey,
    pub registration: Pubkey,
    pub attendee: Pubkey,
    pub amount: u64,
    pub policy_hash: [u8; 32],
}

#[event]
pub struct RegistrationCancelled {
    pub event: Pubkey,
    pub registration: Pubkey,
    pub attendee: Pubkey,
}

#[event]
pub struct AttendeeCheckedIn {
    pub event: Pubkey,
    pub registration: Pubkey,
    pub attendee: Pubkey,
    pub organizer: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct RefundIssued {
    pub event: Pubkey,
    pub registration: Pubkey,
    pub attendee: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EventCancelled {
    pub event: Pubkey,
    pub organizer: Pubkey,
}

#[event]
pub struct NoShowMarked {
    pub event: Pubkey,
    pub registration: Pubkey,
    pub no_show_marked_at: i64,
}

#[event]
pub struct NoShowSettledToOrganizer {
    pub event: Pubkey,
    pub registration: Pubkey,
    pub organizer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DisputeRaised {
    pub event: Pubkey,
    pub registration: Pubkey,
    pub attendee: Pubkey,
    pub timestamp: i64,
}

#[error_code]
pub enum HeldError {
    #[msg("Event text is empty or longer than the supported limit")]
    InvalidMetadata,
    #[msg("Deposit must be greater than zero")]
    InvalidDeposit,
    #[msg("Capacity must be greater than zero")]
    InvalidCapacity,
    #[msg("Event deadlines are inconsistent")]
    InvalidEventSchedule,
    #[msg("Arithmetic overflow or inconsistent escrow accounting")]
    ArithmeticOverflow,
    #[msg("Event is not active")]
    EventNotActive,
    #[msg("Event details cannot be changed after registrations have been made")]
    EventHasReservations,
    #[msg("Registration is not open")]
    RegistrationClosed,
    #[msg("Event has reached capacity")]
    EventFull,
    #[msg("Unauthorized signer")]
    Unauthorized,
    #[msg("Cancellation deadline has passed")]
    CancellationDeadlinePassed,
    #[msg("Registration state does not allow this action")]
    InvalidTransition,
    #[msg("Outside the event check-in window")]
    OutsideCheckInWindow,
    #[msg("QR credential is not valid for this registration")]
    InvalidCredential,
    #[msg("Refund is not eligible")]
    RefundNotEligible,
    #[msg("The destination account is not owned by the attendee")]
    InvalidBeneficiary,
    #[msg("The mint is not owned by the configured SPL Token program")]
    InvalidTokenProgram,
    #[msg("Attendee disputes are not supported; contact the event organizer")]
    DisputeNotSupported,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservation_window_and_capacity_boundaries_are_enforced() {
        assert!(ensure_reservation_open(10, 10, 20, 2, 1, EventStatus::Active).is_ok());
        assert!(ensure_reservation_open(9, 10, 20, 2, 1, EventStatus::Active).is_err());
        assert!(ensure_reservation_open(21, 10, 20, 2, 1, EventStatus::Active).is_err());
        assert!(ensure_reservation_open(10, 10, 20, 2, 2, EventStatus::Active).is_err());
        assert!(ensure_reservation_open(10, 10, 20, 2, 0, EventStatus::Cancelled).is_err());
        assert!(ensure_reservation_open(20, 10, 20, 2, 1, EventStatus::Active).is_ok());
    }

    #[test]
    fn attendee_cancellation_is_full_refund_only_before_deadline() {
        assert!(ensure_can_cancel_registration(
            100,
            100,
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::NotCheckedIn,
            SettlementStatus::Held,
        )
        .is_ok());
        assert!(ensure_can_cancel_registration(
            101,
            100,
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::NotCheckedIn,
            SettlementStatus::Held,
        )
        .is_err());
        assert!(ensure_can_cancel_registration(
            99,
            100,
            EventStatus::Cancelled,
            ReservationStatus::Confirmed,
            AttendanceStatus::NotCheckedIn,
            SettlementStatus::Held,
        )
        .is_err());
        assert!(ensure_can_cancel_registration(
            99,
            100,
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::CheckedIn,
            SettlementStatus::Held,
        )
        .is_err());
    }

    #[test]
    fn check_in_requires_active_event_open_window_and_held_registration() {
        assert!(ensure_can_check_in(
            10,
            10,
            20,
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::NotCheckedIn,
            SettlementStatus::Held,
        )
        .is_ok());
        assert!(ensure_can_check_in(
            21,
            10,
            20,
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::NotCheckedIn,
            SettlementStatus::Held,
        )
        .is_err());
        assert!(ensure_can_check_in(
            15,
            10,
            20,
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::CheckedIn,
            SettlementStatus::Held,
        )
        .is_err());
    }

    #[test]
    fn refunds_require_an_eligible_transition_and_held_settlement() {
        assert!(ensure_can_refund(
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::CheckedIn,
            SettlementStatus::Held,
        )
        .is_ok());
        assert!(ensure_can_refund(
            EventStatus::Cancelled,
            ReservationStatus::Confirmed,
            AttendanceStatus::NoShowPending,
            SettlementStatus::Held,
        )
        .is_ok());
        assert!(ensure_can_refund(
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::NotCheckedIn,
            SettlementStatus::Held,
        )
        .is_err());
        assert!(ensure_can_refund(
            EventStatus::Cancelled,
            ReservationStatus::Confirmed,
            AttendanceStatus::NotCheckedIn,
            SettlementStatus::Refunded,
        )
        .is_err());
    }

    #[test]
    fn no_show_requires_closed_check_in_and_attendee_refund_is_not_available() {
        assert!(ensure_can_refund(
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::NoShowPending,
            SettlementStatus::Held,
        )
        .is_err());
        assert!(ensure_can_finalize_no_show(
            21,
            20,
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::NotCheckedIn,
            SettlementStatus::Held,
        )
        .is_ok());
        assert!(ensure_can_finalize_no_show(
            20,
            20,
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::NotCheckedIn,
            SettlementStatus::Held,
        )
        .is_err());
        assert!(ensure_can_finalize_no_show(
            21,
            20,
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::CheckedIn,
            SettlementStatus::Held,
        )
        .is_err());
    }

    #[test]
    fn organizer_may_refund_a_no_show_or_pay_it_out_immediately() {
        assert!(ensure_can_refund_no_show(
            ReservationStatus::Confirmed,
            AttendanceStatus::NoShowPending,
            SettlementStatus::Held,
        )
        .is_ok());
        assert!(ensure_can_refund_no_show(
            ReservationStatus::Confirmed,
            AttendanceStatus::Disputed,
            SettlementStatus::Held,
        )
        .is_ok());
        assert!(ensure_can_refund_no_show(
            ReservationStatus::Cancelled,
            AttendanceStatus::NoShowPending,
            SettlementStatus::Held,
        )
        .is_err());
        assert!(ensure_can_refund_no_show(
            ReservationStatus::Confirmed,
            AttendanceStatus::NoShowPending,
            SettlementStatus::PaidToOrganizer,
        )
        .is_err());

        assert!(ensure_can_withdraw_no_show(
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::NoShowPending,
            SettlementStatus::Held,
        )
        .is_ok());
        assert!(ensure_can_withdraw_no_show(
            EventStatus::Cancelled,
            ReservationStatus::Confirmed,
            AttendanceStatus::NoShowPending,
            SettlementStatus::Held,
        )
        .is_err());
        assert!(ensure_can_withdraw_no_show(
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::Disputed,
            SettlementStatus::Held,
        )
        .is_err());
        assert!(ensure_can_withdraw_no_show(
            EventStatus::Active,
            ReservationStatus::Confirmed,
            AttendanceStatus::NoShowPending,
            SettlementStatus::PaidToOrganizer,
        )
        .is_err());
    }
}
