import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncService } from "@/application/sync/sync-service";
import { createAccountingConfig } from "@/domain/accounting/config";
import { FAKE_IBAN, FakeKraken } from "@/providers/kraken/testing/fake-kraken";
import { krakenHarness, ks } from "@/providers/kraken/testing/harness";
import { CredentialCipher } from "@/server/credentials/cipher";
import { CredentialStore } from "@/server/credentials/credential-store";
import type { Db } from "@/server/db/client";
import { HistoryRepository } from "@/server/db/history-repository";
import { PrismaSyncStore } from "@/server/db/prisma-sync-store";
import { createTestDb } from "@/test/test-db";
import { buildSyncDiagnostics, diagnosticsText } from "./sync-diagnostics";

const config = createAccountingConfig("USD", undefined, ["KFEE"]);

let db: Db;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterEach(async () => {
  await cleanup();
});

describe("post-sync diagnostics", () => {
  it("#21 report the validation figures and contain no secrets", async () => {
    const repo = new HistoryRepository(db);
    await repo.ensureProvider("kraken", "exchange", "Kraken");
    const accountId = await repo.createAccount("kraken", "Kraken");
    const fake = new FakeKraken()
      .addLedgerRow({ type: "deposit", asset: "ZUSD", amount: "1000", time: ks("2026-08-01T00:00:00Z") })
      .addLedgerRow({ type: "credit", asset: "KFEE", amount: "500", time: ks("2026-08-01T00:00:01Z") })
      .addTrade({ txid: "T1", pair: "ADAUSD", type: "buy", vol: "1000", price: "0.2", fee: "0.52", time: ks("2026-08-02T00:00:00Z") })
      .addTrade({ txid: "T2", pair: "ADAUSD", type: "buy", vol: "100", price: "0.2", fee: "0.05", feeIn: "kfee", time: ks("2026-08-03T00:00:00Z") })
      .addTrade({ txid: "T3", pair: "ADAUSD", type: "sell", vol: "10", price: "0.3", fee: "0.01", withoutLedger: true, time: ks("2026-08-04T00:00:00Z") })
      .addInstant({ refid: "RI1", time: ks("2026-08-05T00:00:00Z"), spend: { asset: "ZUSD", amount: "-50" }, receive: { asset: "DOT", amount: "10" } })
      .addLedgerRow({ refid: "RLONE", type: "receive", asset: "DOT", amount: "3", time: ks("2026-08-06T00:00:00Z") });

    // Store encrypted credentials exactly as the app does.
    const cipher = new CredentialCipher(randomBytes(32));
    await new CredentialStore(db, cipher).save(accountId, { apiKey: fake.apiKey, apiSecret: fake.apiSecret });
    const encrypted = (await db.providerAccount.findUniqueOrThrow({ where: { id: accountId } })).encryptedCredentials!;

    const h = krakenHarness({ fake, accountId });
    const service = new SyncService({ store: new PrismaSyncStore(db), now: () => new Date(h.clock.now()), config });
    expect((await service.sync(h.provider, "manual")).ok).toBe(true);

    const d = await buildSyncDiagnostics({ db, providerAccountId: accountId, providerName: "Kraken", config, now: new Date("2026-09-24T12:00:00Z") });
    expect(d.records).toEqual({ trades: 4, exchangeTrades: 3, ledgerDerivedTrades: 1, ledgerEntries: 10, transfers: 2 });
    expect(d.fees).toEqual({ zeroFee: 1, normal: 2, thirdAsset: 0, feeCredit: 1, fromTradeRecord: 1, reportedButNotCharged: 0 });
    expect(d.review).toEqual({ total: 1, byLedgerType: [{ type: "receive", count: 1 }] });
    expect(d.earliestTransaction).toBe("2026-08-01T00:00:00.000Z");
    expect(d.latestTransaction).toBe("2026-08-06T00:00:00.000Z");
    expect(d.lastSuccessfulSyncAt).toBe("2026-09-24T12:00:00.000Z");
    expect(d.lastRun).toMatchObject({ status: "succeeded", mode: "initial", syncFrom: null });
    expect(d.excludedBalances).toEqual([{ asset: "KFEE", total: "495", reason: "fee credit (not a portfolio asset)" }]);
    expect(d.reconciliation.map((r) => r.asset)).toEqual(["ADA", "DOT"]);

    const text = diagnosticsText(d);
    expect(text).toContain("1 instant buy/sell/convert");
    for (const secret of [fake.apiKey, fake.apiSecret, encrypted, FAKE_IBAN]) {
      expect(JSON.stringify(d)).not.toContain(secret);
      expect(text).not.toContain(secret);
    }
  });
});
