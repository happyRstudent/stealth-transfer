# Stealth Transfer

Multi-chain native-token transfer tooling for routing funds through generated intermediate wallets. Stealth Transfer includes a TypeScript CLI and a browser-based Vite interface for Solana, Ethereum, BNB Smart Chain, and Base.

> This project is an educational privacy experiment. It does not guarantee anonymity. Same-amount hops, timing patterns, fee-payer behavior, RPC metadata, exchange deposits, and other on-chain or off-chain signals can still connect activity. Test with small amounts first, prefer devnet/test wallets, and never paste keys you are not prepared to use with this tool.

## What It Does

- Routes native tokens through configurable intermediate wallets.
- Supports Solana, Ethereum, BNB Smart Chain, and Base.
- Offers both CLI and Web UI workflows.
- Estimates route fees before execution.
- Executes hops in batches to keep transactions manageable.
- Adds optional delay between batches.
- Creates encrypted recovery bundles with PBKDF2-SHA256 and AES-GCM.
- Can continue, sweep, or refund interrupted routes from a recovery bundle.
- Keeps recovery encryption and route generation local to the client.

## Repository Layout

```text
src/
  chains/
    solana/      Solana RPC, transfer, recovery, and chain-specific types
    evm/         EVM RPC, transfer, recovery, and chain-specific types
  shared/        Cross-chain crypto, recovery, and shared type utilities
tests/           Node test suite
web/             Vite browser app
vercel.json      Vercel build configuration for the Web UI
```

## Requirements

- Node.js 20 or newer
- npm
- A funded source wallet
- An RPC endpoint for the chain you are using

Public RPC defaults are included for convenience, but serious testing should use a private or paid RPC endpoint.

## Install

```bash
npm install
cd web
npm install
```

## CLI

Build the TypeScript sources:

```bash
npm run build
```

Run a Solana transfer:

```bash
npm start -- \
  --chain solana \
  --key "<base58-secret-key-or-solana-json-array>" \
  --destination "<solana-destination-address>" \
  --amount 0.01 \
  --hops 4 \
  --batch-size 3 \
  --rpc "https://api.devnet.solana.com"
```

Run an EVM transfer:

```bash
npm start -- \
  --chain base \
  --key "<0x-private-key>" \
  --destination "<0x-destination-address>" \
  --amount 0.001 \
  --hops 6 \
  --batch-size 5 \
  --rpc "https://your-rpc.example.com"
```

Supported `--chain` values:

```text
solana | eth | bsc | base
```

Common options:

```text
-k, --key <private-key>        Source wallet private key
-d, --destination <address>    Destination wallet address
-c, --chain <chain>            solana, eth, bsc, or base
-n, --hops <number>            Number of intermediate wallets, 2-100
-a, --amount <number>          Native-token amount to transfer
-r, --rpc <url>                RPC URL override
--delay <ms>                   Delay between batches
--batch-size <number>          Hops per batch
```

## Web UI

Start the Vite app locally:

```bash
cd web
npm run dev
```

Create a production build:

```bash
cd web
npm run build
```

The Web UI provides chain tabs, private-key parsing, address validation hints, RPC selection/testing, fee estimates, recovery-bundle export, and recovery actions. Recovery bundles are encrypted in the browser before storage or download.

## Recovery Bundles

Recovery bundles store the route data needed to continue or unwind an interrupted transfer. They are encrypted with a password before being saved.

Use them to:

- Continue a route after a stopped browser session or failed batch.
- Sweep intermediate wallet balances forward to the destination.
- Refund intermediate wallet balances back to the source address.
- Export intermediate keys when you need manual recovery.

Keep the recovery password and encrypted bundle safe. Anyone with both may be able to move funds held by intermediate wallets.

## Testing

Run the Node test suite:

```bash
npm test
```

Build the Web UI:

```bash
cd web
npm run build
```

## Vercel Deployment

The repository includes `vercel.json` configured to install root and web dependencies, build the Vite app, and serve `web/dist`.

```bash
vercel deploy -y
```

Deployments should be treated as public frontends. Users still enter keys locally in their browser, but you should review hosted code and use trusted deployment settings before handling meaningful funds.

## Security Notes

- Start with small amounts and test wallets.
- Prefer devnet or fresh wallets while validating behavior.
- Use a trusted RPC endpoint when testing real funds.
- Do not share private keys, recovery passwords, or unencrypted recovery material.
- Inspect balances and transactions independently before and after a route.
- Understand that multi-hop routing is not the same thing as guaranteed privacy.

## License

MIT
