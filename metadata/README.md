# Token metadata

`token.json` is **generated** by `npm run metadata` from `.env`. Do not edit it
by hand — name and symbol have to match what goes on chain, and a second copy of
them is how they drift apart.

`TOKEN_URI` in `.env` must point at **the uploaded JSON**, not at an image. The
image is referenced *from inside* the JSON, in its `image` field.

```
.env ──> npm run metadata ──> token.json ──> irys upload ──> TOKEN_URI
                                  └─ references TOKEN_IMAGE
```

Order matters: the image is uploaded first, its URL goes into `TOKEN_IMAGE`,
then the JSON is generated and uploaded, and its URL goes into `TOKEN_URI`.

## Why it has to be right the first time

`TOKEN_AUTHORITY=immutable` in `.env` hands the metadata update authority to the
system program. Nothing — not you, not Meteora — can change the name, symbol or
URI afterwards. A URI that 404s stays broken for the life of the token.

Set `TOKEN_AUTHORITY=creator` instead to keep the ability to fix it. You trade a
trust signal for a safety net.

## Where to host it

Both the JSON and the image need to outlive your infrastructure.

| Host | Permanent | Notes |
| --- | --- | --- |
| Arweave | yes, pay once | The default for Solana. Upload via Irys. |
| IPFS + pinning | while pinned | Pinata, NFT.Storage. Free tiers get garbage collected. |
| GitHub raw | **no** | Rate limited, blocked by some CDNs, dies with the repo or a rename. Fine for devnet, not for a launch. |
| Your own domain | **no** | Dies with the domain or the hosting bill. |

Upload the image first, put its URL in `image` and `properties.files[0].uri`,
then upload the JSON and use that URL as `TOKEN_URI`.

With Irys, in three steps. Irys bills a **prepaid balance**, so funding comes
first — uploading without it fails with `402 Not enough balance`.

```bash
npm i -g @irys/cli
W=~/.config/solana/id.json

# 1. Fund. The amount is in ATOMIC UNITS (lamports), not SOL.
#    10000000 = 0.01 SOL, which covers far more than a launch needs.
irys fund 10000000 -t solana -w $W

# 2. Image first, because the JSON has to reference its final URL.
irys upload logo.png -t solana -w $W --content-type image/png
#    -> paste the returned https://arweave.net/<id> into token.json,
#       in both "image" and "properties.files[0].uri"

# 3. Then the metadata. Its URL becomes TOKEN_URI.
irys upload token.json -t solana -w $W --content-type application/json
```

Storage is permanent and costs a fraction of a cent: under 50 KB is ~0.0000032
SOL, 1 MB is ~0.000041 SOL. Check any size with `irys price <bytes> -t solana`.

Uploads return a `https://gateway.irys.xyz/<id>` URL. On mainnet the same id
also resolves at `https://arweave.net/<id>`; either works as `TOKEN_URI`.

## Rehearsing on devnet

Pay with devnet SOL instead by adding **two** flags to every command. `-n devnet`
alone fails with *"requires a dev/testnet RPC to be configured"* — the Irys
devnet node cannot guess which Solana RPC to talk to.

```bash
D="-n devnet --provider-url https://api.devnet.solana.com"
irys fund 5000000 $D -t solana -w $W --no-confirmation
irys upload logo.png $D -t solana -w $W --content-type image/png --no-confirmation
```

Devnet storage is purged after roughly 60 days, and devnet ids do **not**
resolve on arweave.net. Never point a mainnet launch at a devnet upload.

## Common errors

| Error | Cause |
| --- | --- |
| `402 Not enough balance` | No prepaid balance, or funded on the wrong network. `irys balance <address> -t solana` shows it. |
| Funded but still 402 | `irys fund` takes lamports. `irys fund 0.01` funds 0.01 lamport. |
| Upload works, wallets show nothing | `TOKEN_URI` points at the image instead of the JSON. Run `npm run preview`. |
| `requires a dev/testnet RPC to be configured` | `-n devnet` needs `--provider-url https://api.devnet.solana.com` alongside it. |
| Crash with `ERR_USE_AFTER_CLOSE` | The interactive confirmation prompt fails outside a terminal. Add `--no-confirmation`. |
