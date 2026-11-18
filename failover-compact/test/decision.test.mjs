import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldCompact } from "../dist/decision.js";

const base = {
  trigger: true,
  triggerDetail: "fallback model ran after the primary failed",
  inputTokens: 230_000,
  tokenThreshold: 100_000,
  lastCompactAt: null,
  cooldownMs: 3_600_000,
  now: 1_800_000_000_000,
};

describe("shouldCompact", () => {
  it("compacts a triggered run over threshold", () => {
    const d = shouldCompact({ ...base });
    assert.equal(d.compact, true);
  });

  it("skips a run with no trigger, even over threshold", () => {
    const d = shouldCompact({ ...base, trigger: false });
    assert.equal(d.compact, false);
  });

  it("skips a small session", () => {
    const d = shouldCompact({ ...base, inputTokens: 50_000 });
    assert.equal(d.compact, false);
  });

  it("refuses to guess when the token count is unknown", () => {
    const d = shouldCompact({ ...base, inputTokens: null });
    assert.equal(d.compact, false);
  });

  it("respects the cooldown", () => {
    const d = shouldCompact({ ...base, lastCompactAt: base.now - 60_000 });
    assert.equal(d.compact, false);
  });

  it("compacts again after the cooldown elapses", () => {
    const d = shouldCompact({ ...base, lastCompactAt: base.now - 3_600_001 });
    assert.equal(d.compact, true);
  });
});
