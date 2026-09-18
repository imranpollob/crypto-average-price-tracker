import { describe, expect, it } from "vitest";
import { redactSecrets, safeErrorMessage } from "@/lib/redact";

describe("log redaction", () => {
  const secret = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==";

  it("removes key/value style secrets", () => {
    const out = redactSecrets(`request failed api_secret=${secret} API-Sign: abcdef123 password: hunter2`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("abcdef123");
    expect(out).not.toContain("hunter2");
  });

  it("removes long base64-like tokens anywhere", () => {
    expect(redactSecrets(`bad nonce for ${secret}`)).toBe("bad nonce for [REDACTED]");
  });

  it("produces bounded, safe error text", () => {
    const msg = safeErrorMessage(new Error(`boom ${secret} ${"x".repeat(1000)}`));
    expect(msg).not.toContain(secret);
    expect(msg.length).toBeLessThanOrEqual(501);
    expect(safeErrorMessage({ weird: true })).toBe("Unknown error");
  });
});
