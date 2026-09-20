# crypto-average-price-tracker

A local-first crypto portfolio tracker that works out average cost, current value, and realized/unrealized P/L from individual purchase lots. Kraken first; other exchanges and wallets are planned.

## Why lots

Exchanges show one blended "average price" per asset. That hides which purchase a sale actually closed, and how much profit is real versus on paper.

This app tracks every purchase as its own **lot**. Sales are matched to lots either automatically (FIFO, LIFO or HIFO) or by you, manually. Per asset it shows:

| Metric | Definition |
|---|---|
| Current Value | Current price × holdings |
| Cost Basis | Remaining cost of open lots |
| Average Cost | Cost basis ÷ open quantity |
| Realized P/L | Net sale proceeds − allocated acquisition cost |
| Unrealized P/L | Current value − cost basis |
| Total P/L | Realized + unrealized |

Example:

```
Buy 100 @ $20    Buy 100 @ $10    Sell 100 @ $13 (closes the $10 lot)    Price now: $13

Holdings 100 · Average cost $20 · Cost basis $2,000
Realized +$300 · Unrealized −$700 · Total −$400
```

Had the sale closed the $20 lot, realized would be −$700 and unrealized +$300. The total stays −$400. Lot choice moves P/L between realized and unrealized but never changes the total.

## Principles

- Raw transactions are the source of truth. Averages and P/L are derived, and history is never edited to make numbers match.
- Missing information is never guessed: no invented deposit cost, no inferred FX rate. A value is `known`, `not_applicable`, or `incomplete` with reasons.
- Imports are idempotent. Amounts are stored as exact decimal text, never floats.
- Exchange-specific code stays inside provider adapters.

## Setup

Requires Node.js 22.12+.

```bash
npm install
cp .env.example .env          # DATABASE_URL="file:./data/portfolio.db"
npx prisma migrate deploy
npx prisma generate
npm test                      # no network or Kraken account needed
npm run dev                   # http://localhost:3000
```

After pulling updates, re-run `prisma migrate deploy` and `prisma generate`. Migrations never alter imported history.

Open the app, paste a read-only Kraken API key, and press **Test connection and save**, then **Sync now**. A large first sync can take several minutes because of Kraken's rate limits.

Other scripts: `npm run typecheck`, `npm run build`.

## Kraken API key

Create a key (Settings → API) with **query permissions only**:

- ✅ Query Funds
- ✅ Query Closed Orders & Trades
- ✅ Query Ledger Entries
- ❌ Anything that trades, deposits, withdraws, or uses Earn

Keys with trading, funding, Earn or withdrawal-address permissions are refused and never saved. Keys with API-key 2FA aren't supported, and the key shouldn't be shared with another app (nonce errors). Details: [docs/kraken-api-notes.md](docs/kraken-api-notes.md).

## Security

Everything runs locally: no cloud, accounts or telemetry. Data lives in `./data/` (git-ignored).

- Credentials are encrypted at rest with AES-256-GCM, using `APP_ENCRYPTION_KEY` or an auto-created `./data/master.key`.
- They never reach the browser and are only used to sign requests to Kraken.
- Errors are redacted before storing or logging, and malformed provider data fails the sync instead of being stored.

This is an MVP without a security review. Use read-only keys, and note that anyone with access to your user account on this machine can read the database.

## How the numbers work

- **Fees:** Buy cost = value + fee; sale proceeds = value − fee. A fee in the base asset adjusts quantity. A fee in another asset makes the value unknown rather than being ignored.
- **Partial closes:** Costs and proceeds are allocated proportionally, and the final close takes the exact remainder, so nothing is lost to rounding.
- **Automatic matching:** Unassigned sales and withdrawals use the method chosen in Settings (FIFO default, LIFO, HIFO). Manual matches always override it. Changing the method recalculates immediately and never alters saved matches. HIFO can't rank a lot with unknown cost (e.g. a staking reward), so affected figures stay incomplete until it's valued.
- **Deposits** become lots with unknown cost until you enter one. Market price at deposit time is never used.
- **Withdrawals** aren't sales: no realized P/L, and the cost basis leaves with the lots.
- **Other currencies:** Only reporting-currency values (default USD) count as known. EUR or crypto-paid lots need manual valuation. A crypto/crypto trade affects both assets.
- **Reconciliation:** Calculated holdings are compared with Kraken's balances. Unresolved mismatches mark that asset's figures incomplete.

## Architecture

```
Provider adapters   src/providers/<name>/       exchange formats stop here
Normalized records  src/domain/transactions/
Asset flows         src/domain/lots/flows.ts    acquisitions and disposals per asset
Lot engine          src/domain/lots/            lots + matches → allocations
Metrics             src/domain/pnl, portfolio, reconciliation
UI                  src/app/                    Next.js
```

Other pieces: `src/application/sync/` (provider-agnostic sync), `src/server/` (SQLite via Prisma, credential encryption, app services), `prisma/` (schema and migrations). `src/domain/` is pure logic with no I/O.

To add an exchange, implement `PortfolioProvider` ([src/providers/types.ts](src/providers/types.ts)) and register it. The engine, database and UI stay unchanged.

## Status

Phases 1–6 are done (MVP): domain and lot engine, Kraken REST import, lot matching, portfolio metrics with cached prices, dashboard, asset detail, lots and settings pages, and reliable sync. Planned next: Kraken WebSocket for live trades and prices.

## Limitations

- Kraken only, one account per provider. Other exchanges and wallets are designed for but not built.
- Spot trading only. Margin trades are skipped and flagged. Staking rewards are imported as unknown-cost acquisitions.
- Instant Buy/Sell/Convert become trades only when Kraken's `refid` links the two ledger lines unambiguously; otherwise they're flagged. Embedded spread isn't separated from cost.
- Kraken fee credits (KFEE) aren't portfolio assets and cost nothing in P/L.
- Rate limits assume Kraken's slowest tier.
- No FX conversion. A lot can only be closed by a disposal on the same account.
- Not tax software. No tax reports or forms.
