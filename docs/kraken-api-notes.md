# Kraken Spot REST API — verified notes

These notes record the API behaviour the Kraken adapter (`src/providers/kraken/`) relies on. They were checked against the official documentation on **2026-09-24**, including the Phase 2.1 additions (GetApiKeyInfo, spend/receive, KFEE). When Kraken changes something, update this file and the matching fixture tests together.

Sources (official only):
[Auth](https://docs.kraken.com/api/docs/guides/spot-rest-auth) ·
[TradesHistory](https://docs.kraken.com/api/docs/rest-api/get-trade-history) ·
[Ledgers](https://docs.kraken.com/api/docs/rest-api/get-ledgers-info) ·
[QueryLedgers](https://docs.kraken.com/api/docs/rest-api/get-ledgers) ·
[Balance](https://docs.kraken.com/api/docs/rest-api/get-account-balance) ·
[Assets](https://docs.kraken.com/api/docs/rest-api/get-asset-info) ·
[AssetPairs](https://docs.kraken.com/api/docs/rest-api/get-tradable-asset-pairs) ·
[Rate limits](https://docs.kraken.com/api/docs/guides/spot-rest-ratelimits) ·
[Errors](https://docs.kraken.com/api/docs/guides/spot-errors) ·
[API key permissions](https://docs.kraken.com/exchange/guides/rest/api-keys) ·
[GetWebSocketsToken](https://docs.kraken.com/api/docs/rest-api/get-websockets-token) ·
[GetApiKeyInfo](https://docs.kraken.com/api-reference/account-data/get-api-key-info) ·
[Ledger fields (support)](https://support.kraken.com/hc/en-us/articles/360001169383-How-to-interpret-Ledger-history-fields) ·
[Ledger vs trades history (support)](https://support.kraken.com/articles/115000302707-differences-between-ledger-and-trades-history) ·
[Kraken fee credits (support)](https://support.kraken.com/articles/204799657-kraken-fee-credits-kfee-)

## Transport and authentication

| Item | Verified behaviour |
|---|---|
| Base URL | `https://api.kraken.com`. Public calls are `GET /0/public/<Method>`, private calls are `POST /0/private/<Method>`. |
| Headers | `API-Key` carries the public key. `API-Sign` carries the signature. The secret itself is never sent. |
| Body | Form-encoded (`application/x-www-form-urlencoded`). A JSON body is also accepted; either way the signature is computed over the exact bytes sent. **The adapter uses form encoding.** |
| Nonce | "Always increasing, unsigned 64-bit integer", tracked per API key. A nonce ≤ the last accepted one gives `EAPI:Invalid nonce`. The docs suggest a millisecond UNIX timestamp; the adapter uses `max(ms × 1000, last + 1)`, which keeps increasing across restarts. |
| Signature | `base64( HMAC-SHA512( key = base64decode(secret), msg = uriPath + SHA256(nonce + postData) ) )`, where `uriPath` starts at `/0/private/`. |
| Test vector | Secret `kQH5HW/8p1uG…6F1huXg==`, nonce `1616492376594`, path `/0/private/AddOrder`, body `nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25`, expected `4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==`. This is enforced by a unit test. |
| 2FA | Optional `otp` field, required only if 2FA is enabled on the API key. **Not supported in V1**: use a key without API-key 2FA. Kraken documents no error string specific to a missing OTP, so the adapter (a) maps any error mentioning OTP/2FA to `unsupported_authentication` with the message "API-key 2FA is not supported in this version. Create a dedicated read-only API key without API-key 2FA.", and (b) appends that hint to invalid-key/signature errors and to a denied `GetApiKeyInfo` (which needs no permission). |
| Envelope | Every response is `{ "error": string[], "result": … }`. A non-empty `error` array means the call failed. |

## Endpoints used (all read-only)

### `POST /0/private/GetApiKeyInfo` — no permission required

Used for connection validation. The response has `apiKeyName`, `apiKey`, `nonce`, `nonceWindow`, `permissions` (array), `iban`, `validUntil`, `queryFrom`, `queryTo`, `createdTime`, `modifiedTime`, `ipAllowlist` and `lastUsed`. Timestamps are unix-second strings, and "0" means "not set".

Documented permission strings: `query-funds`, `add-funds`, `withdraw-funds`, `earn-funds`, `query-open-trades`, `query-closed-trades`, `modify-trades`, `close-trades`, `query-ledger`, `export-data`, `create-ws-token`, `add-withdraw-address`, `update-withdraw-address`.

The adapter reads **only** `permissions`, `queryFrom`, `queryTo` and `validUntil`. The echoed `apiKey` and the account `iban` are never kept, stored or displayed.

Policy ([permissions.ts](../src/providers/kraken/permissions.ts)):

| Class | Permissions | Result |
|---|---|---|
| Required (the endpoints we call) | `query-funds` (Balance), `query-closed-trades` (TradesHistory), `query-ledger` (Ledgers) | missing → refused, naming each one |
| Optional | `create-ws-token` (authenticated WebSocket, Phase 7) | accepted silently |
| Unnecessary read-only | `query-open-trades`, `export-data` | accepted, with an informational warning |
| Dangerous (can change the account) | `add-funds`, `withdraw-funds`, `earn-funds`, `modify-trades`, `close-trades`, `add-withdraw-address`, `update-withdraw-address` | **refused, not saved**; the message lists what to remove |
| Unrecognized | anything not listed above | refused, because its effect is unknown |

Other checks:

- `queryFrom` / `queryTo` set: warning. History outside the range would be missing.
- `validUntil` set: warning with the expiry date.
- The connection test runs at the start of every sync, so a key that later gains dangerous permissions stops syncing.
- If `GetApiKeyInfo` is unavailable (unknown method or rejected arguments), the adapter falls back to probing Balance, TradesHistory and Ledgers. It then warns that dangerous permissions could not be ruled out.

`add-funds` counts as dangerous because the deposit endpoints can generate new deposit addresses, which changes the account.

### `POST /0/private/Balance` — permission *Query Funds*

Returns `{ "<asset>": "<decimal string>" }`, for example `XXBT`, `ZUSD`, `ETH2.S`, `USD.M`. Suffixes: `.S` / `.M` are staked or opt-in rewards (legacy), `.B` is yield-bearing, `.F` is auto-earning, `.T` is a tokenized asset.

### `POST /0/private/TradesHistory` — permission *Query Closed Orders & Trades*

The endpoint reference names *Query closed orders & trades*. The permissions overview also lists TradesHistory under *Query Open Orders & Trades*, but that is **not required**; the real-account validation will confirm it.

- Parameters used: `type=all`, `start`, `end`, `ofs`, `consolidate_taker=false`, `limit=100`.
  - `start` is **exclusive**; `end` is **inclusive**. Both accept a UNIX timestamp or a trade txid.
  - `consolidate_taker` **defaults to true**, which merges taker fills. We send `false` so every individual execution is kept.
  - `limit` accepts 1–100 (default 50). Larger values are clamped.
- Results come newest first, and `count` is the total number of matches.
- Each trade, keyed by txid, has: `ordertxid`, `postxid`, `pair`, `time` (**JSON number**, seconds with 4 decimals), `type` (buy/sell), `ordertype`, `price`, `cost`, `fee`, `vol`, `margin` (all decimal **strings**), `misc`, `ledgers`, `trade_id` (integer), `maker`, `aclass`. Margin positions also carry `posstatus` and `c*` fields.
- `fee` is documented as "Total fee (**quote currency**)". The asset the fee was actually charged in is only visible in the ledger (see below).

### `POST /0/private/Ledgers` — permission *Query Ledger Entries*

- Parameters used: `start` (exclusive), `end` (inclusive), `ofs`. There are 50 results per page, newest first, plus a `count`. No `limit` parameter is documented for this endpoint.
- Each entry, keyed by ledger id, has: `refid`, `time` (JSON number), `type`, `subtype`, `aclass`, `asset`, `amount` (signed string), `fee` (string), `balance` (string).
- Documented `type` values: none, trade, deposit, withdrawal, transfer, margin, adjustment, rollover, spend, receive, settled, credit, staking, reward, dividend, sale, conversion, nfttrade, nftcreatorfee, nftrebate, custodytransfer.
- In the official example, a `trade` ledger entry has `refid` = a trade txid (`T…`) and the fee sits on the quote-asset line.
- Balance effect of one line: `balance = previous + amount − fee`.

### `GET /0/public/Assets` and `GET /0/public/AssetPairs` — no key needed

- `Assets` maps each Kraken asset id to its `altname`, for example `XXBT` → `XBT` and `ZUSD` → `USD`.
- `AssetPairs` maps each pair key to `base` / `quote` asset ids, for example `XXBTZUSD` → (`XXBT`, `ZUSD`) and `XETHXXBT` → (`XETH`, `XXBT`). It also gives `altname` and `wsname`.
- Only currently listed pairs are returned. A pair missing from the live response (delisted, or a historical trade whose pair predates its current listing) is resolved deterministically, in order:
  1. an unambiguous split into two currently-known asset ids (`uniqueSplit`);
  2. a split on the **longest known quote-asset suffix** (`quoteSuffixSplit`) — the base need not itself be a known asset id, e.g. historical pair `AAPLZUSD` → base `AAPL`, quote `ZUSD` → `USD`, even though `AAPL` never appears in `Assets`.
  - Both are marked `mappingSource: "historical_fallback"` on the resolved pair (vs. `"asset_pairs"` for a live listing), which is recorded in the trade's `rawData.pairMappingSource`.
  - If neither succeeds, the pair is genuinely unparseable or ambiguous: that one trade is excluded and recorded in `skipped` as `{ reason: "unsupported_pair", pair, row }` (the raw row is preserved), and the rest of the account's history still syncs — one bad historical market never aborts the whole sync.

## Pagination strategy

1. The sync chooses a fixed window end, `until`, before fetching anything, and sends `end = floor(until)`. Records between `floor(until)` and `until` are picked up by the next sync's 5-minute overlap.
2. `start = floor(since) − 1`, because Kraken's `start` is exclusive and we want it inclusive.
3. Pages are requested with `ofs = 0, n, 2n, …` until the number of unique ids collected reaches the latest reported `count`.
   - Results are deduplicated by txid / ledger id, so if a late record shifts the offsets and causes an overlap between pages, nothing is counted twice.
   - An empty page that arrives before `count` is reached is an error: the history would be incomplete.
   - A hard page cap guards against runaway loops.
4. Any error on any page fails the whole sync. Nothing is written, and `last_successful_sync_at` is left unchanged.

A 5-minute overlap is enough. Kraken timestamps are exact, and the only boundary effects are the sub-second `end` truncation and late-appearing rows, both well within 5 minutes.

## Instant Buy / Sell / Convert (ledger `spend` + `receive`)

Kraken support documents two ledger types:

- `spend`: "shown for transactions made via the Buy Crypto button or new Kraken app, this indicates the amount of the asset being debited".
- `receive`: the asset being credited.

These transactions are **not** in TradesHistory. The two lines of one transaction share a `refid`.

A trade is synthesized ([normalizer.ts](../src/providers/kraken/normalizer.ts) `linkInstantTrades`) **only** when all of the following hold:

- the refid group has exactly one `spend` line and exactly one `receive` line, and no other lines;
- spend amount < 0, receive amount > 0, and the two canonical assets differ;
- neither asset is a fee credit;
- at most one of the two lines carries a fee.

Lines are **never** paired by timestamp, amount or asset plausibility. A group that fails any rule stays as ledger entries of type `other`, flagged for review (unsupported activity).

A pair can straddle the sync window. For each lone line, one targeted Ledgers query covers ±60 s around it, and a counterpart is accepted only if it has the same refid. This is capped at 25 lookups per sync.

Normalization:

- Orientation: if the received asset is fiat, it is a **SELL** of the spent asset; otherwise a **BUY** of the received asset. Crypto→crypto converts are BUYs quoted in the spent asset, and their USD values stay unknown.
- BUY: `quantity = receive amount`, `grossValue = |spend amount|`. SELL: `quantity = |spend amount|`, `grossValue = receive amount`.
- Fees follow Kraken's convention: balance change = amount − fee, so the fee is **not** included in the amount.
  - A spend-line fee is a fee in the spent asset. On a buy, cost = |amount| + fee.
  - A receive-line fee is a fee in the received asset. On a buy, it reduces the quantity kept.
  - The fee is therefore never counted twice. Tests check that the lot cost equals the actual USD balance decrease.
- An effective price `grossValue / quantity` is stored, rounded to 36 decimal places, for display only. Cost uses the exact amounts.
- Any spread embedded in Kraken's quote is part of the amounts. It is not reverse-engineered.
- Id: `ledger:<spendLedgerId>+<receiveLedgerId>`, which is deterministic and built from Kraken's own ids. No Kraken trade id is invented.
- `externalOrderId` = refid, `origin = "ledger"`. Both ledger lines are kept as raw data and classified as `trade`, so they are never also counted as transfers.

## KFEE (Kraken fee credits)

Kraken support describes KFEE as internal tokens used only to pay trading fees: 1,000 KFEE = 10 USD of fees, used automatically, and they cannot be traded or withdrawn. The asset id is `KFEE` and the altname is `FEE`; both map to canonical **KFEE**. The Kraken provider definition declares it as a fee-credit asset.

Exact behaviour:

- **Not a portfolio asset.** No lots, no holdings value, no price, and no reconciliation row. It is excluded by the domain's generic `feeCreditAssets` configuration.
- **KFEE balances and credit / deposit lines** are imported and kept as source data. Diagnostics list the KFEE balance under *excluded balances*.
- **Trade-fee evidence** comes from the ledger lines whose `refid` is the trade id, of any type:
  - A **KFEE line** with a negative amount and/or a fee means the fee was paid with credits.
  - **Only KFEE:** the trade's fee is the credit amount in KFEE, with `feeSource = "fee_credit"`. The domain values a fee-credit fee at **0**, because no portfolio asset or cash left, and records the usage as `feeCredit` on the flow. Cost basis and proceeds therefore reflect only what actually left the portfolio.
  - **KFEE plus a real-asset fee:** the real fee is used, and the credit usage is recorded in `rawData.feeCreditUsed`.
  - **Both legs present but no fee anywhere:** fee 0, with `feeSource = "ledger_uncharged"` and the reported fee kept in `rawData.reportedFeeNotCharged`, so it shows up in diagnostics.
  - **No usable ledger lines:** the TradesHistory quote-currency fee is used, with `feeSource = "trade_record"`.
- **Unconfirmed:** the exact ledger representation of KFEE usage (a negative KFEE amount vs. a fee on a KFEE line) is not documented. Both forms are handled and tested, and the real-account validation will confirm which one Kraken uses.

## Rate limits

Private REST uses a per-key "call counter".

- Ledger and trade-history calls cost **2**; other calls cost 1.
- Limits by verification tier: Starter max 15, decaying 0.33/s · Intermediate max 20, 0.5/s · Pro max 20, 1/s.
- Exceeding the limit returns `EAPI:Rate limit exceeded`. `EService:Throttled:<ts>` means too many concurrent requests; retry after `<ts>`.
- The adapter throttles on its own side by modelling the counter, and backs off and retries on rate-limit or unavailable errors.
- V1 always uses the Starter tier. There is deliberately no user setting.
- The client depends only on a `RateLimitPolicy` interface, and per-endpoint costs live in one table (`KRAKEN_CALL_COST`). Another tier or an adaptive policy can be plugged in without changing the client or the sync logic.
- Rough cost: 10,000 trades is 100 pages × 2 points. At Starter decay that sustains about one page every 6 s, so roughly 10 minutes.

## Errors → normalized categories

| Kraken error | Category | Retried |
|---|---|---|
| `EAPI:Invalid key`, `EAPI:Invalid signature` | `invalid_credentials` | no |
| `EAuth:Account temporary disabled`, `EAuth:Account unconfirmed` | `invalid_credentials` | no |
| `EGeneral:Permission denied`, `EAccount:Invalid permissions` | `insufficient_permissions` | no |
| `EAPI:Rate limit exceeded`, `EAuth:Rate limit exceeded`, `EAuth:Too many requests`, `EService:Throttled…` | `rate_limited` | yes, with backoff |
| `EGeneral:Temporary lockout` | `rate_limited` | **no** (retrying would extend the lockout) |
| `EService:Unavailable`, `EService:Busy`, `EService:Deadline elapsed`, `EGeneral:Internal error` | `provider_unavailable` | yes |
| `EAPI:Invalid nonce` | `invalid_request` | once, with a fresh nonce |
| `EGeneral:Invalid arguments…` | `invalid_request` | no |
| network error / timeout / non-JSON / HTTP 5xx | `network` / `provider_unavailable` | yes |

Error messages include only Kraken's fixed error codes, never request bodies, headers or signatures.

## Read-only API key

Enable only these:

- **Funds → Query Funds**
- **Orders & Trades → Query Closed Orders & Trades**
- **Data → Query Ledger Entries**
- *Optional:* WebSocket → Access WebSockets API (used from Phase 7)

The app verifies the key's permissions with `GetApiKeyInfo` and refuses keys that can deposit, withdraw, allocate Earn, trade, cancel orders, or change withdrawal addresses. See the policy table above.

## Asset naming → canonical codes

- Kraken asset ids come from `Assets` (`altname`), with a small static table as fallback: `XXBT`/`XBT` → BTC, `XXDG`/`XDG` → DOGE, `XETH` → ETH, `ZUSD` → USD, `ZEUR` → EUR, and so on.
- Assets named plainly (`ADA`, `DOT`, `USDT`, `USDC`) map to themselves. There is no prefix stripping, because `XTZ` is Tezos, not "X"+"TZ".
- Balance-bucket suffixes `.S`, `.M`, `.B`, `.F` are the same economic asset held in a staking or earn product, so `ADA.S` → ADA. Legacy `ETH2` / `ETH2.S` → ETH.
- `.T` (tokenized assets) is **not** stripped.
- xStocks (Kraken's tokenized equities/ETFs, e.g. Apple as `AAPLx`) are Kraken's only stock-like product — it has never offered traditional equity trading. The live ticker's trailing `x` is uppercased by the API (`AAPLX`). A small explicit table (`XSTOCK_LEGACY_BASE_IDS`, confirmed against https://www.kraken.com/xstocks) maps a historical bare ticker (e.g. `AAPL`, as seen in an old pair like `AAPLZUSD`) to its current `X`-suffixed canonical code. Nothing is inferred for stock-like tickers outside that table — no blanket "append X" rule.
- Provider balances are summed per canonical asset, and the components are kept in `raw_json`.

## Ledger → normalized activity

| Kraken ledger | Normalized |
|---|---|
| `trade` | Ledger entry only. The trade comes from TradesHistory, so it is not counted twice. The ledger line supplies the **actual fee asset and amount**, including KFEE usage. |
| `spend` / `receive`, deterministically linked by refid | A synthesized trade (see above); the lines are classified as `trade`. |
| `deposit` | Incoming transfer, kind deposit, with unknown cost basis. |
| `withdrawal` | Outgoing transfer, kind withdrawal. Never treated as a sale. |
| `transfer` with subtype `spottostaking`, `stakingfromspot`, `spotfromstaking`, `stakingtospot` | Internal move between buckets of the same asset. Not a transfer. |
| `transfer` (any other subtype) | Transfer in or out, depending on the sign. Needs review. |
| `staking`, `reward`, `dividend` (positive amount) | Incoming transfer, kind reward, with unknown cost basis. |
| `earn` with subtype `allocation` / `deallocation` / `migration` / `autoallocation` | Internal move. |
| `earn` with subtype `reward` | Reward. |
| `adjustment`, `credit` | Adjustment in or out, depending on the sign. |
| everything else (margin, rollover, unlinked spend/receive, settled, sale, conversion, nft\*, custodytransfer, none, unknown) | Ledger entry with type `other`: **unsupported activity, review required.** No transfer is invented from it. |

`earn` is not in the documented enum, but it appears in real ledgers. Unknown `earn` subtypes still fall through to `other`.

## Timestamps and numbers

- `time` is a JSON **number** such as `1688464484.1787`. The adapter parses the response with a lossless reviver (`JSON.parse` source-text access, Node ≥ 21), so every number reaches us as its exact source text.
- Times are converted to milliseconds with Decimal arithmetic. The exact 0.1 ms value is kept in `raw_json`.
- Every amount is parsed from its decimal string with the strict `dec()` parser. JavaScript floats are never used.

## Open points that need a live account

- **Fill IDs vs. ledger refids.** It is unconfirmed whether ledger `refid`s point to the *unconsolidated* fill txids we request with `consolidate_taker=false`. When no ledger line matches a trade, the adapter falls back to TradesHistory's quote-currency `fee`. If the fee was really charged in the base asset, reconciliation will show the difference.
- **Instant buys** are now linked (see above). The real account will show whether every spend/receive pair meets the deterministic rules.
- **KFEE usage** in the ledger: see the KFEE section.
- **Whether TradesHistory works without *Query Open Orders & Trades*.**

## WebSocket (for Phase 7, not implemented)

- Private WebSocket needs a token from `POST /0/private/GetWebSocketsToken`, which requires the **Access WebSocket API** permission.
- The response is `{ token, expires }`, where `expires` is in seconds (900 in the example).
- The token must be used within 15 minutes and stays valid while an authenticated subscription remains open.
- Reconnecting needs a fresh token, followed by REST reconciliation.
