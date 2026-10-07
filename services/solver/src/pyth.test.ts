import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ETH_USD_FEED_ID,
  PRICE_UPDATE_V2_DISCRIMINATOR,
  SOL_USD_FEED_ID,
  decodePriceUpdateV2,
  parseUsd18,
  pickPrice,
  toUsd18,
} from "./pyth";
import { encodePriceUpdateV2 } from "./testutil";

const priceUpdate = encodePriceUpdateV2;

test("PriceUpdateV2 discriminator is sha256('account:PriceUpdateV2')[..8]", () => {
  assert.deepEqual([...PRICE_UPDATE_V2_DISCRIMINATOR], [34, 241, 35, 99, 157, 126, 244, 205]);
});

test("decodes Full and Partial verification levels", () => {
  for (const partial of [false, true]) {
    const p = decodePriceUpdateV2(
      priceUpdate({ partial, feedId: SOL_USD_FEED_ID, price: 15_012_345_678n, expo: -8, publishTime: 1_700_000_000n }),
    );
    assert.equal(p.verification, partial ? "partial" : "full");
    assert.equal(p.feedId, SOL_USD_FEED_ID);
    assert.equal(p.price, 15_012_345_678n);
    assert.equal(p.conf, 12345n);
    assert.equal(p.exponent, -8);
    assert.equal(p.publishTime, 1_700_000_000n);
    assert.equal(p.emaPrice, 15_012_345_673n);
    assert.equal(p.postedSlot, 424242n);
  }
});

test("rejects a wrong discriminator and an unknown enum tag", () => {
  const good = priceUpdate({ feedId: ETH_USD_FEED_ID, price: 1n, expo: -8, publishTime: 0n });
  const badDisc = good.slice();
  badDisc[0] ^= 1;
  assert.throws(() => decodePriceUpdateV2(badDisc), /not a Pyth/);
  const badTag = good.slice();
  badTag[40] = 2;
  assert.throws(() => decodePriceUpdateV2(badTag), /verification level/);
});

test("toUsd18 and parseUsd18", () => {
  assert.equal(toUsd18({ price: 15_012_345_678n, exponent: -8 }), 150_123_456_780_000_000_000n);
  assert.equal(toUsd18({ price: 3n, exponent: 2 }), 300n * 10n ** 18n);
  assert.equal(parseUsd18("150.1234"), 150_123_400_000_000_000_000n);
  assert.equal(parseUsd18("3000"), 3000n * 10n ** 18n);
  assert.throws(() => parseUsd18("-1"));
});

test("pickPrice: fresh Pyth wins, stale or missing falls back, no fallback gives null", () => {
  const raw = priceUpdate({ feedId: SOL_USD_FEED_ID, price: 15_000_000_000n, expo: -8, publishTime: 1_000n });
  const fb = parseUsd18("140");
  const fresh = pickPrice(raw, SOL_USD_FEED_ID, 1_100n, 3_600n, fb)!;
  assert.equal(fresh.source, "pyth");
  assert.equal(fresh.usd18, parseUsd18("150"));
  assert.equal(fresh.warning, undefined);

  const stale = pickPrice(raw, SOL_USD_FEED_ID, 10_000n, 3_600n, fb)!;
  assert.equal(stale.source, "fallback");
  assert.match(stale.warning!, /stale/);

  assert.equal(pickPrice(null, SOL_USD_FEED_ID, 0n, 60n, undefined), null);
  const wrongFeed = pickPrice(raw, ETH_USD_FEED_ID, 1_100n, 3_600n, undefined)!;
  assert.equal(wrongFeed.source, "pyth");
  assert.match(wrongFeed.warning!, /feed id/);
});
