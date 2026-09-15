# launchpad

Launch a token on Solana with Meteora's Dynamic Bonding Curve, from the CLI.

The token opens on a bonding curve. Buyers move the price along that curve; when
enough SOL has been raised, the curve completes and the liquidity graduates to a
DAMM v2 pool at whatever price the bonding phase discovered.

## Setup

```bash
npm install
cp .env.example .env      # then edit it
npm link                  # optional: installs the `launchpad` command
```

With `npm link`, every `npm run <command>` below is also available as
`launchpad <command>`, callable from any directory. It reads the `.env` and
writes the `.launch/` of wherever you run it, so keeping one folder per launch
works without any extra configuration. `launchpad` on its own lists the
commands in the order a launch runs.

You need a funded devnet wallet:

```bash
solana-keygen new -o ~/.config/solana/id.json   # if you don't have one
solana airdrop 2 --url devnet
```

The public devnet faucet is stingy. https://faucet.solana.com/ is the fallback.

## The launch sequence

Everything flows from `.env`. Two things have to be uploaded before the token
can exist, and each upload returns a URL that goes back into `.env` — that is
the only manual copying in the whole process.

```
                    logo.png
                       │  irys upload
                       ▼
              TOKEN_IMAGE=https://gateway.irys.xyz/4dXs…
                       │
    .env ──────────────┤  npm run metadata
      │                ▼
      │        metadata/token.json   (generated, never hand-edited)
      │                │  irys upload
      │                ▼
      └──────── TOKEN_URI=https://gateway.irys.xyz/2wXj…
                       │
                       ▼  npm run preview        ← validates, signs nothing
                       │
                       ▼  npm run pre-launch     ← config key, mint and pool addresses, sends nothing
                       │
                       ▼  npm run launch         ← config + mint + pool + first buy
                       │
                       ▼  npm run status / buy
```

### 1. Fund the Irys account

Uploads are prepaid, and cost a fraction of a cent. Skipping this is what
produces `402 Not enough balance`.

```bash
W=~/.config/solana/id.json
D="-n devnet --provider-url https://api.devnet.solana.com"   # drop $D for mainnet

irys fund 5000000 $D -t solana -w $W --no-confirmation       # lamports, = 0.005 SOL
```

### 2. Upload the icon

Put your logo in `metadata/`, then:

```bash
irys upload metadata/logo.png $D -t solana -w $W --content-type image/png --no-confirmation
```

Copy the returned URL into `.env`:

```
TOKEN_IMAGE=https://gateway.irys.xyz/<id>
```

512×512 is plenty. The file is served at icon size everywhere.

### 3. Generate the metadata JSON

```bash
npm run metadata
```

Builds `metadata/token.json` from `.env` — `name` and `symbol` come from
`TOKEN_NAME` / `TOKEN_SYMBOL`, so they cannot drift from what goes on chain.
Unset socials are omitted rather than written as placeholders. It reads the
image's real content type and refuses to run if `TOKEN_IMAGE` is empty.

### 4. Upload it, and close the loop

The command is printed by step 3 with the right flags for your `RPC_URL`:

```bash
irys upload metadata/token.json $D -t solana -w $W --content-type application/json --no-confirmation
```

Copy the returned URL into `.env`:

```
TOKEN_URI=https://gateway.irys.xyz/<id>
```

This is `TOKEN_URI`: the URL of the **JSON**, not of the image. Arweave assigns
ids at upload time, which is why this last paste cannot be automated.

### 5. Check everything

```bash
npm run preview
```

Signs nothing. It prints the supply split, the curve, the fees, and what you
earn at migration — then runs two checks that matter:

- **Metadata** — fetches `TOKEN_URI`, confirms it is JSON, that its name and
  symbol match `.env`, and that the image actually loads.
- **Program validation** — builds the real `create_config` instruction and
  simulates it against the chain, reporting the program's own verdict.

Both must pass. `accepted` means the program will take the config; it says
nothing about whether the economics match your intent — check the numbers
yourself, especially the USD figures printed at the live rate.

### 6. Get the addresses in advance

```bash
npm run pre-launch
```

Sends nothing. Draws the config and mint keypairs, prints the config key, the
base mint and the pool address they produce, and saves the keypairs to
`.launch/<symbol>.keys.json`. Running it again prints the same addresses, so
they are safe to announce. `npm run pre-launch -- --new` draws fresh ones.

The pool address depends on `QUOTE_TOKEN`: `launch` refuses to run if it changed
since, until `pre-launch` has printed the new pool.

### 7. Launch

```bash
npm run launch
```

Two transactions: the config, then the pool with your first buy bundled in
atomically so the opening price cannot be sniped. It signs with the keys from
`pre-launch`, or draws and saves its own if you skipped that step. Addresses are
written to `.launch/<symbol>.json` and the keys file is deleted.

If it fails between the two transactions, run it again: it finds the config
already on chain and reuses it, provided `.env` still describes the same
partner, quote and curve.

```bash
npm run status   # curve progress, price, fees earned
npm run buy      # quote and execute a swap
npm run claim       # bonding-curve trading fees, surplus and migration fees
npm run migrate     # graduate to DAMM v2 once the curve completes
npm run leftover    # send the leftover to the split wallets (--watch waits for migration)
npm run claim-pool  # DAMM v2 pool fees, after migration
```

All of them read the launch record, so they act on the token you launched last.

`buy` switches to a partial fill when the requested amount exceeds what the
curve can still absorb, which is what every final buy of a launch runs into.

`claim` reads the on-chain breakdown before acting, because `CREATOR_FEE_PCT`
decides which side holds the money — calling the wrong path returns nothing and
looks like a failure. It skips dust: claiming a balance worth less than the
transaction fee is a net loss.

`claim` and `claim-pool` cover two different programs. Bonding-curve fees live
on the DBC pool and stop accruing at migration; after that, fees accrue on the
DAMM v2 **position NFTs** and only `claim-pool` can see them. Both are worth
running once a launch has graduated.

Permanently locked liquidity still earns: claiming fees is a separate
instruction from withdrawing liquidity, so a 100% locked position collects
normally.

`migrate` is only needed when no keeper picks the pool up: on devnet, where none
run, or on mainnet below the 10 SOL / 750 USDC / 1500 JUP keeper threshold. A
pool with locked vesting stops at `PostBondingCurve` and needs its escrow
created first, so the script runs two transactions instead of one.

### Splitting the leftover

The program pays the whole leftover to one address, the partner wallet, fixed
in the config at launch. To send it to two wallets instead — two multisig
vaults, say — set `LEFTOVER_COMMUNITY_WALLET` and `LEFTOVER_TREASURY_WALLET`
with their exact amounts, `LEFTOVER_COMMUNITY_AMOUNT` and
`LEFTOVER_TREASURY_AMOUNT`. The withdrawal and both transfers are one
transaction, so the split tokens never rest on the partner wallet. The program
pays `TOKEN_LEFTOVER` plus a little curve rounding; whatever exceeds the two
amounts stays on the partner wallet.

The leftover can only be withdrawn once the DAMM v2 pool exists. `migrate`
splits it right after migrating. When a keeper migrates instead, at a time
nobody announces, run this beforehand:

```bash
launchpad leftover --watch
```

It polls the pool every few seconds and sends the split the moment the
migration lands. `launchpad leftover` without `--watch` does it once, for a pool
that has already migrated. `claim` never touches the leftover, so a failing fee
claim cannot hold it back.

For a Squads multisig, use the **vault** address. Tokens sent to the multisig
account itself can never be moved, so `preview` and the split both refuse any
address owned by a program.

Withdrawing the leftover is permissionless: anyone can do it first, which lands
it unsplit on the partner wallet. `leftover` finds that withdrawal in the pool
history and, with `launchpad leftover --forward-leftover`, sends the split from
there. The signature is written to the launch record so it cannot go out twice.

### Re-running a step

`metadata` is idempotent. Every `irys upload` produces a **new** URL — you
cannot overwrite one, so changing the icon or the description means uploading
again and updating `.env` again. On the mainnet profile the on-chain metadata is
immutable, so do this before launching, never after.

## Layout

| File | Role |
| --- | --- |
| `.env` | Every launch parameter. **The only file you edit.** |
| `src/env.ts` | Parses and validates `.env`; nothing else reads it |
| `src/curve.ts` | Turns the config into on-chain parameters |
| `src/preview.ts` | Prints and validates the launch before you sign it |
| `src/metadata.ts` | Generates `metadata/token.json` from `.env` |
| `src/pre-launch.ts` | Draws the config and mint keypairs ahead of the launch |
| `src/launch.ts` | Creates the config, then the pool with a first buy |
| `src/buy.ts` | Quotes and executes a swap |
| `src/status.ts` | Reads curve progress, price and fee state |
| `src/migrate.ts` | Creates the locker if needed, then graduates to DAMM v2 |
| `src/claim.ts` | Collects bonding-curve trading fees, surplus and migration fees |
| `src/leftover.ts` | Sends the leftover to the split wallets, waiting for migration with `--watch` |
| `src/claim-pool.ts` | Collects DAMM v2 pool fees after migration |
| `src/cli.ts` | Command dispatch for the `launchpad` binary |
| `bin/launchpad.js` | Shim that runs the CLI through tsx, no build step |
| `src/lib/tx.ts` | Signs, simulates and sends transactions |
| `src/lib/store.ts` | Persists launch records and pending launch keys to `.launch/` |

## Tuning the launch

Everything lives in `.env`, documented key by key in `.env.example`. No other
file needs editing for a launch.

`src/env.ts` parses it once at startup and rejects anything invalid before a
transaction is built, naming the key and listing the valid values:

```
.env is not valid

  TOKEN_AUTHORITY: unknown value "inmutable". Valid: immutable, creator, partner
```

It also checks rules that span several keys — LP percentages totalling 100, at
least 10% locked, a flat fee having no decay window, market caps in the right
order.

Keep several launches side by side with separate files:

```bash
DOTENV_CONFIG_PATH=.env.mainnet npm run preview
```

### The supply buckets

The four buckets are independent allocations, not views of the same tokens.
`leftover: 200M` alongside `lockedVesting: 200M` reserves 400M, not 200M.

`leftover` is the unsold remainder handed **liquid** to the leftover receiver at
migration. It is not a locking mechanism — that is `lockedVesting`.

The program's supply rules have sharp edges. A `leftover` of exactly 0 combined
with a non-zero `migration.migrationFee.feePercentage` is rejected with
`InvalidTokenSupply` (6020), while a leftover of 1 passes; with a zero migration
fee, a zero leftover is fine. Rather than restate rules that are easy to get
wrong, `npm run preview` builds the real `create_config` instruction and
simulates it, then reports the program's own verdict. Trust that over any
formula, including the ones in this file.

### Fee scheduler units

`totalDuration` is in the unit of `activationType`. The profiles use
`ActivationType.Timestamp`, so it is **seconds**. `totalDuration: 5` would
collapse a 20% → 1% decay into five seconds; the mainnet profile spreads it over
an hour.

### The curve shape

`src/curve.ts` calls `buildCurveWithMarketCap`, a single-segment curve derived
from the two market caps. Swap the builder there to reshape it:

| Builder | What it adds |
| --- | --- |
| `buildCurveWithMarketCap` | Nothing. One segment, two numbers. *(current)* |
| `buildCurveWithLiquidityWeights` | A weights array. Lower weight early = price moves faster early. |
| `buildCurveWithTwoSegments` | A supply percentage that splits the curve in two phases. |
| `buildCurveWithCustomSqrtPrices` | Explicit price checkpoints, up to 16. |

### Migration is not automatic

Curve completion is automatic; the migration itself is a separate permissionless
instruction someone must call. Meteora runs keepers on mainnet, but only for
pools raising at least 10 SOL / 750 USDC / 1500 JUP. Below that you migrate
manually via [migrator.meteora.ag](https://migrator.meteora.ag/), which also
supports devnet. `npm run preview` tells you which side of the line you are on.

## Going to mainnet

Keep the devnet `.env` and work from a copy, so a rehearsal can never be
mistaken for the real thing:

```bash
cp .env .env.mainnet
DOTENV_CONFIG_PATH=.env.mainnet npm run preview
```

Then, in that file:

1. **`RPC_URL`** — a mainnet endpoint. The public one is rate limited; Helius or
   QuickNode is worth it here.
2. **Re-upload the icon and the JSON without `-n devnet`.** Devnet ids are
   purged after ~60 days and do not resolve on `arweave.net`. `preview` will
   happily validate a devnet URI, so nothing but this step catches it.
3. **`INITIAL_MARKET_CAP` and `MIGRATION_MARKET_CAP`** — in SOL, not dollars.
   `preview` prints the USD equivalent at the live rate; check it, because these
   two numbers decide whether the launch lands where you intend.
4. **Check keeper eligibility.** Meteora's mainnet keepers only auto-migrate
   pools raising 10+ SOL, 750+ USDC or 1500+ JUP. Below that, a completed pool
   waits until someone migrates it manually. `preview` tells you which side you
   are on.
5. **`TOKEN_AUTHORITY`** — `immutable` is the strongest signal but makes a bad
   `TOKEN_URI` permanent. `creator` keeps a way to fix it.
6. **Fund the partner wallet with real SOL**, and re-fund Irys on mainnet.

Rehearse the whole sequence on devnet first, including the uploads. Every
mistake in this list is cheap on devnet and permanent on mainnet.

## Notes on the SDK

- DBC program id: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (same on devnet
  and mainnet).
- `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.12 marks DAMM v1 migration and the
  rate-limiter fee mode `@deprecated` — new configs cannot use either.
- The SDK peer-depends on `typescript@^5`, which is why this project pins TS 5
  rather than 7.
- Token-2022 with transfer hooks is supported by a parallel set of methods
  (`createConfigWithTransferHook`, `swap2WithTransferHook`, ...). This project
  uses the standard SPL Token path; the hook is revoked at migration anyway.
