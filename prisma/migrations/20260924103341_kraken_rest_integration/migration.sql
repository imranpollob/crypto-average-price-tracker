-- CreateTable
CREATE TABLE "reconciliation_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sync_run_id" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "calculated" TEXT NOT NULL,
    "reported" TEXT NOT NULL,
    "difference" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reconciliation_results_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reconciliation_results_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ledger_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider_account_id" TEXT NOT NULL,
    "external_ledger_id" TEXT NOT NULL,
    "external_reference_id" TEXT,
    "entry_type" TEXT NOT NULL,
    "provider_entry_type" TEXT NOT NULL,
    "provider_subtype" TEXT,
    "asset" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "fee" TEXT NOT NULL,
    "balance_after" TEXT,
    "occurred_at" DATETIME NOT NULL,
    "raw_json" TEXT NOT NULL,
    "imported_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_entries_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ledger_entries" ("amount", "asset", "balance_after", "entry_type", "external_ledger_id", "external_reference_id", "fee", "id", "imported_at", "occurred_at", "provider_account_id", "raw_json") SELECT "amount", "asset", "balance_after", "entry_type", "external_ledger_id", "external_reference_id", "fee", "id", "imported_at", "occurred_at", "provider_account_id", "raw_json" FROM "ledger_entries";
DROP TABLE "ledger_entries";
ALTER TABLE "new_ledger_entries" RENAME TO "ledger_entries";
CREATE INDEX "ledger_entries_asset_occurred_at_idx" ON "ledger_entries"("asset", "occurred_at");
CREATE INDEX "ledger_entries_external_reference_id_idx" ON "ledger_entries"("external_reference_id");
CREATE UNIQUE INDEX "ledger_entries_provider_account_id_external_ledger_id_key" ON "ledger_entries"("provider_account_id", "external_ledger_id");
CREATE TABLE "new_sync_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider_account_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL,
    "finished_at" DATETIME,
    "sync_from" DATETIME,
    "sync_to" DATETIME NOT NULL,
    "records_received" INTEGER NOT NULL DEFAULT 0,
    "records_inserted" INTEGER NOT NULL DEFAULT 0,
    "trades_received" INTEGER NOT NULL DEFAULT 0,
    "trades_inserted" INTEGER NOT NULL DEFAULT 0,
    "ledger_received" INTEGER NOT NULL DEFAULT 0,
    "ledger_inserted" INTEGER NOT NULL DEFAULT 0,
    "transfers_received" INTEGER NOT NULL DEFAULT 0,
    "transfers_inserted" INTEGER NOT NULL DEFAULT 0,
    "balances_retrieved" INTEGER NOT NULL DEFAULT 0,
    "error_category" TEXT,
    "error_message" TEXT,
    CONSTRAINT "sync_runs_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_sync_runs" ("error_message", "finished_at", "id", "mode", "provider_account_id", "records_inserted", "records_received", "started_at", "status", "sync_from", "sync_to") SELECT "error_message", "finished_at", "id", "mode", "provider_account_id", "records_inserted", "records_received", "started_at", "status", "sync_from", "sync_to" FROM "sync_runs";
DROP TABLE "sync_runs";
ALTER TABLE "new_sync_runs" RENAME TO "sync_runs";
CREATE INDEX "sync_runs_provider_account_id_started_at_idx" ON "sync_runs"("provider_account_id", "started_at");
CREATE TABLE "new_trades" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider_account_id" TEXT NOT NULL,
    "external_trade_id" TEXT NOT NULL,
    "external_order_id" TEXT,
    "base_asset" TEXT NOT NULL,
    "quote_asset" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "gross_value" TEXT NOT NULL,
    "fee" TEXT NOT NULL,
    "fee_asset" TEXT,
    "executed_at" DATETIME NOT NULL,
    "raw_json" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'exchange',
    "fee_source" TEXT,
    "received_via" TEXT NOT NULL DEFAULT 'rest',
    "imported_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trades_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_trades" ("base_asset", "executed_at", "external_order_id", "external_trade_id", "fee", "fee_asset", "gross_value", "id", "imported_at", "price", "provider_account_id", "quantity", "quote_asset", "raw_json", "received_via", "side") SELECT "base_asset", "executed_at", "external_order_id", "external_trade_id", "fee", "fee_asset", "gross_value", "id", "imported_at", "price", "provider_account_id", "quantity", "quote_asset", "raw_json", "received_via", "side" FROM "trades";
DROP TABLE "trades";
ALTER TABLE "new_trades" RENAME TO "trades";
CREATE INDEX "trades_base_asset_executed_at_idx" ON "trades"("base_asset", "executed_at");
CREATE INDEX "trades_quote_asset_executed_at_idx" ON "trades"("quote_asset", "executed_at");
CREATE UNIQUE INDEX "trades_provider_account_id_external_trade_id_key" ON "trades"("provider_account_id", "external_trade_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "reconciliation_results_provider_account_id_created_at_idx" ON "reconciliation_results"("provider_account_id", "created_at");
