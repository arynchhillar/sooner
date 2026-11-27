//! Cross-check between the web client and the program.
//!
//! `fixtures/js-client.json` holds the instructions the web app builds for a
//! whole invoice life cycle (see `app/scripts/client-fixture.ts`). This test
//! executes them, in order, against the program. It fails if the TypeScript
//! client and the Rust program ever disagree about an account order, a seed
//! or an argument type.
//!
//! After changing the program address, regenerate the fixture:
//!
//! ```text
//! cd app && npm run fixture
//! ```

use anchor_lang::{
    prelude::{AccountInfo, Clock, Pubkey},
    solana_program::{
        entrypoint::ProgramResult,
        instruction::{AccountMeta, Instruction},
    },
    AccountDeserialize,
};
use serde::Deserialize;
use solana_program_test::{processor, tokio, ProgramTest};
use solana_sdk::{
    signature::{Keypair, Signer},
    system_instruction,
    transaction::Transaction,
};
use sooner::{discount_for, fee_for, Payable, Pool, Status};
use spl_associated_token_account::get_associated_token_address_with_program_id;
use spl_token_2022::{extension::StateWithExtensions, state::Account as TokenAccount};
use std::str::FromStr;

const USD: u64 = 1_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    program_id: String,
    clock: i64,
    keys: Keys,
    payables: Payables,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
struct Keys {
    buyer: Vec<u8>,
    supplier: Vec<u8>,
}

#[derive(Deserialize)]
struct Payables {
    first: String,
    second: String,
    third: String,
}

#[derive(Deserialize)]
struct Step {
    label: String,
    signer: String,
    instructions: Vec<FixtureInstruction>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureInstruction {
    program_id: String,
    accounts: Vec<FixtureAccount>,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureAccount {
    pubkey: String,
    is_signer: bool,
    is_writable: bool,
}

fn key(text: &str) -> Pubkey {
    Pubkey::from_str(text).unwrap()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn to_instruction(ix: &FixtureInstruction) -> Instruction {
    Instruction {
        program_id: key(&ix.program_id),
        accounts: ix
            .accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: key(&a.pubkey),
                is_signer: a.is_signer,
                is_writable: a.is_writable,
            })
            .collect(),
        data: unhex(&ix.data),
    }
}

/// Anchor 0.29 wants one lifetime for the account slice and its contents.
fn entry<'a, 'b, 'c, 'd>(
    program_id: &'a Pubkey,
    accounts: &'b [AccountInfo<'c>],
    data: &'d [u8],
) -> ProgramResult {
    let accounts: &'c [AccountInfo<'c>] = Box::leak(Box::new(accounts.to_vec()));
    sooner::entry(program_id, accounts, data)
}

#[tokio::test]
async fn instructions_built_by_the_web_client_run_against_the_program() {
    let fixture: Fixture = serde_json::from_str(include_str!("fixtures/js-client.json")).unwrap();
    if fixture.program_id != sooner::ID.to_string() {
        eprintln!(
            "skipped: the fixture was built for program {}, the program is now {}. Run `npm run fixture` in app/.",
            fixture.program_id,
            sooner::ID
        );
        return;
    }

    let mut ctx = ProgramTest::new("sooner", sooner::ID, processor!(entry))
        .start_with_context()
        .await;
    let mut clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp = fixture.clock;
    ctx.set_sysvar(&clock);

    let buyer = Keypair::from_bytes(&fixture.keys.buyer).unwrap();
    let supplier = Keypair::from_bytes(&fixture.keys.supplier).unwrap();
    let payer = Keypair::from_bytes(&ctx.payer.to_bytes()).unwrap();
    let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let fund = Transaction::new_signed_with_payer(
        &[
            system_instruction::transfer(&payer.pubkey(), &buyer.pubkey(), 5_000_000_000),
            system_instruction::transfer(&payer.pubkey(), &supplier.pubkey(), 5_000_000_000),
        ],
        Some(&payer.pubkey()),
        &[&payer],
        blockhash,
    );
    ctx.banks_client.process_transaction(fund).await.unwrap();

    // Each step is one transaction, signed and paid for by the wallet the app would use.
    for step in &fixture.steps {
        let signer = if step.signer == "buyer" { &buyer } else { &supplier };
        let instructions: Vec<Instruction> = step.instructions.iter().map(to_instruction).collect();
        let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &instructions,
            Some(&signer.pubkey()),
            &[signer],
            blockhash,
        );
        ctx.banks_client
            .process_transaction(tx)
            .await
            .unwrap_or_else(|error| panic!("step '{}' failed: {error:?}", step.label));
    }

    let mint = Pubkey::find_program_address(&[b"demo_mint"], &sooner::ID).0;
    let pool_address =
        Pubkey::find_program_address(&[b"pool", buyer.pubkey().as_ref(), mint.as_ref()], &sooner::ID).0;
    let vault = Pubkey::find_program_address(&[b"vault", pool_address.as_ref()], &sooner::ID).0;

    let payable = |address: &str| {
        let address = key(address);
        let mut client = ctx.banks_client.clone();
        async move {
            let account = client.get_account(address).await.unwrap().unwrap();
            Payable::try_deserialize(&mut account.data.as_slice()).unwrap()
        }
    };
    let first = payable(&fixture.payables.first).await;
    let second = payable(&fixture.payables.second).await;
    let third = payable(&fixture.payables.third).await;

    let discount = discount_for(1_000 * USD, 1_200, 45 * 86_400).unwrap();
    let fee = fee_for(discount, 1_000).unwrap();
    assert_eq!(first.status, Status::PaidEarly);
    assert_eq!(first.paid_amount, 1_000 * USD - discount);
    assert_eq!(first.reference[..8], *b"INV-1042");
    assert_eq!(second.status, Status::PaidOnTime);
    assert_eq!(second.paid_amount, 2_650 * USD);
    assert_eq!(third.status, Status::Voided);
    assert_eq!(third.rate_bps, 1_800, "INV-1044 was approved after the rate change");

    let balance = |address: Pubkey| {
        let mut client = ctx.banks_client.clone();
        async move {
            let account = client.get_account(address).await.unwrap().unwrap();
            StateWithExtensions::<TokenAccount>::unpack(&account.data)
                .unwrap()
                .base
                .amount
        }
    };
    let ata = |wallet: &Pubkey| get_associated_token_address_with_program_id(wallet, &mint, &spl_token::ID);

    assert_eq!(
        balance(ata(&supplier.pubkey())).await,
        1_000 * USD - discount + 2_650 * USD
    );
    // 1,500 in, INV-1042 out, a 2,150 top-up, INV-1043 out, 300 in, 100 out.
    assert_eq!(balance(vault).await, 200 * USD + discount - fee);
    // The buyer set the deployment up, so it also collects the protocol fee.
    assert_eq!(
        balance(ata(&buyer.pubkey())).await,
        10_000 * USD - 1_500 * USD - 2_150 * USD - 300 * USD + 100 * USD + fee
    );

    let account = ctx.banks_client.get_account(pool_address).await.unwrap().unwrap();
    let pool = Pool::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(pool.rate_bps, 1_800);
    assert_eq!(pool.outstanding, 0);
    assert_eq!(
        (pool.count_approved, pool.count_early, pool.count_on_time, pool.count_voided),
        (3, 1, 1, 1)
    );
}
