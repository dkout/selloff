const test = require('node:test');
const assert = require('node:assert/strict');
const { MIN_LOT_ITEMS, effectiveLotPrice, computeCartPrice, computeDisplayPricing } = require('../lib/pricing');

// Small controlled catalog: 'x' is the excluded ("bike") category.
const fixture = {
  sale: {
    fullLot: { price: 100, label: 'everything (excl. x)', excludeCategoryIds: ['x'] },
  },
  categories: [
    { id: 'a', title: 'A', lotPrice: 50, items: [{ id: 'a1', name: 'A1', price: 30 }, { id: 'a2', name: 'A2', price: 40 }] },
    { id: 'b', title: 'B', lotPrice: 90, items: [{ id: 'b1', name: 'B1', price: 60 }, { id: 'b2', name: 'B2', price: 60 }] },
    { id: 'x', title: 'X', lotPrice: 80, items: [{ id: 'x1', name: 'X1', price: 50 }, { id: 'x2', name: 'X2', price: 60 }] },
  ],
};
const realCatalog = require('../data/items.json');
const idsOf = (catalog, pred = () => true) =>
  catalog.categories.filter(pred).flatMap(c => c.items.map(i => i.id));

test('effectiveLotPrice is the better of set price and 10% off', () => {
  assert.equal(effectiveLotPrice(50, 70), 50);    // set price wins
  assert.equal(effectiveLotPrice(90, 70), 63);    // 90% cap wins
  assert.equal(effectiveLotPrice(100, 111), 100); // round() applied: 99.9 -> 100
});

test('empty cart prices to zero', () => {
  assert.deepEqual(computeCartPrice(fixture, [], []), { total: 0, lotsApplied: [], lineItems: [] });
});

test('single item is priced individually', () => {
  const r = computeCartPrice(fixture, ['a1'], []);
  assert.equal(r.total, 30);
  assert.equal(r.lotsApplied.length, 0);
});

test('full category selection gets the category lot', () => {
  const r = computeCartPrice(fixture, ['a1', 'a2'], []);
  assert.equal(r.total, 50);
  assert.deepEqual(r.lotsApplied.map(l => l.kind), ['category']);
});

test('lot not offered when fewer than MIN_LOT_ITEMS remain', () => {
  // a2 sold: only one item left in 'a', so no lot even though all of it is selected
  const r = computeCartPrice(fixture, ['a1', 'a2'], ['a2']);
  assert.equal(r.total, 30);
  assert.equal(r.lotsApplied.length, 0);
  assert.ok(MIN_LOT_ITEMS >= 2);
});

test('sold and unknown ids are never priced', () => {
  const r = computeCartPrice(fixture, ['a1', 'a2', 'nope'], ['a1']);
  assert.equal(r.total, 40); // only a2
  assert.ok(r.lineItems.every(li => li.itemId !== 'a1' && li.itemId !== 'nope'));
});

test('category lot tracks 90% of remaining items as things sell', () => {
  // b1 sold leaves only b2 -> no lot; nothing sold -> lot 90
  assert.equal(computeCartPrice(fixture, ['b1', 'b2'], []).total, 90);
  assert.equal(computeCartPrice(fixture, ['b2'], ['b1']).total, 60);
});

test('all non-excluded items trigger the full lot', () => {
  const r = computeCartPrice(fixture, ['a1', 'a2', 'b1', 'b2'], []);
  assert.equal(r.total, 100);
  assert.deepEqual(r.lotsApplied.map(l => l.kind), ['full']);
  assert.ok(r.lineItems.every(li => li.includedInLot === 'full'));
});

test('full lot still applies when some non-excluded items are sold', () => {
  const r = computeCartPrice(fixture, ['a1', 'b1', 'b2'], ['a2']);
  // remaining non-x items sum 150 -> min(100, 135) = 100
  assert.equal(r.total, 100);
  assert.equal(r.lotsApplied[0].kind, 'full');
});

test('REGRESSION: excluded categories get their lot on top of the full lot', () => {
  const everything = computeCartPrice(fixture, ['a1', 'a2', 'b1', 'b2', 'x1', 'x2'], []);
  assert.equal(everything.total, 100 + 80); // full lot + x lot, NOT x at 110 individual
  assert.deepEqual(everything.lotsApplied.map(l => l.kind).sort(), ['category', 'full']);
});

test('INVARIANT: one combined cart never costs more than split carts (real catalog)', () => {
  const bikeCatIds = new Set(realCatalog.sale.fullLot.excludeCategoryIds);
  const allIds = idsOf(realCatalog);
  const bikeIds = idsOf(realCatalog, c => bikeCatIds.has(c.id));
  const nonBikeIds = idsOf(realCatalog, c => !bikeCatIds.has(c.id));

  const combined = computeCartPrice(realCatalog, allIds, []).total;
  const split = computeCartPrice(realCatalog, bikeIds, []).total
    + computeCartPrice(realCatalog, nonBikeIds, []).total;
  assert.equal(combined, split);

  // and per-category splits never beat the combined cart either
  let perCategory = 0;
  for (const c of realCatalog.categories) {
    perCategory += computeCartPrice(realCatalog, c.items.map(i => i.id), []).total;
  }
  assert.ok(combined <= perCategory, `combined ${combined} > per-category ${perCategory}`);
});

test('real catalog sanity: full lot price and bike lots', () => {
  const r = computeCartPrice(realCatalog, idsOf(realCatalog), []);
  const labels = r.lotsApplied.map(l => l.label).sort();
  assert.equal(r.lotsApplied.find(l => l.kind === 'full').price, 3380);
  assert.ok(labels.includes('Bicycle (racing) lot'));
  assert.ok(labels.includes('Bicycle (commuting) lot'));
});

test('display pricing mirrors cart pricing and availability', () => {
  const d = computeDisplayPricing(fixture, ['b1']);
  assert.equal(d.categories.a.offered, true);
  assert.equal(d.categories.a.price, 50);
  assert.equal(d.categories.a.savings, 20);
  assert.equal(d.categories.b.offered, false); // one item left
  assert.equal(d.categories.b.price, null);
  // full lot over remaining a1,a2,b2 = 130 -> min(100, 117) = 100
  assert.equal(d.fullLot.offered, true);
  assert.equal(d.fullLot.price, 100);
  assert.equal(d.fullLot.availableSum, 130);
});

test('display pricing withdraws the full lot below MIN_LOT_ITEMS', () => {
  const d = computeDisplayPricing(fixture, ['a1', 'a2', 'b1']);
  assert.equal(d.fullLot.offered, false);
  assert.equal(d.fullLot.price, null);
});
