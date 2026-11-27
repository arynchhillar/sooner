//! Sooner: early payment on approved invoices, priced by the second.
//!
//! A buyer opens a pool, funds its vault and approves invoices ("payables").
//! The supplier named on a payable can collect it from the vault at any moment.
//! Collected before the due date, the payout is reduced by a discount that
//! shrinks in a straight line to zero at the due date. The buyer keeps that
//! discount, minus a small protocol fee. Every payment updates the buyer's
//! public payment record.
//!
//! The party that owes the money is the one that approves and funds it, so the
//! program needs no outside lenders, no invoice oracle and no credit risk model.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("3k7jN3ufVfnp4w6UQDZkNmVimPKEU1pTcTXsxx3ABDHJ");

/// Discounts accrue on an actual/365 basis.
pub const SECONDS_PER_YEAR: u64 = 365 * 24 * 60 * 60;
pub const BPS_DENOMINATOR: u64 = 10_000;
/// A pool can offer at most 50% a year.
pub const MAX_RATE_BPS: u16 = 5_000;
/// The protocol keeps at most 20% of any discount.
pub const MAX_FEE_BPS: u16 = 2_000;
/// Invoices can be due at most 366 days after approval.
pub const MAX_TENOR_SECONDS: i64 = 366 * 24 * 60 * 60;
/// Devnet only: each faucet call mints 10,000 test dollars (6 decimals).
pub const DEMO_FAUCET_AMOUNT: u64 = 10_000 * 1_000_000;
pub const DEMO_MINT_DECIMALS: u8 = 6;

/// Discount for paying `amount` when `seconds_early` seconds remain before the
/// due date. Simple interest, rounded down, so rounding favours the supplier.
pub fn discount_for(amount: u64, rate_bps: u16, seconds_early: u64) -> Option<u64> {
    let numerator = (amount as u128)
        .checked_mul(rate_bps as u128)?
        .checked_mul(seconds_early as u128)?;
    let denominator = (BPS_DENOMINATOR as u128).checked_mul(SECONDS_PER_YEAR as u128)?;
    let discount = u64::try_from(numerator / denominator).ok()?;
    Some(discount.min(amount))
}

/// The protocol's share of a discount.
pub fn fee_for(discount: u64, fee_bps: u16) -> Option<u64> {
    let fee = (discount as u128).checked_mul(fee_bps as u128)? / (BPS_DENOMINATOR as u128);
    u64::try_from(fee).ok()
}

#[program]
pub mod sooner {
    use super::*;

    /// One-time setup: stores the protocol fee and creates the devnet test mint.
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, SoonerError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = ctx.accounts.admin.key();
        config.fee_bps = fee_bps;
        config.demo_mint = ctx.accounts.demo_mint.key();
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin: change the protocol fee or the wallet that receives it.
    pub fn set_config(ctx: Context<SetConfig>, fee_bps: u16, treasury: Pubkey) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, SoonerError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.fee_bps = fee_bps;
        config.treasury = treasury;
        Ok(())
    }

    /// Devnet only: mints test dollars so anyone can try the app.
    pub fn demo_faucet(ctx: Context<DemoFaucet>) -> Result<()> {
        let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.demo_mint.to_account_info(),
                    to: ctx.accounts.recipient_token.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            DEMO_FAUCET_AMOUNT,
        )
    }

    /// A buyer opens an early-payment pool for one token and sets its yearly rate.
    pub fn open_pool(ctx: Context<OpenPool>, rate_bps: u16) -> Result<()> {
        require!(rate_bps <= MAX_RATE_BPS, SoonerError::RateTooHigh);
        let pool = &mut ctx.accounts.pool;
        pool.buyer = ctx.accounts.buyer.key();
        pool.mint = ctx.accounts.mint.key();
        pool.vault = ctx.accounts.vault.key();
        pool.rate_bps = rate_bps;
        pool.bump = ctx.bumps.pool;
        pool.created_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Changes the rate for invoices approved from now on. Invoices already
    /// approved keep the rate they were approved at.
    pub fn set_rate(ctx: Context<SetRate>, rate_bps: u16) -> Result<()> {
        require!(rate_bps <= MAX_RATE_BPS, SoonerError::RateTooHigh);
        ctx.accounts.pool.rate_bps = rate_bps;
        Ok(())
    }

    /// Adds cash to the pool's vault.
    pub fn fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
        require!(amount > 0, SoonerError::ZeroAmount);
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.funder_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    /// The buyer takes idle cash back out of the vault.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, SoonerError::ZeroAmount);
        require!(ctx.accounts.vault.amount >= amount, SoonerError::PoolShort);
        pay_from_vault(
            &ctx.accounts.pool,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.destination,
            &ctx.accounts.token_program,
            amount,
        )
    }

    /// The buyer approves an invoice: a public commitment to pay `amount` to
    /// `supplier` by `due_at`. The pool's current rate is locked in.
    pub fn approve_payable(
        ctx: Context<ApprovePayable>,
        invoice_id: [u8; 32],
        amount: u64,
        due_at: i64,
        reference: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(amount > 0, SoonerError::ZeroAmount);
        require!(due_at > now, SoonerError::DueDateInPast);
        require!(due_at - now <= MAX_TENOR_SECONDS, SoonerError::TenorTooLong);
        require_keys_neq!(
            ctx.accounts.supplier.key(),
            ctx.accounts.buyer.key(),
            SoonerError::SelfDealing
        );

        let pool = &mut ctx.accounts.pool;
        let payable = &mut ctx.accounts.payable;
        payable.pool = pool.key();
        payable.supplier = ctx.accounts.supplier.key();
        payable.amount = amount;
        payable.rate_bps = pool.rate_bps;
        payable.approved_at = now;
        payable.due_at = due_at;
        payable.status = Status::Open;
        payable.paid_at = 0;
        payable.paid_amount = 0;
        payable.discount = 0;
        payable.invoice_id = invoice_id;
        payable.reference = reference;
        payable.bump = ctx.bumps.payable;

        pool.outstanding = pool
            .outstanding
            .checked_add(amount)
            .ok_or(SoonerError::MathOverflow)?;
        pool.total_approved = pool
            .total_approved
            .checked_add(amount)
            .ok_or(SoonerError::MathOverflow)?;
        pool.count_approved = pool
            .count_approved
            .checked_add(1)
            .ok_or(SoonerError::MathOverflow)?;

        emit!(PayableApproved {
            pool: pool.key(),
            payable: payable.key(),
            buyer: pool.buyer,
            supplier: payable.supplier,
            amount,
            due_at,
            rate_bps: payable.rate_bps,
        });
        Ok(())
    }

    /// The supplier collects from the vault. Before the due date the payout is
    /// the amount minus the time-based discount; from the due date on it is the
    /// full amount.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.payable.status == Status::Open,
            SoonerError::NotOpen
        );

        let amount = ctx.accounts.payable.amount;
        let due_at = ctx.accounts.payable.due_at;
        let seconds_early = if due_at > now { (due_at - now) as u64 } else { 0 };
        let discount = discount_for(amount, ctx.accounts.payable.rate_bps, seconds_early)
            .ok_or(SoonerError::MathOverflow)?;
        let fee = fee_for(discount, ctx.accounts.config.fee_bps).ok_or(SoonerError::MathOverflow)?;
        let payout = amount.checked_sub(discount).ok_or(SoonerError::MathOverflow)?;
        let needed = payout.checked_add(fee).ok_or(SoonerError::MathOverflow)?;
        require!(ctx.accounts.vault.amount >= needed, SoonerError::PoolShort);

        pay_from_vault(
            &ctx.accounts.pool,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.supplier_token,
            &ctx.accounts.token_program,
            payout,
        )?;
        pay_from_vault(
            &ctx.accounts.pool,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.treasury_token,
            &ctx.accounts.token_program,
            fee,
        )?;

        let status = if now < due_at {
            Status::PaidEarly
        } else if now == due_at {
            Status::PaidOnTime
        } else {
            Status::PaidLate
        };
        record_payment(
            &mut ctx.accounts.pool,
            &mut ctx.accounts.payable,
            status,
            now,
            payout,
            discount,
            fee,
        )
    }

    /// The buyer pays an open invoice in full from the vault, at any time.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.payable.status == Status::Open,
            SoonerError::NotOpen
        );
        let amount = ctx.accounts.payable.amount;
        require!(ctx.accounts.vault.amount >= amount, SoonerError::PoolShort);

        pay_from_vault(
            &ctx.accounts.pool,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.supplier_token,
            &ctx.accounts.token_program,
            amount,
        )?;

        let status = if now <= ctx.accounts.payable.due_at {
            Status::PaidOnTime
        } else {
            Status::PaidLate
        };
        record_payment(
            &mut ctx.accounts.pool,
            &mut ctx.accounts.payable,
            status,
            now,
            amount,
            0,
            0,
        )
    }

    /// The supplier releases the buyer from an open invoice (for example after
    /// a credit note). Only the party owed the money can do this.
    pub fn void_payable(ctx: Context<VoidPayable>) -> Result<()> {
        let payable = &mut ctx.accounts.payable;
        require!(payable.status == Status::Open, SoonerError::NotOpen);
        payable.status = Status::Voided;
        payable.paid_at = Clock::get()?.unix_timestamp;

        let pool = &mut ctx.accounts.pool;
        pool.outstanding = pool.outstanding.saturating_sub(payable.amount);
        pool.count_voided = pool
            .count_voided
            .checked_add(1)
            .ok_or(SoonerError::MathOverflow)?;

        emit!(PayableVoided {
            pool: pool.key(),
            payable: payable.key(),
        });
        Ok(())
    }
}

/// Moves tokens out of a pool's vault, signed by the pool's own address.
fn pay_from_vault<'info>(
    pool: &Account<'info, Pool>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[
        b"pool",
        pool.buyer.as_ref(),
        pool.mint.as_ref(),
        &[pool.bump],
    ];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// Closes a payable and updates the buyer's running payment record.
fn record_payment(
    pool: &mut Account<Pool>,
    payable: &mut Account<Payable>,
    status: Status,
    now: i64,
    paid_amount: u64,
    discount: u64,
    fee: u64,
) -> Result<()> {
    let due_at = payable.due_at;
    payable.status = status;
    payable.paid_at = now;
    payable.paid_amount = paid_amount;
    payable.discount = discount;

    pool.outstanding = pool.outstanding.saturating_sub(payable.amount);
    pool.total_paid = pool
        .total_paid
        .checked_add(paid_amount)
        .ok_or(SoonerError::MathOverflow)?;
    pool.total_discount = pool
        .total_discount
        .checked_add(discount)
        .ok_or(SoonerError::MathOverflow)?;
    pool.total_fees = pool
        .total_fees
        .checked_add(fee)
        .ok_or(SoonerError::MathOverflow)?;
    if now < due_at {
        pool.seconds_early = pool.seconds_early.saturating_add((due_at - now) as u64);
    } else {
        pool.seconds_late = pool.seconds_late.saturating_add((now - due_at) as u64);
    }
    match status {
        Status::PaidEarly => pool.count_early = pool.count_early.saturating_add(1),
        Status::PaidOnTime => pool.count_on_time = pool.count_on_time.saturating_add(1),
        Status::PaidLate => pool.count_late = pool.count_late.saturating_add(1),
        _ => {}
    }

    emit!(PayablePaid {
        pool: pool.key(),
        payable: payable.key(),
        supplier: payable.supplier,
        paid_amount,
        discount,
        fee,
        status,
        paid_at: now,
    });
    Ok(())
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = admin,
        seeds = [b"demo_mint"],
        bump,
        mint::decimals = DEMO_MINT_DECIMALS,
        mint::authority = config,
        mint::token_program = token_program
    )]
    pub demo_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct DemoFaucet<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = demo_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub demo_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = demo_mint, token::token_program = token_program)]
    pub recipient_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct OpenPool<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", buyer.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init,
        payer = buyer,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRate<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer)]
    pub pool: Box<Account<'info, Pool>>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    pub funder: Signer<'info>,
    #[account(has_one = mint, has_one = vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = funder,
        token::token_program = token_program
    )]
    pub funder_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub buyer: Signer<'info>,
    #[account(has_one = buyer, has_one = mint, has_one = vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(invoice_id: [u8; 32])]
pub struct ApprovePayable<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: any wallet can be named as the supplier; it only ever receives.
    pub supplier: UncheckedAccount<'info>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Payable::INIT_SPACE,
        seeds = [b"payable", pool.key().as_ref(), invoice_id.as_ref()],
        bump
    )]
    pub payable: Box<Account<'info, Payable>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub supplier: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, has_one = mint, has_one = vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool, has_one = supplier)]
    pub payable: Box<Account<'info, Payable>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = supplier,
        token::token_program = token_program
    )]
    pub supplier_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = config.treasury,
        token::token_program = token_program
    )]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer, has_one = mint, has_one = vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool)]
    pub payable: Box<Account<'info, Payable>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = payable.supplier,
        token::token_program = token_program
    )]
    pub supplier_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct VoidPayable<'info> {
    pub supplier: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool, has_one = supplier)]
    pub payable: Box<Account<'info, Payable>>,
}

// ------------------------------------------------------------------- state

/// Protocol settings. One per deployment.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Wallet whose token accounts receive the protocol fee.
    pub treasury: Pubkey,
    /// Share of each discount kept by the protocol, in basis points.
    pub fee_bps: u16,
    /// Devnet test dollar mint.
    pub demo_mint: Pubkey,
    pub bump: u8,
}

/// A buyer's early-payment pool for one token, and its public payment record.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    /// Yearly discount rate applied to new approvals, in basis points.
    pub rate_bps: u16,
    pub bump: u8,
    pub created_at: i64,
    /// Approved and not yet paid.
    pub outstanding: u64,
    pub total_approved: u64,
    /// Cash actually paid to suppliers.
    pub total_paid: u64,
    /// Discounts earned on early payments, before the protocol fee.
    pub total_discount: u64,
    pub total_fees: u64,
    pub count_approved: u32,
    pub count_early: u32,
    pub count_on_time: u32,
    pub count_late: u32,
    pub count_voided: u32,
    /// Sum of seconds paid before the due date, across all payments.
    pub seconds_early: u64,
    /// Sum of seconds paid after the due date, across all payments.
    pub seconds_late: u64,
}

/// One approved invoice.
#[account]
#[derive(InitSpace)]
pub struct Payable {
    pub pool: Pubkey,
    pub supplier: Pubkey,
    pub amount: u64,
    /// The pool's rate at approval. Later rate changes do not touch it.
    pub rate_bps: u16,
    pub approved_at: i64,
    pub due_at: i64,
    pub status: Status,
    pub paid_at: i64,
    pub paid_amount: u64,
    pub discount: u64,
    /// SHA-256 of the invoice file or number. Also part of the address.
    pub invoice_id: [u8; 32],
    /// Short human-readable label, UTF-8, zero padded.
    pub reference: [u8; 32],
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Status {
    Open,
    /// Collected by the supplier before the due date, at a discount.
    PaidEarly,
    /// Paid in full on or before the due date.
    PaidOnTime,
    /// Paid in full after the due date.
    PaidLate,
    /// Released by the supplier.
    Voided,
}

// ------------------------------------------------------------------ events

#[event]
pub struct PayableApproved {
    pub pool: Pubkey,
    pub payable: Pubkey,
    pub buyer: Pubkey,
    pub supplier: Pubkey,
    pub amount: u64,
    pub due_at: i64,
    pub rate_bps: u16,
}

#[event]
pub struct PayablePaid {
    pub pool: Pubkey,
    pub payable: Pubkey,
    pub supplier: Pubkey,
    pub paid_amount: u64,
    pub discount: u64,
    pub fee: u64,
    pub status: Status,
    pub paid_at: i64,
}

#[event]
pub struct PayableVoided {
    pub pool: Pubkey,
    pub payable: Pubkey,
}

// ------------------------------------------------------------------ errors

#[error_code]
pub enum SoonerError {
    #[msg("Rate is above the maximum of 50% a year")]
    RateTooHigh,
    #[msg("Protocol fee is above the maximum of 20% of the discount")]
    FeeTooHigh,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Due date must be in the future")]
    DueDateInPast,
    #[msg("Due date is more than 366 days away")]
    TenorTooLong,
    #[msg("Buyer and supplier must be different wallets")]
    SelfDealing,
    #[msg("This invoice is no longer open")]
    NotOpen,
    #[msg("The pool vault does not hold enough to pay this")]
    PoolShort,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u64 = 1_000_000;

    #[test]
    fn forty_five_days_at_twelve_percent() {
        // 1,000 x 12% x 45/365 = 14.794520...
        let d = discount_for(1_000 * USDC, 1_200, 45 * 86_400).unwrap();
        assert_eq!(d, 14_794_520);
        assert_eq!(1_000 * USDC - d, 985_205_480);
    }

    #[test]
    fn discount_is_zero_at_the_due_date() {
        assert_eq!(discount_for(1_000 * USDC, 1_200, 0).unwrap(), 0);
    }

    #[test]
    fn discount_shrinks_every_second() {
        let a = discount_for(250_000 * USDC, 1_800, 30 * 86_400).unwrap();
        let b = discount_for(250_000 * USDC, 1_800, 30 * 86_400 - 1).unwrap();
        assert!(b < a);
    }

    #[test]
    fn a_full_year_at_the_maximum_rate_is_half() {
        let d = discount_for(1_000 * USDC, MAX_RATE_BPS, SECONDS_PER_YEAR).unwrap();
        assert_eq!(d, 500 * USDC);
    }

    #[test]
    fn discount_never_exceeds_the_amount() {
        let d = discount_for(100, u16::MAX, u64::MAX / 1_000_000_000).unwrap();
        assert_eq!(d, 100);
    }

    #[test]
    fn huge_amounts_do_not_overflow() {
        let d = discount_for(u64::MAX, MAX_RATE_BPS, MAX_TENOR_SECONDS as u64).unwrap();
        assert!(d <= u64::MAX);
    }

    #[test]
    fn rounding_favours_the_supplier() {
        // 1 base unit for 1 second at 1 bp is far below one base unit.
        assert_eq!(discount_for(1, 1, 1).unwrap(), 0);
    }

    #[test]
    fn fee_is_a_share_of_the_discount() {
        assert_eq!(fee_for(14_794_520, 1_000).unwrap(), 1_479_452);
        assert_eq!(fee_for(0, 1_000).unwrap(), 0);
        assert_eq!(fee_for(9, 1_000).unwrap(), 0);
    }
}
