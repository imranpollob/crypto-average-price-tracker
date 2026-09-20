import { type AutomaticMatchingMethod, isAutomaticMatchingMethod } from "@/domain/lots/automatic-matching";
import type { Db } from "../db/client";

/** Application-wide settings (provider-independent), stored in app_settings. */

export const AUTOMATIC_LOT_MATCHING_METHOD_KEY = "automatic_lot_matching_method";
/** Default when never set: the MVP behaviour. */
export const DEFAULT_AUTOMATIC_LOT_MATCHING_METHOD: AutomaticMatchingMethod = "fifo";

export class SettingsService {
  constructor(private readonly db: Db) {}

  async automaticLotMatchingMethod(): Promise<AutomaticMatchingMethod> {
    const row = await this.db.appSetting.findUnique({ where: { key: AUTOMATIC_LOT_MATCHING_METHOD_KEY } });
    return row && isAutomaticMatchingMethod(row.value) ? row.value : DEFAULT_AUTOMATIC_LOT_MATCHING_METHOD;
  }

  async setAutomaticLotMatchingMethod(method: AutomaticMatchingMethod): Promise<void> {
    if (!isAutomaticMatchingMethod(method)) throw new Error(`Unknown automatic lot matching method: ${String(method)}`);
    await this.db.appSetting.upsert({
      where: { key: AUTOMATIC_LOT_MATCHING_METHOD_KEY },
      create: { key: AUTOMATIC_LOT_MATCHING_METHOD_KEY, value: method },
      update: { value: method },
    });
  }
}
