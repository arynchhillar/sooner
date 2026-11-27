# Deploying Sooner

Two things get deployed: the Solana program (to devnet) and the web app (to any Next.js host). Neither needs anything installed on your computer.

## 1. Deploy the program with Solana Playground

Solana Playground is a browser IDE that builds and deploys programs for you. It supports Anchor 0.29, which is what this program is written for; this program was built there successfully on 27 November 2026. Button names below may differ slightly from what you see.

1. Open <https://beta.solpg.io> and create a new project. Name it `sooner` and choose **Anchor (Rust)**.
2. Open `src/lib.rs` in the Playground, delete everything in it, and paste the whole of [`programs/sooner/src/lib.rs`](../programs/sooner/src/lib.rs) from this repository.
3. Press **Build**, next to *Program* in the Explorer (it is also in the Build & Deploy tab of the left sidebar). The terminal should print `Build successful`. Playground writes its own program address into `declare_id!` when it builds.
4. Connect the Playground wallet (bottom left of the window) and save the keypair file it offers when it creates one. That keypair is the program's upgrade authority.
5. The wallet needs devnet SOL to deploy: 2.14 SOL for this program, plus a little for fees. Solana closed the RPC faucet on devnet in 2026, so `solana airdrop` no longer works there. Paste the wallet address into <https://faucet.solana.com> and request at least 2.5 SOL.
6. Press **Deploy**. When it finishes, copy the **Program ID** shown in the Build & Deploy tab.

## 2. Put the program address into the repository

This repository points at the program deployed for the hackathon, `3k7jN3ufVfnp4w6UQDZkNmVimPKEU1pTcTXsxx3ABDHJ`. If you deploy your own copy, replace that address with your Program ID in these four places:

| File | Where |
|---|---|
| `app/src/lib/config.ts` | `PROGRAM_ID_STRING` |
| `programs/sooner/src/lib.rs` | `declare_id!` |
| `Anchor.toml` | `[programs.devnet]` |
| `README.md` | the table at the top |

Then refresh the client cross-check, because the addresses it contains depend on the program address:

```
cd app
npm install
npm run fixture
cd ..
cargo test -p sooner
```

If you skip this, `tests/js_client.rs` prints a note and skips itself; the other tests still run.

## 3. Deploy the web app

On Vercel:

1. **Add New, Project**, and import this repository.
2. Set **Root Directory** to `app`. Leave the framework as Next.js.
3. Deploy.

Optional environment variables:

| Name | What it does |
|---|---|
| `NEXT_PUBLIC_PROGRAM_ID` | Overrides the program address in `config.ts` |
| `NEXT_PUBLIC_RPC_URL` | A devnet RPC endpoint other than the public one |
| `NEXT_PUBLIC_REPO_URL` | Adds a "Source code" link to the footer |
| `DRIP_SECRET_KEY` | Lets the app send fee money to new demo wallets (step 4 below) |

## 4. Give demo wallets fee money

The demo creates two fresh wallets in the visitor's browser, and they need a little devnet SOL for network fees. Apps can no longer airdrop that themselves, so the deployment keeps a small fee wallet:

1. Open `/setup` on the live app and press **Create a fee-money wallet**.
2. Send that address devnet SOL from <https://faucet.solana.com>. Each demo session uses 0.03 SOL, so 2.5 SOL covers about 80 sessions.
3. Copy the secret key from the page into an environment variable called `DRIP_SECRET_KEY` on your host, and redeploy.

Without this, the demo stops at "Get devnet SOL" and shows the visitor a faucet link for their own demo wallet. People with their own devnet wallet can connect it instead.

## 5. Set the deployment up

The hackathon deployment is already set up (fee 10% of each discount, collected by the deploy wallet), so skip this step unless you deployed your own copy.

A freshly deployed program has no settings yet. Open the live app and press **Start the demo**: the first run creates the settings and the test dollar, and the wallet that does it becomes the fee collector. To use a specific wallet for that instead, connect it and open `/setup`.

## Building locally instead

With Anchor 0.29.0 and a matching Solana CLI installed, `anchor build` and `anchor deploy` should work from the repository root. This path has not been tested by us; the deployed build comes from Solana Playground.
