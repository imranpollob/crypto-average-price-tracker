import { describe, expect, it } from "vitest";
import { buy, deposit, match, scenario, sell, valuation, withdrawal } from "@/test/builders";
import { expectDecimal, expectIncomplete, expectKnown, expectNotApplicable } from "@/test/expect-metric";

/**
 * Portfolio calculation scenarios. Numbers in test names refer to the required
 * test list in the project specification (§29).
 */

describe("#1 single buy", () => {
  it("creates one lot and derives every metric from it", () => {
    const p = scenario({ trades: [buy("100", "0.5")] }).position("ADA", "0.6");
    expectDecimal(p.holdings, "100");
    expectKnown(p.costBasis, "50");
    expectKnown(p.averageCost, "0.5");
    expectKnown(p.currentPrice, "0.6");
    expectKnown(p.currentValue, "60");
    expectKnown(p.realizedPnl, "0");
    expectKnown(p.unrealizedPnl, "10");
    expectKnown(p.unrealizedPnlPercent, "20");
    expectKnown(p.totalPnl, "10");
    expect(p.reviewRequired).toBe(false);
  });
});

describe("#2 multiple buys", () => {
  it("keeps one lot per buy — no single global average", () => {
    const s = scenario({ trades: [buy("100", "20"), buy("100", "10")] });
    const lots = s.engine.lots.filter((l) => l.asset === "ADA");
    expect(lots).toHaveLength(2);
    expect(lots.map((l) => l.acquisitionCost!.toFixed())).toEqual(["2000", "1000"]);
    const p = s.position();
    expectDecimal(p.holdings, "200");
    expectKnown(p.costBasis, "3000");
  });
});

describe("#3 weighted average cost", () => {
  it("weights by quantity", () => {
    const p = scenario({ trades: [buy("100", "20"), buy("300", "10")] }).position();
    expectKnown(p.costBasis, "5000");
    expectKnown(p.averageCost, "12.5");
  });

  it("handles non-terminating averages without float error", () => {
    const p = scenario({
      trades: [buy("1000", "0.16"), buy("500", "0.14"), buy("250", "0.12")],
    }).position();
    expectKnown(p.costBasis, "260");
    // 260 / 1750 = 0.148571428571… (exact decimal division at full precision)
    expect(p.averageCost.status).toBe("known");
    if (p.averageCost.status === "known") {
      expect(p.averageCost.value.toFixed(12)).toBe("0.148571428571");
      expect(p.averageCost.value.times(1750).toDecimalPlaces(50).toFixed()).toBe("260");
    }
  });
});

describe("#4/#5 current price above and below average", () => {
  const s = scenario({ trades: [buy("100", "20"), buy("300", "10")] }); // avg 12.5

  it("#4 price above average → unrealized gain", () => {
    const p = s.position("ADA", "15");
    expectKnown(p.unrealizedPnl, "1000");
  });

  it("#5 price below average → unrealized loss", () => {
    const p = s.position("ADA", "10");
    expectKnown(p.unrealizedPnl, "-1000");
  });
});

describe("#6 current value", () => {
  it("is price × holdings, exactly", () => {
    const p = scenario({ trades: [buy("1234.5678", "0.1")] }).position("ADA", "0.145823");
    expectKnown(p.currentValue, "180.0283802994");
  });

  it("is known even while cost-basis metrics are pending", () => {
    const s = scenario({ trades: [buy("100", "10"), sell("40", "12")] }); // sell unmatched
    const p = s.position("ADA", "11");
    expectDecimal(p.holdings, "60");
    expectKnown(p.currentValue, "660");
    expectIncomplete(p.costBasis, "unmatched_sale");
  });

  it("is incomplete without a price", () => {
    const p = scenario({ trades: [buy("1", "10")] }).position("ADA", null);
    expectIncomplete(p.currentValue, "missing_price");
    expectIncomplete(p.unrealizedPnl, "missing_price");
    expectKnown(p.costBasis, "10"); // cost basis does not depend on market data
  });
});

describe("#7/#8 unrealized gain and loss percentages", () => {
  const s = scenario({ trades: [buy("100", "20"), buy("300", "10")] }); // basis 5000

  it("#7 unrealized gain", () => {
    const p = s.position("ADA", "15");
    expectKnown(p.unrealizedPnl, "1000");
    expectKnown(p.unrealizedPnlPercent, "20");
    expectKnown(p.totalPnl, "1000");
  });

  it("#8 unrealized loss", () => {
    const p = s.position("ADA", "10");
    expectKnown(p.unrealizedPnl, "-1000");
    expectKnown(p.unrealizedPnlPercent, "-20");
  });
});

describe("#9 full sale / #19 position reaches zero", () => {
  it("closes the position and keeps realized P/L", () => {
    const b = buy("100", "10");
    const x = sell("100", "12");
    const p = scenario({ trades: [b, x], matches: [match(x, b, "100")] }).position("ADA", "50");
    expectDecimal(p.holdings, "0");
    expectKnown(p.currentValue, "0");
    expectKnown(p.costBasis, "0");
    expectNotApplicable(p.averageCost);
    expectKnown(p.unrealizedPnl, "0");
    expectNotApplicable(p.unrealizedPnlPercent);
    expectKnown(p.realizedPnl, "200");
    expectKnown(p.totalPnl, "200");
  });

  it("a closed position needs no price", () => {
    const b = buy("100", "10");
    const x = sell("100", "12");
    const p = scenario({ trades: [b, x], matches: [match(x, b, "100")] }).position("ADA", null);
    expectKnown(p.currentValue, "0");
    expectKnown(p.totalPnl, "200");
  });
});

describe("#10 partial sale", () => {
  it("realizes only the sold part", () => {
    const b = buy("100", "10");
    const x = sell("40", "12");
    const p = scenario({ trades: [b, x], matches: [match(x, b, "40")] }).position("ADA", "12");
    expectKnown(p.realizedPnl, "80");
    expectDecimal(p.holdings, "60");
    expectKnown(p.costBasis, "600");
    expectKnown(p.averageCost, "10");
    expectKnown(p.unrealizedPnl, "120");
    expectKnown(p.totalPnl, "200");
  });
});

describe("#11/#12 sell matched to cheaper vs. more expensive lot (spec §1, §15)", () => {
  const b20 = buy("100", "20");
  const b10 = buy("100", "10");
  const x = sell("100", "13");

  it("#11 closing the $10 lot", () => {
    const p = scenario({ trades: [b20, b10, x], matches: [match(x, b10, "100")] }).position("ADA", "13");
    expectDecimal(p.holdings, "100");
    expectKnown(p.averageCost, "20");
    expectKnown(p.costBasis, "2000");
    expectKnown(p.realizedPnl, "300");
    expectKnown(p.currentValue, "1300");
    expectKnown(p.unrealizedPnl, "-700");
    expectKnown(p.totalPnl, "-400");
  });

  it("#12 closing the $20 lot", () => {
    const p = scenario({ trades: [b20, b10, x], matches: [match(x, b20, "100")] }).position("ADA", "13");
    expectKnown(p.averageCost, "10");
    expectKnown(p.costBasis, "1000");
    expectKnown(p.realizedPnl, "-700");
    expectKnown(p.unrealizedPnl, "300");
    expectKnown(p.totalPnl, "-400");
  });
});

describe("#13 sell distributed across multiple lots", () => {
  it("150 sold as 100 from lot A + 50 from lot B", () => {
    const a = buy("100", "20");
    const b = buy("100", "10");
    const x = sell("150", "13");
    const s = scenario({ trades: [a, b, x], matches: [match(x, a, "100"), match(x, b, "50")] });
    const p = s.position("ADA", "13");
    // (1300 − 2000) + (650 − 500)
    expectKnown(p.realizedPnl, "-550");
    expectKnown(p.costBasis, "500");
    expectKnown(p.averageCost, "10");
    expectKnown(p.unrealizedPnl, "150");
    expectKnown(p.totalPnl, "-400");
    expect(s.engine.allocations.filter((al) => al.disposalId.endsWith(`${x.externalTradeId}:base`))).toHaveLength(2);
  });

  it("dashboard example (spec §12, §21): ADA lots at 0.16 / 0.14 / 0.12, sell 1000 @ 0.145 from the 0.12 lot", () => {
    const l1 = buy("1000", "0.16");
    const l2 = buy("1000", "0.14");
    const l3 = buy("1000", "0.12");
    const x = sell("1000", "0.145");
    const p = scenario({ trades: [l1, l2, l3, x], matches: [match(x, l3, "1000")] }).position("ADA", "0.145");
    expectKnown(p.realizedPnl, "25");
    expectDecimal(p.holdings, "2000");
    expectKnown(p.currentValue, "290");
    expectKnown(p.averageCost, "0.15");
    expectKnown(p.costBasis, "300");
    expectKnown(p.unrealizedPnl, "-10");
    expect(p.unrealizedPnlPercent.status).toBe("known");
    if (p.unrealizedPnlPercent.status === "known") {
      expect(p.unrealizedPnlPercent.value.toFixed(2)).toBe("-3.33");
    }
    expectKnown(p.totalPnl, "15");
  });
});

describe("#14 buy fee", () => {
  it("is included in acquisition cost (spec §11)", () => {
    const p = scenario({ trades: [buy("100", "10", { fee: "5" })] }).position();
    expectKnown(p.costBasis, "1005");
    expectKnown(p.averageCost, "10.05");
  });
});

describe("#15 sell fee", () => {
  it("reduces net proceeds: 1196 − 1005 = +191 (spec §11)", () => {
    const b = buy("100", "10", { fee: "5" });
    const x = sell("100", "12", { fee: "4" });
    const s = scenario({ trades: [b, x], matches: [match(x, b, "100")] });
    const al = s.engine.allocations[0]!;
    expectDecimal(al.grossSaleProceeds, "1200");
    expectDecimal(al.allocatedSellFee, "4");
    expectDecimal(al.netSaleProceeds, "1196");
    expectDecimal(al.allocatedAcquisitionCost, "1005");
    expectKnown(s.position().realizedPnl, "191");
  });
});

describe("#16 partial-lot fee allocation", () => {
  it("allocates buy fee and cost proportionally, the final close takes the exact remainder", () => {
    const b = buy("100", "10", { fee: "5" }); // cost 1005
    const x1 = sell("40", "12", { fee: "2" });
    const x2 = sell("60", "11", { fee: "1.5" });

    const partial = scenario({ trades: [b, x1], matches: [match(x1, b, "40")] });
    const a1 = partial.engine.allocations[0]!;
    expectDecimal(a1.allocatedAcquisitionCost, "402");
    expectDecimal(a1.allocatedBuyFee, "2");
    expectDecimal(a1.realizedPnl, "76"); // 480 − 2 − 402
    const lot = partial.engine.lots[0]!;
    expectDecimal(lot.remainingCost, "603");
    expectDecimal(lot.remainingFee, "3");
    expectKnown(partial.position().averageCost, "10.05");

    const full = scenario({ trades: [b, x1, x2], matches: [match(x1, b, "40"), match(x2, b, "60")] });
    const a2 = full.engine.allocations[1]!;
    expectDecimal(a2.allocatedAcquisitionCost, "603");
    expectDecimal(a2.realizedPnl, "55.5"); // 660 − 1.5 − 603
    expectKnown(full.position().realizedPnl, "131.5");
    expectDecimal(full.engine.lots[0]!.remainingCost, "0");
  });

  it("splits one sell fee across multiple lots by quantity", () => {
    const a = buy("100", "10");
    const b = buy("50", "10");
    const x = sell("150", "12", { fee: "3" });
    const s = scenario({ trades: [a, b, x], matches: [match(x, a, "100"), match(x, b, "50")] });
    expectDecimal(s.engine.allocations[0]!.allocatedSellFee, "2");
    expectDecimal(s.engine.allocations[1]!.allocatedSellFee, "1");
  });
});

describe("#17 multiple fees", () => {
  it("buy fees on two lots and a sell fee split across them", () => {
    const l1 = buy("10", "100", { fee: "1" }); // 1001
    const l2 = buy("10", "110", { fee: "1.1" }); // 1101.1
    const x = sell("15", "120", { fee: "1.8" }); // gross 1800
    const s = scenario({ trades: [l1, l2, x], matches: [match(x, l1, "10"), match(x, l2, "5")] });
    const [m1, m2] = s.engine.allocations;
    expectDecimal(m1!.allocatedAcquisitionCost, "1001");
    expectDecimal(m1!.grossSaleProceeds, "1200");
    expectDecimal(m1!.allocatedSellFee, "1.2");
    expectDecimal(m1!.realizedPnl, "197.8");
    expectDecimal(m2!.allocatedAcquisitionCost, "550.55");
    expectDecimal(m2!.allocatedBuyFee, "0.55");
    expectDecimal(m2!.grossSaleProceeds, "600");
    expectDecimal(m2!.allocatedSellFee, "0.6");
    expectDecimal(m2!.realizedPnl, "48.85");
    const p = s.position("ADA", "120");
    expectKnown(p.realizedPnl, "246.65");
    expectKnown(p.costBasis, "550.55");
    expectKnown(p.unrealizedPnl, "49.45");
    expectKnown(p.totalPnl, "296.1");
  });
});

describe("#18 buy after another lot was closed (spec §16)", () => {
  it("closed lots do not influence the new average", () => {
    const b20 = buy("100", "20");
    const b10 = buy("100", "10");
    const x = sell("100", "13");
    const b12 = buy("100", "12");
    const before = scenario({ trades: [b20, b10, x], matches: [match(x, b10, "100")] }).position();
    expectKnown(before.averageCost, "20");
    const after = scenario({ trades: [b20, b10, x, b12], matches: [match(x, b10, "100")] }).position();
    expectKnown(after.averageCost, "16");
    expectKnown(after.costBasis, "3200");
    expectDecimal(after.holdings, "200");
  });
});

describe("#20 re-enter position after zero (spec §17)", () => {
  it("starts a new open position; realized history is kept", () => {
    const b = buy("100", "10");
    const x = sell("100", "15");
    const again = buy("50", "20");
    const p = scenario({ trades: [b, x, again], matches: [match(x, b, "100")] }).position("ADA", "22");
    expectDecimal(p.holdings, "50");
    expectKnown(p.costBasis, "1000");
    expectKnown(p.averageCost, "20");
    expectKnown(p.realizedPnl, "500");
    expectKnown(p.unrealizedPnl, "100");
    expectKnown(p.totalPnl, "600");
  });
});

describe("#26 deposit with unknown cost basis (spec §18)", () => {
  it("tracks the quantity but does not invent a cost", () => {
    const d = deposit("BTC", "1");
    const s = scenario({ transfers: [d] });
    const lot = s.engine.lots[0]!;
    expect(lot.costBasisStatus).toBe("unknown");
    expect(lot.acquisitionCost).toBeNull();
    const p = s.position("BTC", "60000");
    expectDecimal(p.holdings, "1");
    expectKnown(p.currentValue, "60000"); // market value is independently known
    expectIncomplete(p.costBasis, "unknown_cost_basis");
    expectIncomplete(p.averageCost, "unknown_cost_basis");
    expectIncomplete(p.unrealizedPnl, "unknown_cost_basis");
    expectIncomplete(p.totalPnl, "unknown_cost_basis");
    expectKnown(p.realizedPnl, "0"); // a deposit is not a trade
    expect(p.reviewRequired).toBe(true);
    expect(p.counts.unknownCostLots).toBe(1);
  });

  it("becomes complete once the user sets the acquisition cost", () => {
    const d = deposit("BTC", "1");
    const s = scenario({ transfers: [d], valuations: [valuation(d, "30000", "10")] });
    expect(s.engine.lots[0]!.costBasisStatus).toBe("manual");
    const p = s.position("BTC", "60000");
    expectKnown(p.costBasis, "30010");
    expectKnown(p.unrealizedPnl, "29990");
    expect(p.reviewRequired).toBe(false);
  });

  it("deposit fee in the asset reduces the quantity received", () => {
    const s = scenario({ transfers: [deposit("BTC", "1", { fee: "0.001" })] });
    expectDecimal(s.position("BTC").holdings, "0.999");
  });

  it("selling from an unknown-cost lot leaves realized P/L pending", () => {
    const d = deposit("BTC", "1");
    const x = sell("0.5", "60000", { base: "BTC" });
    const p = scenario({ transfers: [d], trades: [x], matches: [match(x, d, "0.5")] }).position("BTC", "60000");
    expectIncomplete(p.realizedPnl, "unknown_cost_basis");
  });
});

describe("#27 withdrawal (spec §19)", () => {
  const b1 = buy("1", "30000", { base: "BTC" });
  const b2 = buy("1", "20000", { base: "BTC" });
  const w = withdrawal("BTC", "1");

  it("is not a sale: no realized P/L, flagged for review", () => {
    const p = scenario({ trades: [b1, b2], transfers: [w] }).position("BTC", "40000");
    expectDecimal(p.holdings, "1");
    expectKnown(p.realizedPnl, "0");
    expectKnown(p.currentValue, "40000");
    expectIncomplete(p.costBasis, "unresolved_transfer_out");
    expectIncomplete(p.totalPnl, "unresolved_transfer_out");
    expect(p.counts.unresolvedTransfersOut).toBe(1);
    expect(p.reviewRequired).toBe(true);
  });

  it("once the withdrawn lot is identified, its cost basis leaves with it", () => {
    const s = scenario({ trades: [b1, b2], transfers: [w], matches: [match(w, b1, "1")] });
    const al = s.engine.allocations[0]!;
    expect(al.kind).toBe("transfer_out");
    expect(al.realizedPnl).toBeNull();
    const p = s.position("BTC", "40000");
    expectKnown(p.realizedPnl, "0");
    expectKnown(p.costBasis, "20000");
    expectKnown(p.unrealizedPnl, "20000");
    expectKnown(p.totalPnl, "20000");
  });

  it("a withdrawal fee in the asset leaves the account too", () => {
    const p = scenario({ trades: [b1], transfers: [withdrawal("BTC", "0.5", { fee: "0.0005" })] }).position("BTC");
    expectDecimal(p.holdings, "0.4995");
  });
});

describe("#35 unknown cost basis mixed with known lots", () => {
  it("makes open-position metrics incomplete, never partially summed", () => {
    const b = buy("1", "30000", { base: "BTC" });
    const d = deposit("BTC", "1");
    const p = scenario({ trades: [b], transfers: [d] }).position("BTC", "40000");
    expectDecimal(p.holdings, "2");
    expectKnown(p.currentValue, "80000");
    expectIncomplete(p.costBasis, "unknown_cost_basis");
    expectIncomplete(p.averageCost, "unknown_cost_basis");
    expectIncomplete(p.unrealizedPnlPercent, "unknown_cost_basis");
  });

  it("an unknown-cost lot fully withdrawn no longer blocks metrics", () => {
    const b = buy("1", "30000", { base: "BTC" });
    const d = deposit("BTC", "1");
    const w = withdrawal("BTC", "1");
    const p = scenario({ trades: [b], transfers: [d, w], matches: [match(w, d, "1")] }).position("BTC", "40000");
    expectKnown(p.costBasis, "30000");
    expectKnown(p.unrealizedPnl, "10000");
    expectKnown(p.totalPnl, "10000");
  });
});

describe("#36 unmatched sells (spec §13)", () => {
  const l1 = buy("1000", "0.16");
  const l2 = buy("1000", "0.14");
  const l3 = buy("1000", "0.12");
  const x = sell("1000", "0.145");

  it("marks lot-dependent metrics pending but keeps independently known ones", () => {
    const p = scenario({ trades: [l1, l2, l3, x] }).position("ADA", "0.145");
    expectKnown(p.currentPrice, "0.145");
    expectDecimal(p.holdings, "2000");
    expectKnown(p.currentValue, "290");
    expectIncomplete(p.realizedPnl, "unmatched_sale");
    expectIncomplete(p.averageCost, "unmatched_sale");
    expectIncomplete(p.costBasis, "unmatched_sale");
    expectIncomplete(p.unrealizedPnl, "unmatched_sale");
    expect(p.counts.unmatchedSales).toBe(1);
    expect(p.reviewRequired).toBe(true);
  });

  it("total P/L is still known: it does not depend on lot assignment (145 + 290 − 420)", () => {
    const p = scenario({ trades: [l1, l2, l3, x] }).position("ADA", "0.145");
    expectKnown(p.totalPnl, "15");
  });

  it("never auto-assigns a lot (no silent FIFO/LIFO)", () => {
    const s = scenario({ trades: [l1, l2, l3, x] });
    expect(s.engine.allocations).toHaveLength(0);
    expect(s.engine.lots.every((l) => l.remainingQuantity.equals(l.originalQuantity))).toBe(true);
  });
});

describe("#37 partially unmatched sell", () => {
  it("stays pending until fully matched", () => {
    const a = buy("100", "20");
    const b = buy("100", "10");
    const x = sell("150", "13");
    const s = scenario({ trades: [a, b, x], matches: [match(x, a, "100")] });
    const state = s.engine.disposals[0]!;
    expect(state.status).toBe("partially_matched");
    expectDecimal(state.unmatchedQuantity, "50");
    const p = s.position("ADA", "13");
    expectIncomplete(p.realizedPnl, "unmatched_sale");
    expectIncomplete(p.costBasis, "unmatched_sale");
    expectKnown(p.totalPnl, "-400");
  });
});
