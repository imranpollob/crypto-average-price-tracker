import { describe, expect, it } from "vitest";
import { createSigner, InvalidSecretError, isValidKrakenSecret, NonceGenerator } from "./auth";
import { parseJsonLossless } from "./json";
import { krakenTime, toKrakenSeconds } from "./normalizer";

describe("Kraken request signing", () => {
  it("matches the official documentation test vector", () => {
    const sign = createSigner("kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==");
    const nonce = "1616492376594";
    const body = "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25";
    expect(sign("/0/private/AddOrder", nonce, body)).toBe(
      "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==",
    );
  });

  it("rejects a private key that is not base64", () => {
    expect(isValidKrakenSecret("not a secret!")).toBe(false);
    expect(() => createSigner("not a secret!")).toThrow(InvalidSecretError);
  });

  it("the signer does not expose the secret", () => {
    const secret = Buffer.alloc(64, 7).toString("base64");
    const sign = createSigner(secret);
    expect(JSON.stringify({ sign })).not.toContain(secret);
    expect(String(sign)).not.toContain(secret);
  });
});

describe("nonce", () => {
  it("strictly increases even if the clock stalls or goes backwards", () => {
    const g = new NonceGenerator();
    const a = BigInt(g.next(1_000));
    const b = BigInt(g.next(1_000));
    const c = BigInt(g.next(500));
    const d = BigInt(g.next(2_000));
    expect(b > a && c > b && d > c).toBe(true);
    expect(d).toBe(2_000_000n);
  });
});

describe("lossless JSON and timestamps", () => {
  it("keeps JSON numbers as their exact source text", () => {
    const parsed = parseJsonLossless('{"time":1688464484.1787,"count":12,"big":123456789012345678901234567890}') as Record<string, string>;
    expect(parsed).toEqual({ time: "1688464484.1787", count: "12", big: "123456789012345678901234567890" });
  });

  it("converts Kraken seconds to milliseconds without floats", () => {
    expect(krakenTime("1688464484.1787").toISOString()).toBe("2023-07-04T09:54:44.179Z");
    expect(krakenTime("1688464484").getTime()).toBe(1688464484000);
    expect(() => krakenTime("abc")).toThrow(/invalid/);
    expect(() => krakenTime(1688464484 as unknown as string)).toThrow(/invalid/);
  });

  it("window bounds use whole seconds", () => {
    expect(toKrakenSeconds(new Date("2026-09-24T12:00:00.999Z"))).toBe(Date.parse("2026-09-24T12:00:00Z") / 1000);
  });
});
