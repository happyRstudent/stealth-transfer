# Stealth Transfer

Recoverable multi-hop SOL transfer tooling for Solana. The project includes a TypeScript CLI and a Vite web interface that can route a transfer through generated intermediate wallets, estimate fees, and create encrypted recovery bundles so interrupted routes can be continued, swept to the destination, or refunded to the source.

> This is an educational experiment, not a guarantee of anonymity. Same-amount hops, timing, fee-payer behavior, RPC metadata, and other on-chain/off-chain signals can still link activity. Test on devnet first and never paste keys you are not prepared to use in this tool.

## Features

- Generate intermediate Solana wallets for a multi-hop transfer route.
- Execute transfers in configurable batches to stay within transaction-size limits.
- Estimate signature fees before execution.
- Encrypt recovery bundles locally with PBKDF2-SHA256 and AES-GCM.
- Resume, sweep, or refund recoverable intermediate balances.
- Run from the CLI or from the browser-based Vite UI.

## Project Structure

```text
src/              Core transfer, recovery, and RPC utilities
tests/            Node test suite
web/              Vite browser UI
dist/             Generated TypeScript build output
```

## Requirements

- Node.js 20 or newer
- npm
- A Solana RPC endpoint
- A funded Solana keypair for transfers

## Install

```bash
npm install
cd web
npm install
```

## CLI Usage

Build the TypeScript sources:

```bash
npm run build
```

Run a devnet transfer:

```bash
npm run devnet -- \
  --key "<base58-secret-key-or-json-array>" \
  --destination "<destination-address>" \
  --amount 0.01 \
  --hops 4 \
  --batch-size 3
```

Run against a custom RPC:

```bash
npm start -- \
  --key "<base58-secret-key-or-json-array>" \
  --destination "<destination-address>" \
  --amount 0.1 \
  --hops 10 \
  --rpc "https://your-rpc.example.com"
```

## Web UI

Start the local Vite app:

```bash
cd web
npm run dev
```

Create a production build:

```bash
cd web
npm run build
```

The web UI performs key parsing, route generation, recovery-bundle encryption, and transfer execution in the browser. Recovery bundles are encrypted locally before they are stored or downloaded.

## Testing

```bash
npm test
```

## Deployment

This repository is configured for Vercel. The Vercel build installs root and web dependencies, builds the web app, and serves `web/dist`.

```bash
vercel deploy -y
```

## Security Notes

- Prefer devnet while testing.
- Use a private or paid RPC endpoint for serious experiments.
- Do not share private keys or unencrypted recovery material.
- Keep the recovery password and encrypted bundle together only when you are comfortable with the risk.
- Inspect transactions and balances independently before sending meaningful funds.

## License

MIT
