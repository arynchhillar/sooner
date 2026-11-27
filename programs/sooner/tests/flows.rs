//! Instruction-level tests for Sooner.
//!
//! They run the program in-process with `solana-program-test`, so they need
//! neither a validator nor the SBF toolchain:
//!
//! ```text
//! cargo test -p sooner
//! ```

use anchor_lang::{
    prelude::{AccountInfo, Clock, Pubkey},
    solana_program::{entrypoint::ProgramResult, instruction::Instruction, system_program},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use solana_program_test::{
    processor, tokio, BanksClientError, ProgramTest, ProgramTestContext,
};
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::InstructionError,
    program_pack::Pack,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::{Transaction, TransactionError},
};
use sooner::{discount_for, fee_for, Payable, Pool, Status};
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token_2022::{extension::StateWithExtensions, state::Account as TokenAccount};

const USD: u64 = 1_000_000;
const DAY: i64 = 86_400;
const T0: i64 = 1_800_000_000;
const FEE_BPS: u16 = 1_000; // the protocol keeps 10% of each discount
const RATE_BPS: u16 = 1_200; // the buyer offers 12% a year

// Anchor error codes: custom errors start at 6000 in declaration order.
const ERR_RATE_TOO_HIGH: u32 = 6000;
const ERR_ZERO_AMOUNT: u32 = 6002;
const ERR_DUE_DATE_IN_PAST: u32 = 6003;
const ERR_TENOR_TOO_LONG: u32 = 6004;
const ERR_SELF_DEALING: u32 = 6005;
const ERR_NOT_OPEN: u32 = 6006;
const ERR_POOL_SHORT: u32 = 6007;
const ERR_CONSTRAINT_HAS_ONE: u32 = 2001;

/// Anchor 0.29 wants one lifetime for the account slice and its contents;
/// the test harness hands them over with two.
fn entry<'a, 'b, 'c, 'd>(
    program_id: &'a Pubkey,
    accounts: &'b [AccountInfo<'c>],
    data: &'d [u8],
) -> ProgramResult {
    let accounts: &'c [AccountInfo<'c>] = Box::leak(Box::new(accounts.to_vec()));
    sooner::entry(program_id, accounts, data)
}

fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: sooner::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &sooner::ID).0
}

fn invoice_id(n: u8) -> [u8; 32] {
    [n; 32]
}

fn reference(label: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..label.len()].copy_from_slice(label.as_bytes());
    out
}

struct Env {
    ctx: ProgramTestContext,
    admin: Keypair,
    buyer: Keypair,
    supplier: Keypair,
    token_program: Pubkey,
    mint: Pubkey,
    nonce: u64,
}

impl Env {
    /// Boots the chain, initialises the protocol, opens a pool at 12% and
    /// leaves the buyer holding 10,000 dollars of the chosen token.
    async fn new(token_2022: bool) -> Self {
        let program = ProgramTest::new("sooner", sooner::ID, processor!(entry));
        let ctx = program.start_with_context().await;
        let admin = Keypair::from_bytes(&ctx.payer.to_bytes()).unwrap();
        let mut env = Env {
            ctx,
            admin,
            buyer: Keypair::new(),
            supplier: Keypair::new(),
            token_program: spl_token::ID,
            mint: pda(&[b"demo_mint"]),
            nonce: 0,
        };
        env.set_time(T0).await;

        let fund_wallets = [
            system_instruction::transfer(&env.admin.pubkey(), &env.buyer.pubkey(), 10_000_000_000),
            system_instruction::transfer(
                &env.admin.pubkey(),
                &env.supplier.pubkey(),
                10_000_000_000,
            ),
        ];
        env.send(&fund_wallets, &[]).await.unwrap();

        let initialize = ix(
            sooner::accounts::Initialize {
                admin: env.admin.pubkey(),
                config: pda(&[b"config"]),
                demo_mint: pda(&[b"demo_mint"]),
                token_program: spl_token::ID,
                system_program: system_program::ID,
            },
            sooner::instruction::Initialize { fee_bps: FEE_BPS },
        );
        env.send(&[initialize], &[]).await.unwrap();

        if token_2022 {
            env.token_program = spl_token_2022::ID;
            env.create_token_2022_mint().await;
        }

        for wallet in [env.buyer.pubkey(), env.supplier.pubkey(), env.admin.pubkey()] {
            let create = create_associated_token_account_idempotent(
                &env.admin.pubkey(),
                &wallet,
                &env.mint,
                &env.token_program,
            );
            env.send(&[create], &[]).await.unwrap();
        }

        if token_2022 {
            let mint_to = spl_token_2022::instruction::mint_to(
                &spl_token_2022::ID,
                &env.mint,
                &env.ata(&env.buyer.pubkey()),
                &env.admin.pubkey(),
                &[],
                10_000 * USD,
            )
            .unwrap();
            env.send(&[mint_to], &[]).await.unwrap();
        } else {
            let faucet = ix(
                sooner::accounts::DemoFaucet {
                    payer: env.admin.pubkey(),
                    config: pda(&[b"config"]),
                    demo_mint: env.mint,
                    recipient_token: env.ata(&env.buyer.pubkey()),
                    token_program: spl_token::ID,
                },
                sooner::instruction::DemoFaucet {},
            );
            env.send(&[faucet], &[]).await.unwrap();
        }

        let buyer = Keypair::from_bytes(&env.buyer.to_bytes()).unwrap();
        let open = ix(
            sooner::accounts::OpenPool {
                buyer: buyer.pubkey(),
                mint: env.mint,
                pool: env.pool(),
                vault: env.vault(),
                token_program: env.token_program,
                system_program: system_program::ID,
            },
            sooner::instruction::OpenPool { rate_bps: RATE_BPS },
        );
        env.send(&[open], &[&buyer]).await.unwrap();
        env
    }

    async fn create_token_2022_mint(&mut self) {
        let mint = Keypair::new();
        let rent = self.ctx.banks_client.get_rent().await.unwrap();
        let space = spl_token_2022::state::Mint::LEN;
        let create = system_instruction::create_account(
            &self.admin.pubkey(),
            &mint.pubkey(),
            rent.minimum_balance(space),
            space as u64,
            &spl_token_2022::ID,
        );
        let init = spl_token_2022::instruction::initialize_mint2(
            &spl_token_2022::ID,
            &mint.pubkey(),
            &self.admin.pubkey(),
            None,
            6,
        )
        .unwrap();
        self.send(&[create, init], &[&mint]).await.unwrap();
        self.mint = mint.pubkey();
    }

    /// Sends a transaction paid by the admin. A changing compute-unit price
    /// keeps otherwise identical transactions from sharing a signature.
    async fn send(
        &mut self,
        instructions: &[Instruction],
        extra_signers: &[&Keypair],
    ) -> Result<(), BanksClientError> {
        self.nonce += 1;
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_price(self.nonce)];
        all.extend_from_slice(instructions);
        let blockhash = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let mut signers: Vec<&Keypair> = vec![&self.admin];
        signers.extend_from_slice(extra_signers);
        let tx = Transaction::new_signed_with_payer(
            &all,
            Some(&self.admin.pubkey()),
            &signers,
            blockhash,
        );
        self.ctx.banks_client.process_transaction(tx).await
    }

    async fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        clock.unix_timestamp = unix_timestamp;
        self.ctx.set_sysvar(&clock);
    }

    fn ata(&self, wallet: &Pubkey) -> Pubkey {
        get_associated_token_address_with_program_id(wallet, &self.mint, &self.token_program)
    }

    fn pool(&self) -> Pubkey {
        pda(&[b"pool", self.buyer.pubkey().as_ref(), self.mint.as_ref()])
    }

    fn vault(&self) -> Pubkey {
        pda(&[b"vault", self.pool().as_ref()])
    }

    fn payable(&self, n: u8) -> Pubkey {
        pda(&[b"payable", self.pool().as_ref(), &invoice_id(n)])
    }

    async fn balance(&mut self, token_account: Pubkey) -> u64 {
        let account = self
            .ctx
            .banks_client
            .get_account(token_account)
            .await
            .unwrap()
            .expect("token account exists");
        StateWithExtensions::<TokenAccount>::unpack(&account.data)
            .unwrap()
            .base
            .amount
    }

    async fn pool_state(&mut self) -> Pool {
        let account = self
            .ctx
            .banks_client
            .get_account(self.pool())
            .await
            .unwrap()
            .unwrap();
        Pool::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    async fn payable_state(&mut self, n: u8) -> Payable {
        let account = self
            .ctx
            .banks_client
            .get_account(self.payable(n))
            .await
            .unwrap()
            .unwrap();
        Payable::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    async fn fund(&mut self, amount: u64) -> Result<(), BanksClientError> {
        let buyer = Keypair::from_bytes(&self.buyer.to_bytes()).unwrap();
        let fund = ix(
            sooner::accounts::Fund {
                funder: buyer.pubkey(),
                pool: self.pool(),
                mint: self.mint,
                vault: self.vault(),
                funder_token: self.ata(&buyer.pubkey()),
                token_program: self.token_program,
            },
            sooner::instruction::Fund { amount },
        );
        self.send(&[fund], &[&buyer]).await
    }

    async fn approve_for(
        &mut self,
        n: u8,
        supplier: Pubkey,
        amount: u64,
        due_at: i64,
    ) -> Result<(), BanksClientError> {
        let buyer = Keypair::from_bytes(&self.buyer.to_bytes()).unwrap();
        let approve = ix(
            sooner::accounts::ApprovePayable {
                buyer: buyer.pubkey(),
                pool: self.pool(),
                supplier,
                payable: self.payable(n),
                system_program: system_program::ID,
            },
            sooner::instruction::ApprovePayable {
                invoice_id: invoice_id(n),
                amount,
                due_at,
                reference: reference("INV-1042"),
            },
        );
        self.send(&[approve], &[&buyer]).await
    }

    async fn approve(&mut self, n: u8, amount: u64, due_at: i64) -> Result<(), BanksClientError> {
        let supplier = self.supplier.pubkey();
        self.approve_for(n, supplier, amount, due_at).await
    }

    async fn claim_as(&mut self, n: u8, who: &Keypair) -> Result<(), BanksClientError> {
        let claim = ix(
            sooner::accounts::Claim {
                supplier: who.pubkey(),
                config: pda(&[b"config"]),
                pool: self.pool(),
                payable: self.payable(n),
                mint: self.mint,
                vault: self.vault(),
                supplier_token: self.ata(&who.pubkey()),
                treasury_token: self.ata(&self.admin.pubkey()),
                token_program: self.token_program,
            },
            sooner::instruction::Claim {},
        );
        self.send(&[claim], &[who]).await
    }

    async fn claim(&mut self, n: u8) -> Result<(), BanksClientError> {
        let supplier = Keypair::from_bytes(&self.supplier.to_bytes()).unwrap();
        self.claim_as(n, &supplier).await
    }

    async fn settle(&mut self, n: u8) -> Result<(), BanksClientError> {
        let buyer = Keypair::from_bytes(&self.buyer.to_bytes()).unwrap();
        let settle = ix(
            sooner::accounts::Settle {
                buyer: buyer.pubkey(),
                pool: self.pool(),
                payable: self.payable(n),
                mint: self.mint,
                vault: self.vault(),
                supplier_token: self.ata(&self.supplier.pubkey()),
                token_program: self.token_program,
            },
            sooner::instruction::Settle {},
        );
        self.send(&[settle], &[&buyer]).await
    }
}

fn custom_code(err: BanksClientError) -> u32 {
    match err.unwrap() {
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => code,
        other => panic!("expected a program error, got {other:?}"),
    }
}

#[tokio::test]
async fn early_claim_pays_the_amount_minus_the_discount() {
    let mut env = Env::new(false).await;
    env.fund(5_000 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 45 * DAY).await.unwrap();
    env.claim(1).await.unwrap();

    let discount = discount_for(1_000 * USD, RATE_BPS, 45 * 86_400).unwrap();
    let fee = fee_for(discount, FEE_BPS).unwrap();
    assert_eq!(discount, 14_794_520);
    assert_eq!(fee, 1_479_452);

    let supplier_ata = env.ata(&env.supplier.pubkey());
    let treasury_ata = env.ata(&env.admin.pubkey());
    let vault = env.vault();
    assert_eq!(env.balance(supplier_ata).await, 1_000 * USD - discount);
    assert_eq!(env.balance(treasury_ata).await, fee);
    assert_eq!(
        env.balance(vault).await,
        5_000 * USD - (1_000 * USD - discount) - fee
    );

    let payable = env.payable_state(1).await;
    assert_eq!(payable.status, Status::PaidEarly);
    assert_eq!(payable.paid_amount, 1_000 * USD - discount);
    assert_eq!(payable.discount, discount);
    assert_eq!(payable.paid_at, T0);

    let pool = env.pool_state().await;
    assert_eq!(pool.outstanding, 0);
    assert_eq!(pool.total_approved, 1_000 * USD);
    assert_eq!(pool.total_paid, 1_000 * USD - discount);
    assert_eq!(pool.total_discount, discount);
    assert_eq!(pool.total_fees, fee);
    assert_eq!(pool.count_early, 1);
    assert_eq!(pool.seconds_early, 45 * 86_400);
}

#[tokio::test]
async fn the_discount_shrinks_as_the_due_date_approaches() {
    let mut env = Env::new(false).await;
    env.fund(5_000 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 45 * DAY).await.unwrap();
    env.approve(2, 1_000 * USD, T0 + 45 * DAY).await.unwrap();

    env.claim(1).await.unwrap();
    env.set_time(T0 + 30 * DAY).await;
    env.claim(2).await.unwrap();

    let first = env.payable_state(1).await;
    let second = env.payable_state(2).await;
    assert_eq!(
        second.discount,
        discount_for(1_000 * USD, RATE_BPS, 15 * 86_400).unwrap()
    );
    assert!(second.discount < first.discount);
    assert!(second.paid_amount > first.paid_amount);
}

#[tokio::test]
async fn an_invoice_cannot_be_paid_twice() {
    let mut env = Env::new(false).await;
    env.fund(5_000 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 45 * DAY).await.unwrap();
    env.claim(1).await.unwrap();

    assert_eq!(custom_code(env.claim(1).await.unwrap_err()), ERR_NOT_OPEN);
    assert_eq!(custom_code(env.settle(1).await.unwrap_err()), ERR_NOT_OPEN);
}

#[tokio::test]
async fn the_rate_is_locked_when_the_invoice_is_approved() {
    let mut env = Env::new(false).await;
    env.fund(5_000 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 45 * DAY).await.unwrap();

    let buyer = Keypair::from_bytes(&env.buyer.to_bytes()).unwrap();
    let set_rate = ix(
        sooner::accounts::SetRate {
            buyer: buyer.pubkey(),
            pool: env.pool(),
        },
        sooner::instruction::SetRate { rate_bps: 3_000 },
    );
    env.send(&[set_rate], &[&buyer]).await.unwrap();
    env.approve(2, 1_000 * USD, T0 + 45 * DAY).await.unwrap();

    env.claim(1).await.unwrap();
    env.claim(2).await.unwrap();
    assert_eq!(
        env.payable_state(1).await.discount,
        discount_for(1_000 * USD, 1_200, 45 * 86_400).unwrap()
    );
    assert_eq!(
        env.payable_state(2).await.discount,
        discount_for(1_000 * USD, 3_000, 45 * 86_400).unwrap()
    );

    let too_high = ix(
        sooner::accounts::SetRate {
            buyer: buyer.pubkey(),
            pool: env.pool(),
        },
        sooner::instruction::SetRate { rate_bps: 5_001 },
    );
    assert_eq!(
        custom_code(env.send(&[too_high], &[&buyer]).await.unwrap_err()),
        ERR_RATE_TOO_HIGH
    );
}

#[tokio::test]
async fn a_claim_after_the_due_date_is_paid_in_full_and_recorded_as_late() {
    let mut env = Env::new(false).await;
    env.fund(5_000 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 10 * DAY).await.unwrap();
    env.set_time(T0 + 13 * DAY).await;
    env.claim(1).await.unwrap();

    let supplier_ata = env.ata(&env.supplier.pubkey());
    let treasury_ata = env.ata(&env.admin.pubkey());
    assert_eq!(env.balance(supplier_ata).await, 1_000 * USD);
    assert_eq!(env.balance(treasury_ata).await, 0);

    let payable = env.payable_state(1).await;
    assert_eq!(payable.status, Status::PaidLate);
    assert_eq!(payable.discount, 0);

    let pool = env.pool_state().await;
    assert_eq!(pool.count_late, 1);
    assert_eq!(pool.seconds_late, 3 * 86_400);
}

#[tokio::test]
async fn the_buyer_can_pay_in_full_before_the_due_date() {
    let mut env = Env::new(false).await;
    env.fund(5_000 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 30 * DAY).await.unwrap();
    env.set_time(T0 + 20 * DAY).await;
    env.settle(1).await.unwrap();

    let supplier_ata = env.ata(&env.supplier.pubkey());
    assert_eq!(env.balance(supplier_ata).await, 1_000 * USD);
    let payable = env.payable_state(1).await;
    assert_eq!(payable.status, Status::PaidOnTime);
    assert_eq!(payable.paid_amount, 1_000 * USD);

    let pool = env.pool_state().await;
    assert_eq!(pool.count_on_time, 1);
    assert_eq!(pool.total_discount, 0);
    assert_eq!(pool.seconds_early, 10 * 86_400);
}

#[tokio::test]
async fn a_late_settlement_is_recorded_as_late() {
    let mut env = Env::new(false).await;
    env.fund(5_000 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 30 * DAY).await.unwrap();
    env.set_time(T0 + 31 * DAY).await;
    env.settle(1).await.unwrap();

    assert_eq!(env.payable_state(1).await.status, Status::PaidLate);
    assert_eq!(env.pool_state().await.count_late, 1);
}

#[tokio::test]
async fn the_supplier_can_void_an_open_invoice() {
    let mut env = Env::new(false).await;
    env.fund(5_000 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 30 * DAY).await.unwrap();
    assert_eq!(env.pool_state().await.outstanding, 1_000 * USD);

    let supplier = Keypair::from_bytes(&env.supplier.to_bytes()).unwrap();
    let void = ix(
        sooner::accounts::VoidPayable {
            supplier: supplier.pubkey(),
            pool: env.pool(),
            payable: env.payable(1),
        },
        sooner::instruction::VoidPayable {},
    );
    env.send(&[void], &[&supplier]).await.unwrap();

    assert_eq!(env.payable_state(1).await.status, Status::Voided);
    let pool = env.pool_state().await;
    assert_eq!(pool.outstanding, 0);
    assert_eq!(pool.count_voided, 1);
    assert_eq!(custom_code(env.claim(1).await.unwrap_err()), ERR_NOT_OPEN);

    // The buyer cannot void its own commitment.
    env.approve(2, 1_000 * USD, T0 + 30 * DAY).await.unwrap();
    let buyer = Keypair::from_bytes(&env.buyer.to_bytes()).unwrap();
    let buyer_void = ix(
        sooner::accounts::VoidPayable {
            supplier: buyer.pubkey(),
            pool: env.pool(),
            payable: env.payable(2),
        },
        sooner::instruction::VoidPayable {},
    );
    assert_eq!(
        custom_code(env.send(&[buyer_void], &[&buyer]).await.unwrap_err()),
        ERR_CONSTRAINT_HAS_ONE
    );
}

#[tokio::test]
async fn only_the_named_supplier_can_claim() {
    let mut env = Env::new(false).await;
    env.fund(5_000 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 30 * DAY).await.unwrap();

    let stranger = Keypair::new();
    let create = create_associated_token_account_idempotent(
        &env.admin.pubkey(),
        &stranger.pubkey(),
        &env.mint,
        &env.token_program,
    );
    env.send(&[create], &[]).await.unwrap();

    assert_eq!(
        custom_code(env.claim_as(1, &stranger).await.unwrap_err()),
        ERR_CONSTRAINT_HAS_ONE
    );
    assert_eq!(env.payable_state(1).await.status, Status::Open);
}

#[tokio::test]
async fn a_claim_fails_cleanly_when_the_vault_is_short() {
    let mut env = Env::new(false).await;
    env.fund(500 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 30 * DAY).await.unwrap();

    assert_eq!(custom_code(env.claim(1).await.unwrap_err()), ERR_POOL_SHORT);
    assert_eq!(custom_code(env.settle(1).await.unwrap_err()), ERR_POOL_SHORT);
    assert_eq!(env.payable_state(1).await.status, Status::Open);

    // Once the buyer tops the vault up, the same claim goes through.
    env.fund(600 * USD).await.unwrap();
    env.claim(1).await.unwrap();
    assert_eq!(env.payable_state(1).await.status, Status::PaidEarly);
}

#[tokio::test]
async fn only_the_buyer_can_take_cash_out_of_the_vault() {
    let mut env = Env::new(false).await;
    env.fund(5_000 * USD).await.unwrap();

    let supplier = Keypair::from_bytes(&env.supplier.to_bytes()).unwrap();
    let steal = ix(
        sooner::accounts::Withdraw {
            buyer: supplier.pubkey(),
            pool: env.pool(),
            mint: env.mint,
            vault: env.vault(),
            destination: env.ata(&supplier.pubkey()),
            token_program: env.token_program,
        },
        sooner::instruction::Withdraw { amount: 1_000 * USD },
    );
    assert_eq!(
        custom_code(env.send(&[steal], &[&supplier]).await.unwrap_err()),
        ERR_CONSTRAINT_HAS_ONE
    );

    let buyer = Keypair::from_bytes(&env.buyer.to_bytes()).unwrap();
    let withdraw = |amount: u64| {
        ix(
            sooner::accounts::Withdraw {
                buyer: buyer.pubkey(),
                pool: env.pool(),
                mint: env.mint,
                vault: env.vault(),
                destination: env.ata(&buyer.pubkey()),
                token_program: env.token_program,
            },
            sooner::instruction::Withdraw { amount },
        )
    };
    let ok = withdraw(2_000 * USD);
    let too_much = withdraw(3_001 * USD);
    env.send(&[ok], &[&buyer]).await.unwrap();
    let vault = env.vault();
    let buyer_ata = env.ata(&buyer.pubkey());
    assert_eq!(env.balance(vault).await, 3_000 * USD);
    assert_eq!(env.balance(buyer_ata).await, 7_000 * USD);
    assert_eq!(
        custom_code(env.send(&[too_much], &[&buyer]).await.unwrap_err()),
        ERR_POOL_SHORT
    );
}

#[tokio::test]
async fn approvals_are_checked() {
    let mut env = Env::new(false).await;

    assert_eq!(
        custom_code(env.approve(1, 0, T0 + 30 * DAY).await.unwrap_err()),
        ERR_ZERO_AMOUNT
    );
    assert_eq!(
        custom_code(env.approve(1, 1_000 * USD, T0).await.unwrap_err()),
        ERR_DUE_DATE_IN_PAST
    );
    assert_eq!(
        custom_code(
            env.approve(1, 1_000 * USD, T0 + 367 * DAY)
                .await
                .unwrap_err()
        ),
        ERR_TENOR_TOO_LONG
    );
    let buyer = env.buyer.pubkey();
    assert_eq!(
        custom_code(
            env.approve_for(1, buyer, 1_000 * USD, T0 + 30 * DAY)
                .await
                .unwrap_err()
        ),
        ERR_SELF_DEALING
    );

    // The same invoice cannot be approved twice.
    env.approve(1, 1_000 * USD, T0 + 30 * DAY).await.unwrap();
    assert!(env.approve(1, 1_000 * USD, T0 + 30 * DAY).await.is_err());
    assert_eq!(env.pool_state().await.count_approved, 1);
}

#[tokio::test]
async fn it_works_with_a_token_2022_mint() {
    let mut env = Env::new(true).await;
    env.fund(5_000 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 45 * DAY).await.unwrap();
    env.claim(1).await.unwrap();

    let discount = discount_for(1_000 * USD, RATE_BPS, 45 * 86_400).unwrap();
    let supplier_ata = env.ata(&env.supplier.pubkey());
    let treasury_ata = env.ata(&env.admin.pubkey());
    assert_eq!(env.balance(supplier_ata).await, 1_000 * USD - discount);
    assert_eq!(
        env.balance(treasury_ata).await,
        fee_for(discount, FEE_BPS).unwrap()
    );
    assert_eq!(env.payable_state(1).await.status, Status::PaidEarly);
}

#[tokio::test]
async fn the_payment_record_adds_up() {
    let mut env = Env::new(false).await;
    env.fund(9_000 * USD).await.unwrap();
    env.approve(1, 1_000 * USD, T0 + 40 * DAY).await.unwrap();
    env.approve(2, 2_000 * USD, T0 + 40 * DAY).await.unwrap();
    env.approve(3, 3_000 * USD, T0 + 40 * DAY).await.unwrap();
    assert_eq!(env.pool_state().await.outstanding, 6_000 * USD);

    env.claim(1).await.unwrap(); // early, at a discount
    env.set_time(T0 + 40 * DAY).await;
    env.settle(2).await.unwrap(); // on the due date, in full
    env.set_time(T0 + 42 * DAY).await;
    env.settle(3).await.unwrap(); // two days late

    let discount = discount_for(1_000 * USD, RATE_BPS, 40 * 86_400).unwrap();
    let pool = env.pool_state().await;
    assert_eq!(pool.count_approved, 3);
    assert_eq!(pool.count_early, 1);
    assert_eq!(pool.count_on_time, 1);
    assert_eq!(pool.count_late, 1);
    assert_eq!(pool.outstanding, 0);
    assert_eq!(pool.total_approved, 6_000 * USD);
    assert_eq!(pool.total_paid, 6_000 * USD - discount);
    assert_eq!(pool.total_discount, discount);
    assert_eq!(pool.seconds_early, 40 * 86_400);
    assert_eq!(pool.seconds_late, 2 * 86_400);

    // Every dollar is accounted for: buyer + vault + supplier + treasury.
    let buyer_ata = env.ata(&env.buyer.pubkey());
    let supplier_ata = env.ata(&env.supplier.pubkey());
    let treasury_ata = env.ata(&env.admin.pubkey());
    let vault = env.vault();
    let total = env.balance(buyer_ata).await
        + env.balance(supplier_ata).await
        + env.balance(treasury_ata).await
        + env.balance(vault).await;
    assert_eq!(total, 10_000 * USD);
}
