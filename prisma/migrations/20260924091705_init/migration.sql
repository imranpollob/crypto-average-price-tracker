-- CreateTable
CREATE TABLE "providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "provider_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "encrypted_credentials" TEXT,
    "last_successful_sync_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "provider_accounts_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "trades" (
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
    "received_via" TEXT NOT NULL DEFAULT 'rest',
    "imported_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trades_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider_account_id" TEXT NOT NULL,
    "external_transfer_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "fee" TEXT NOT NULL,
    "fee_asset" TEXT,
    "occurred_at" DATETIME NOT NULL,
    "tx_hash" TEXT,
    "raw_json" TEXT NOT NULL,
    "imported_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transfers_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider_account_id" TEXT NOT NULL,
    "external_ledger_id" TEXT NOT NULL,
    "external_reference_id" TEXT,
    "entry_type" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "fee" TEXT NOT NULL,
    "balance_after" TEXT,
    "occurred_at" DATETIME NOT NULL,
    "raw_json" TEXT NOT NULL,
    "imported_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_entries_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "balance_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider_account_id" TEXT NOT NULL,
    "sync_run_id" TEXT,
    "asset" TEXT NOT NULL,
    "total" TEXT NOT NULL,
    "available" TEXT,
    "as_of" DATETIME NOT NULL,
    "raw_json" TEXT NOT NULL,
    CONSTRAINT "balance_snapshots_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "balance_snapshots_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "lots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider_account_id" TEXT NOT NULL,
    "source_trade_id" TEXT,
    "source_transfer_id" TEXT,
    "asset" TEXT NOT NULL,
    "original_quantity" TEXT NOT NULL,
    "remaining_quantity" TEXT NOT NULL,
    "acquisition_price" TEXT,
    "price_asset" TEXT,
    "acquisition_cost" TEXT,
    "acquisition_fee" TEXT,
    "remaining_cost" TEXT,
    "acquired_at" DATETIME NOT NULL,
    "cost_basis_status" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "lots_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "lots_source_trade_id_fkey" FOREIGN KEY ("source_trade_id") REFERENCES "trades" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "lots_source_transfer_id_fkey" FOREIGN KEY ("source_transfer_id") REFERENCES "transfers" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "lot_matches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "disposal_key" TEXT NOT NULL,
    "match_type" TEXT NOT NULL,
    "sell_trade_id" TEXT,
    "transfer_id" TEXT,
    "lot_id" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "allocated_acquisition_cost" TEXT,
    "allocated_buy_fee" TEXT,
    "gross_sale_proceeds" TEXT,
    "allocated_sell_fee" TEXT,
    "realized_pnl" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "lot_matches_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "lot_matches_sell_trade_id_fkey" FOREIGN KEY ("sell_trade_id") REFERENCES "trades" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "lot_matches_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfers" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "manual_valuations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "target_type" TEXT NOT NULL,
    "target_key" TEXT NOT NULL,
    "gross" TEXT NOT NULL,
    "fee" TEXT NOT NULL,
    "note" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "price_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "base_asset" TEXT NOT NULL,
    "quote_asset" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "as_of" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sync_runs" (
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
    "error_message" TEXT,
    CONSTRAINT "sync_runs_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "providers_type_key" ON "providers"("type");

-- CreateIndex
CREATE INDEX "trades_base_asset_executed_at_idx" ON "trades"("base_asset", "executed_at");

-- CreateIndex
CREATE INDEX "trades_quote_asset_executed_at_idx" ON "trades"("quote_asset", "executed_at");

-- CreateIndex
CREATE UNIQUE INDEX "trades_provider_account_id_external_trade_id_key" ON "trades"("provider_account_id", "external_trade_id");

-- CreateIndex
CREATE INDEX "transfers_asset_occurred_at_idx" ON "transfers"("asset", "occurred_at");

-- CreateIndex
CREATE INDEX "transfers_tx_hash_idx" ON "transfers"("tx_hash");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_provider_account_id_external_transfer_id_key" ON "transfers"("provider_account_id", "external_transfer_id");

-- CreateIndex
CREATE INDEX "ledger_entries_asset_occurred_at_idx" ON "ledger_entries"("asset", "occurred_at");

-- CreateIndex
CREATE INDEX "ledger_entries_external_reference_id_idx" ON "ledger_entries"("external_reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_provider_account_id_external_ledger_id_key" ON "ledger_entries"("provider_account_id", "external_ledger_id");

-- CreateIndex
CREATE INDEX "balance_snapshots_provider_account_id_asset_as_of_idx" ON "balance_snapshots"("provider_account_id", "asset", "as_of");

-- CreateIndex
CREATE INDEX "lots_asset_acquired_at_idx" ON "lots"("asset", "acquired_at");

-- CreateIndex
CREATE INDEX "lot_matches_disposal_key_idx" ON "lot_matches"("disposal_key");

-- CreateIndex
CREATE INDEX "lot_matches_lot_id_idx" ON "lot_matches"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "manual_valuations_target_type_target_key_key" ON "manual_valuations"("target_type", "target_key");

-- CreateIndex
CREATE UNIQUE INDEX "price_cache_source_base_asset_quote_asset_key" ON "price_cache"("source", "base_asset", "quote_asset");

-- CreateIndex
CREATE INDEX "sync_runs_provider_account_id_started_at_idx" ON "sync_runs"("provider_account_id", "started_at");
