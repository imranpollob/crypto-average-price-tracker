# crypto-average-price-tracker

A local-first crypto portfolio tracker for lot-aware average cost, current value, and realized/unrealized P&L. Kraken first, with additional exchanges and wallets planned.

> **Status: Phase 2.1 is complete (Kraken REST, hardened).** The app connects to Kraken with a verified read-only API key and imports the full trade and ledger history, including Instant Buy/Sell/Convert. It checks the result against Kraken's balances and shows a non-secret diagnostics report. The portfolio dashboard (lots, P/L) arrives in Phases 3–5.

---

## What it does

Exchanges usually report one blended "average price" per asset. That number hides what actually happened. When you sell, which purchase did you sell? How much profit is already realized, and how much is only on paper?

This app tracks every purchase as its own **lot**. When a sale happens, **you** decide which lot or lots it closed. From that it derives, for each asset:

| Metric | Definition |
|---|---|
| Current Price | Latest market price, in your reporting currency (market data only, never accounting truth) |
| Holdings | Quantity held, from transaction history |
| Current Value | Current Price × Holdings |
| Cost Basis | Sum of the remaining cost of the open lots |
| Average Cost | Cost Basis ÷ open quantity (N/A at zero holdings) |
| Realized P/L | Σ (net sale proceeds − allocated acquisition cost) |
| Unrealized P/L | Current Value − Cost Basis |
| Unrealized P/L % | Unrealized P/L ÷ Cost Basis × 100 (N/A when the basis is 0) |
| Total P/L | Realized + Unrealized |

### Why lots matter: an example

```
Buy 100 @ $20      Buy 100 @ $10      Sell 100 @ $13 (closes the $10 lot)      Price now: $13

Holdings 100 · Average cost $20 · Cost basis $2,000
Realized +$300 · Unrealized −$700 · Total −$400
```

If the same sale had closed the $20 lot instead, realized would be −$700 and unrealized +$300. **The total is −$400 either way.** Lot choice moves P/L between realized and unrealized, but it never changes the economic total. The test suite enforces this with exact equality over hundreds of randomized histories.

## Principles

1. Raw transactions are the source data. Averages and P/L are derived values.
2. Provider history is never changed to make the numbers match.
3. Lots are the only source of cost basis. There is no single global average price.
4. REST provides correctness. WebSocket provides freshness.
5. Every import is idempotent.
6. Missing financial information is never guessed. There is no silent FIFO, no invented deposit cost, and no inferred FX rate.
7. Uncertainty is shown explicitly. A value is either `known`, `not_applicable`, or `incomplete` with a list of reasons.
8. Exchange-specific code stays inside provider adapters.
9. The engine works the same whatever the source: Kraken, Coinbase, or a wallet.
10. Correctness comes before UI polish.

## Architecture

```
External sources         Kraken (REST) · Coinbase, Binance, wallets (future)
        │
        ▼
Provider adapters        src/providers/<name>/         implement PortfolioProvider
        │                                              (provider formats stop here)
        ▼
Normalized records       src/domain/transactions/      NormalizedTrade / Transfer / LedgerEntry / Balance / PriceQuote
        │
        ▼
Asset flows              src/domain/lots/flows.ts      trades/transfers → per-asset acquisitions & disposals
        │                                              (fees, crypto/crypto legs, unknown valuations)
        ▼
Lot engine               src/domain/lots/engine.ts     lots + user match decisions → allocations, issues
        │
        ▼
Metrics                  src/domain/pnl, portfolio,    position metrics, portfolio totals,
                         reconciliation                balance reconciliation
        │
        ▼
UI                       src/app/                      connection + sync status (full dashboard: Phase 5)
```

```
src/
  domain/              Pure business logic. No I/O, no Prisma, no provider formats.
    decimal.ts           decimal-safe arithmetic (Decimal.js, 100 significant digits)
    metric.ts            known / not_applicable / incomplete(reasons)
    accounting/          reporting currency, cash assets
    transactions/        normalized models, identity keys, dedupe, validation
    lots/                asset flows, lot engine, matching helpers
    pnl/                 position metrics, economic total P/L
    portfolio/           portfolio-wide totals
    reconciliation/      calculated vs. provider balances
    market/              price selection
    sync/                sync window planning, sync status rules
  providers/           PortfolioProvider / MarketDataProvider / LiveFeed interfaces, registry,
                       in-memory test provider
    kraken/              the only place Kraken formats exist: auth (signing, nonces), client
                         (throttling, retries), rest (pagination), mapper (asset/pair names),
                         normalizer, provider; testing/ holds a fake Kraken API for tests
  application/sync/    provider-agnostic SyncService + SyncStore port
  server/db/           Prisma client, codecs, SQLite SyncStore, history repository
  server/credentials/  AES-256-GCM credential encryption
  server/app/          provider-agnostic account service used by the UI
  app/                 Next.js app
prisma/                schema and migrations
docs/                  verified external API notes (kraken-api-notes.md)
```

To add an exchange or wallet, write an adapter that implements `PortfolioProvider` (in [src/providers/types.ts](src/providers/types.ts)) and register it. The engine, database and UI do not change.

### Database

SQLite through Prisma 7 with the better-sqlite3 driver adapter. The main tables:

`providers`, `provider_accounts`, `trades`, `transfers`, `ledger_entries`, `balance_snapshots`, `reconciliation_results`, `lots`, `lot_matches`, `manual_valuations`, `price_cache`, `sync_runs`.

- **Every amount is stored as TEXT** in canonical decimal form. SQLite's REAL and NUMERIC types keep only about 15 significant digits, which would silently corrupt crypto amounts.
- Every imported row keeps the untouched provider payload in `raw_json`, so history can be reprocessed if parsing changes.
- Imports are idempotent through `(provider_account_id, external_*_id)` unique keys.
- `lots` is a projection rebuilt deterministically from history plus user decisions. Lot IDs are stable keys such as `trade:<account>:<txid>:base`, so the user's matches survive rebuilds.
- `last_successful_sync_at` is advanced only inside the same transaction that commits the synced data and its balance reconciliation.

## How the calculations work

- **Fees.** For a buy, cost = gross value + buy fee. For a sale, net proceeds = gross value − sell fee. A fee charged in the base asset changes the quantity received or sent instead. A fee charged in any other asset makes the value *unknown*; it is never ignored.
- **Partial closes.** Cost, buy fee, proceeds and sell fee are allocated in proportion to the quantity closed, based on what remains. The final close takes the exact remainder. Division results are rounded to 36 decimal places, and all other operations are exact, so `allocated + remaining == original` holds with strict equality.
- **Unmatched sales.** Realized P/L, cost basis, average cost and unrealized P/L show as *pending*. Holdings and current value stay known. **Total P/L** also stays known, because it does not depend on which lots were closed — but only if every acquisition cost, sale proceeds and fee is known and the history is complete. An unvalued fee, missing history, unsupported activity, an unresolved withdrawal or an unresolved balance mismatch makes it *incomplete* too, with the reason shown.
- **Deposits** are not buys. They become lots with an *unknown* cost basis until you enter one. The market price at deposit time is never used as a cost.
- **Withdrawals** are not sales. They produce no realized P/L and are flagged for review until you say which lots left the account. The cost basis of those lots leaves with them.
- **Other currencies.** Only values in your reporting currency (default USD) count as known. A lot bought in EUR, or bought with BTC, has an unknown cost until you value it manually. No FX rate is guessed. A crypto/crypto trade affects both assets: buying ETH with BTC also disposes of BTC.
- **Reconciliation** compares calculated holdings with the balances the exchange reports and shows the signed difference. History is never adjusted to make them match. An unresolved mismatch marks that asset's figures as incomplete.

## Local setup

Requirements: Node.js 22.12 or newer.

```bash
npm install
cp .env.example .env          # DATABASE_URL="file:./data/portfolio.db"
npx prisma migrate deploy     # create the local SQLite database
npx prisma generate           # generate the Prisma client (src/generated/prisma)
npm test                      # run the test suite (no network, no Kraken account needed)
npm run dev                   # http://localhost:3000
```

Then open the app, paste a read-only Kraken API key and private key, and press **Test connection and save**. After that, **Sync now** imports your history. The first sync of a large account can take several minutes, because the app stays within Kraken's rate limits.

Other scripts: `npm run typecheck`, `npm run build`.

## Kraken API permissions

Create an API key in Kraken (Settings → API) with **query permissions only**:

- ✅ Funds → Query Funds
- ✅ Orders & Trades → Query Closed Orders & Trades
- ✅ Data → Query Ledger Entries
- ➖ Optional: WebSocket → Access WebSockets API (used in a later version)
- ❌ Deposit Funds, Withdraw Funds, Earn, adding/updating withdrawal addresses
- ❌ Create & Modify Orders, Cancel/Close Orders

This application only needs read-only access.

- The app checks the key's permissions with Kraken's `GetApiKeyInfo`.
- **Keys with trading, funding, Earn or withdrawal-address permissions are refused** and never saved. The message says which permissions to remove.
- Unneeded read-only permissions (Query Open Orders & Trades, Export Data) are accepted with a note.

Also:

- **API-key 2FA is not supported in this version.** Create a dedicated read-only API key without API-key 2FA.
- Do not share the key with another app. Two apps using one key can cause nonce errors.

See [docs/kraken-api-notes.md](docs/kraken-api-notes.md) for the verified API behaviour.

## Security

This app handles financial data and exchange credentials.

- It runs locally. There is no cloud service, no account and no telemetry. Your data stays in `./data/`, which is git-ignored.
- Credentials are encrypted at rest with AES-256-GCM.
  - The key comes from `APP_ENCRYPTION_KEY` (base64 of 32 random bytes), or else from `./data/master.key`, which is created on first use.
  - Credentials never reach the browser. They are only ever sent to Kraken's own API, and only as a signature: the private key itself is never transmitted.
  - They are validated with Kraken before being saved.
  - Server-only modules are guarded, so they cannot be bundled into browser code.
  - Keep `data/` private. The key file protects copies of the database, but not someone who can read both files.
- Error messages are redacted before they are stored or logged.
- Provider responses are validated. Malformed data fails the sync instead of being stored.

> ⚠️ **Warning:** This is an MVP and has not had a security review. Use read-only keys only. Anyone with access to your user account on this machine can read the local database.

## Development status

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: domain models, provider abstraction, decimal math, lot engine, P/L engine, schema, sync orchestration, tests | ✅ Done |
| 2 | Kraken REST adapter, credentials, historical import, ledger, balances, reconciliation | ✅ Done |
| 3 | Lot workflow: persistence of lots and matches, manual matching, minimal lot-review screen (`/lots`) | ✅ Done |
| 4 | Portfolio metrics with current Kraken REST prices (cached, refreshed ~every 30–60 s); provisional FIFO for unassigned quantity | ✅ Done (MVP) |
| 5 | UI: portfolio dashboard (`/`), asset detail (`/assets/[asset]`), lots & matching (`/lots`), settings (`/settings`) | ✅ Done (MVP) |
| 6 | Reliable sync: startup recovery, Sync Now (single-flight), offline handling with cached data; account data re-syncs only at startup and on demand | ✅ Done (MVP) |
| 7 | Kraken WebSocket: live trades and prices, reconnect then REST reconciliation | Planned |

## MVP limitations

- Kraken is the only planned exchange for V1. Coinbase, other exchanges and on-chain wallets are designed for but not built.
- Spot trading only. No margin, futures or advanced staking accounting.
  - Rewards are imported as unknown-cost acquisitions.
  - Margin trades are skipped, and their ledger lines are flagged for review.
- Kraken Instant Buy / Sell / Convert: they appear only as ledger `spend` / `receive` lines.
  - They become trades **only** when the two lines are linked unambiguously by Kraken's refid.
  - Anything ambiguous stays flagged for review.
  - A spread embedded in Kraken's price is not separated from the cost.
- Kraken fee credits (KFEE) are not portfolio assets. A fee paid with KFEE costs nothing in P/L, because no asset or cash left the portfolio, and the usage is kept on the trade.
- Rate limits: V1 always assumes Kraken's slowest tier (Starter). A large first sync can take several minutes.
- One account per provider.
- There are no automatic lot-selection methods (FIFO, LIFO, HIFO). Every sale is matched manually.
- No FX conversion. Amounts in a non-reporting currency must be valued manually.
- A lot can only be closed by a disposal on the same account. Matching transfers between accounts or wallets is future work.
- Not tax software. It produces no tax reports or forms.
