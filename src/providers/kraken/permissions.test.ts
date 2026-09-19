import { describe, expect, it } from "vitest";
import { krakenError, TWO_FACTOR_UNSUPPORTED } from "./errors";
import { assessPermissions, parseKeyInfo, permissionError, READ_ONLY_NOTICE } from "./permissions";
import { FAKE_IBAN, FakeKraken } from "./testing/fake-kraken";
import { krakenHarness } from "./testing/harness";

/** The documented GetApiKeyInfo example response (docs.kraken.com, Get API Key Info). */
const DOCUMENTED_EXAMPLE = {
  apiKeyName: "my-api-key",
  apiKey: "4/SDrDBcOOPnm3nPlNfEMMJDeRcIVqPz+QhRxIodyZbI9po/aVRiHsgX",
  nonce: "1772627060997",
  nonceWindow: "0",
  permissions: ["query-funds", "withdraw-funds", "query-open-trades", "modify-trades"],
  iban: "AA88 N84G WOAK NMOI",
  validUntil: "0",
  queryFrom: "0",
  queryTo: "0",
  createdTime: "1772542900",
  modifiedTime: "1772543095",
  ipAllowlist: [],
  lastUsed: "1772627061",
};

const NOW = 1_790_000_000;
const withPerms = (...permissions: string[]) => ({ permissions, queryFrom: 0, queryTo: 0, validUntil: 0 });
const connect = async (setup: (f: FakeKraken) => void) => {
  const fake = new FakeKraken();
  setup(fake);
  return krakenHarness({ fake }).provider.testConnection();
};

describe("GetApiKeyInfo parsing", () => {
  it("reads permissions and restrictions from the documented example, discarding the key and IBAN", () => {
    const info = parseKeyInfo(DOCUMENTED_EXAMPLE);
    expect(info).toEqual({
      permissions: ["query-funds", "withdraw-funds", "query-open-trades", "modify-trades"],
      queryFrom: 0,
      queryTo: 0,
      validUntil: 0,
    });
    const text = JSON.stringify(info);
    expect(text).not.toContain(DOCUMENTED_EXAMPLE.apiKey);
    expect(text).not.toContain(DOCUMENTED_EXAMPLE.iban);
  });

  it("the documented example key would be refused: dangerous and missing permissions", () => {
    const a = assessPermissions(parseKeyInfo(DOCUMENTED_EXAMPLE), NOW);
    expect(a.dangerous).toEqual(["withdraw-funds", "modify-trades"]);
    expect(a.missing).toEqual(["query-closed-trades", "query-ledger"]);
    expect(permissionError(a)!.code).toBe("excessive_permissions");
  });

  it("rejects malformed responses", () => {
    expect(() => parseKeyInfo({ permissions: "query-funds" })).toThrow(/invalid permissions/);
  });
});

describe("required read-only permissions", () => {
  it("#1/#2 exactly the three read permissions → connected, read-only notice shown", async () => {
    const r = await connect(() => {});
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.warnings).toEqual([READ_ONLY_NOTICE]);
  });

  it("#2 Query Open Orders & Trades is not required", () => {
    const a = assessPermissions(withPerms("query-funds", "query-closed-trades", "query-ledger"), NOW);
    expect(a.missing).toEqual([]);
    expect(permissionError(a)).toBeNull();
  });

  it.each([
    ["#3", "query-funds", "Query Funds"],
    ["#4", "query-closed-trades", "Query Closed Orders & Trades"],
    ["#5", "query-ledger", "Query Ledger Entries"],
  ])("%s missing %s → refused, names the permission", async (_n, permission, name) => {
    const r = await connect((f) => f.keyPermissions.delete(permission));
    expect(r).toMatchObject({ ok: false, code: "insufficient_permissions" });
    if (!r.ok) expect(r.message).toContain(name);
  });
});

describe("dangerous permissions are refused", () => {
  it.each([
    ["modify-trades", "Create & Modify Orders"],
    ["close-trades", "Cancel/Close Orders"],
  ])("#6 trading permission %s", async (permission, name) => {
    const r = await connect((f) => f.keyPermissions.add(permission));
    expect(r).toMatchObject({ ok: false, code: "excessive_permissions" });
    if (!r.ok) {
      expect(r.message).toContain("This application only needs read-only access.");
      expect(r.message).toContain(name);
    }
  });

  it.each([
    ["withdraw-funds", "Withdraw Funds"],
    ["add-withdraw-address", "Add withdrawal addresses"],
    ["update-withdraw-address", "Update withdrawal addresses"],
  ])("#7 withdrawal permission %s", async (permission, name) => {
    const r = await connect((f) => f.keyPermissions.add(permission));
    expect(r).toMatchObject({ ok: false, code: "excessive_permissions" });
    if (!r.ok) expect(r.message).toContain(name);
  });

  it.each(["add-funds", "earn-funds"])("funding / Earn permission %s", async (permission) => {
    expect(await connect((f) => f.keyPermissions.add(permission))).toMatchObject({ ok: false, code: "excessive_permissions" });
  });

  it("an unrecognized permission is refused rather than assumed harmless", async () => {
    const r = await connect((f) => f.keyPermissions.add("future-transfer-funds"));
    expect(r).toMatchObject({ ok: false, code: "excessive_permissions" });
    if (!r.ok) expect(r.message).toContain("future-transfer-funds");
  });

  it("lists every permission to remove", () => {
    const err = permissionError(
      assessPermissions(withPerms("query-funds", "query-closed-trades", "query-ledger", "withdraw-funds", "modify-trades"), NOW),
    )!;
    expect(err.message).toMatch(/Withdraw Funds.*Create & Modify Orders/);
  });

  it("a sync with a key that gained dangerous permissions is refused too", async () => {
    const fake = new FakeKraken();
    fake.keyPermissions.add("withdraw-funds");
    const { provider } = krakenHarness({ fake });
    expect(await provider.testConnection()).toMatchObject({ ok: false });
    expect(fake.callsTo("TradesHistory")).toBe(0);
  });
});

describe("allowed extra permissions", () => {
  it("#8 WebSocket token permission is accepted without complaint", async () => {
    const r = await connect((f) => f.keyPermissions.add("create-ws-token"));
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.warnings).toEqual([READ_ONLY_NOTICE]);
  });

  it("unnecessary read-only permissions are accepted with an informational warning", async () => {
    const r = await connect((f) => {
      f.keyPermissions.add("query-open-trades");
      f.keyPermissions.add("export-data");
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/Not needed.*Query Open Orders & Trades.*Export Data/);
  });
});

describe("key restrictions", () => {
  it("warns when the key restricts the query date range (history would be missing)", async () => {
    const r = await connect((f) => (f.keyInfoOverrides = { queryFrom: "1700000000" }));
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/restricts the date range/);
  });

  it("warns about an expiry date and an expired key", () => {
    expect(assessPermissions({ ...withPerms(), validUntil: NOW + 86_400 }, NOW).warnings.join(" ")).toMatch(/expires on/);
    expect(assessPermissions({ ...withPerms(), validUntil: NOW - 1 }, NOW).warnings.join(" ")).toMatch(/expired/);
  });
});

describe("GetApiKeyInfo unavailable", () => {
  it("falls back to probing the endpoints and says permissions could not be verified", async () => {
    const r = await connect((f) => (f.supportsKeyInfo = false));
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/could not be verified/);
  });
});

describe("#20 API-key 2FA is unsupported", () => {
  it("an OTP-related error gets the dedicated message", () => {
    const e = krakenError(["EAPI:Invalid otp"], "GetApiKeyInfo");
    expect(e.code).toBe("unsupported_authentication");
    expect(e.message).toBe(TWO_FACTOR_UNSUPPORTED);
  });

  it("authentication failures mention 2FA as a possible cause", async () => {
    const r = await connect((f) => f.fail("GetApiKeyInfo", { error: "EAPI:Invalid key" }));
    expect(r).toMatchObject({ ok: false, code: "invalid_credentials" });
    if (!r.ok) expect(r.message).toContain("API-key 2FA is not supported in this version.");
  });

  it("a denied GetApiKeyInfo (which needs no permission) is not reported as a missing permission", () => {
    const e = krakenError(["EGeneral:Permission denied"], "GetApiKeyInfo");
    expect(e.message).toContain("API-key 2FA");
    expect(e.message).not.toMatch(/missing a required/);
  });
});

describe("connection results never contain secrets or account identifiers", () => {
  it("excludes the key, secret and IBAN", async () => {
    const fake = new FakeKraken();
    fake.keyPermissions.add("create-ws-token");
    const r = await krakenHarness({ fake }).provider.testConnection();
    const text = JSON.stringify(r);
    expect(text).not.toContain(fake.apiKey);
    expect(text).not.toContain(fake.apiSecret);
    expect(text).not.toContain(FAKE_IBAN);
  });
});
