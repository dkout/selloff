// Pricing rules for the moving sale — the single source of truth.
// The server uses computeCartPrice() for authoritative cart totals and
// computeDisplayPricing() to send ready-to-display lot offers to the
// storefront, so the client never re-implements this math.

// Minimum available items for a lot deal to be offered at all.
const MIN_LOT_ITEMS = 2;

// Effective lot price = the better of the seller's set price and a guaranteed
// 10%-off-the-remaining-items price. A lot therefore always saves at least 10%
// and never costs more than the original set price.
function effectiveLotPrice(initial, availSum) {
  return Math.min(initial, Math.round(0.9 * availSum));
}

// Authoritative cart pricing. A category lot applies when every AVAILABLE item
// in that category is selected (and at least MIN_LOT_ITEMS remain). The full
// lot applies when every available non-excluded item is selected; excluded
// (bike) categories are still priced with their own lot rule on top, so one
// combined cart never costs more than the same items split across requests.
function computeCartPrice(catalog, itemIds, soldIds) {
  const sold = new Set(soldIds);
  const itemMap = new Map();
  const itemToCategory = new Map();
  for (const cat of catalog.categories) {
    for (const it of cat.items) {
      itemMap.set(it.id, it);
      itemToCategory.set(it.id, cat);
    }
  }

  // Sold/unknown items are never priced, even if a stale client sends them.
  const ids = new Set([...itemIds].filter(id => itemMap.has(id) && !sold.has(id)));

  const byCategory = new Map();
  for (const id of ids) {
    const cat = itemToCategory.get(id);
    if (!byCategory.has(cat.id)) byCategory.set(cat.id, []);
    byCategory.get(cat.id).push(id);
  }

  let total = 0;
  const lotsApplied = [];
  const lineItems = [];

  function priceCategory(catId, selectedIds) {
    const cat = itemToCategory.get(selectedIds[0]);
    const availItems = cat.items.filter(it => !sold.has(it.id));
    const availSum = availItems.reduce((a, b) => a + b.price, 0);
    const allAvailSelected = availItems.length > 0 && availItems.every(it => ids.has(it.id));
    if (allAvailSelected && availItems.length >= MIN_LOT_ITEMS && cat.lotPrice) {
      const lotPrice = effectiveLotPrice(cat.lotPrice, availSum);
      total += lotPrice;
      lotsApplied.push({ kind: 'category', categoryId: catId, label: `${cat.title} lot`, price: lotPrice });
      for (const id of selectedIds) {
        const it = itemMap.get(id);
        lineItems.push({ itemId: id, name: it.name, price: it.price, includedInLot: catId });
      }
    } else {
      for (const id of selectedIds) {
        const it = itemMap.get(id);
        total += it.price;
        lineItems.push({ itemId: id, name: it.name, price: it.price, includedInLot: null });
      }
    }
  }

  const fullLot = catalog.sale.fullLot;
  const excluded = new Set(fullLot.excludeCategoryIds);
  const availNonBike = [];
  for (const c of catalog.categories) {
    if (excluded.has(c.id)) continue;
    for (const it of c.items) if (!sold.has(it.id)) availNonBike.push(it);
  }
  const availNonBikeSum = availNonBike.reduce((a, b) => a + b.price, 0);
  const hasAllNonBike = availNonBike.length > 0 && availNonBike.every(it => ids.has(it.id));

  if (hasAllNonBike && availNonBike.length >= MIN_LOT_ITEMS) {
    const fullLotPrice = effectiveLotPrice(fullLot.price, availNonBikeSum);
    total += fullLotPrice;
    lotsApplied.push({ kind: 'full', label: fullLot.label, price: fullLotPrice });
    for (const it of availNonBike) {
      lineItems.push({ itemId: it.id, name: it.name, price: it.price, includedInLot: 'full' });
    }
    for (const [catId, selectedIds] of byCategory) {
      if (excluded.has(catId)) priceCategory(catId, selectedIds);
    }
    return { total, lotsApplied, lineItems };
  }

  for (const [catId, selectedIds] of byCategory) priceCategory(catId, selectedIds);
  return { total, lotsApplied, lineItems };
}

// Display pricing for the storefront: per-category lot offers and the
// whole-place bundle, computed against what's still available.
function computeDisplayPricing(catalog, soldIds) {
  const sold = new Set(soldIds);

  const categories = {};
  for (const cat of catalog.categories) {
    const avail = cat.items.filter(it => !sold.has(it.id));
    const availSum = avail.reduce((a, b) => a + b.price, 0);
    const offered = Boolean(cat.lotPrice) && avail.length >= MIN_LOT_ITEMS;
    const price = offered ? effectiveLotPrice(cat.lotPrice, availSum) : null;
    categories[cat.id] = {
      offered,
      price,
      availableSum: availSum,
      savings: offered ? availSum - price : 0,
    };
  }

  const fullLot = catalog.sale.fullLot;
  const excluded = new Set(fullLot.excludeCategoryIds);
  let availCount = 0;
  let availSum = 0;
  for (const c of catalog.categories) {
    if (excluded.has(c.id)) continue;
    for (const it of c.items) if (!sold.has(it.id)) { availCount++; availSum += it.price; }
  }
  const offered = availCount >= MIN_LOT_ITEMS;
  const price = offered ? effectiveLotPrice(fullLot.price, availSum) : null;

  return {
    categories,
    fullLot: {
      offered,
      price,
      availableSum: availSum,
      savings: offered ? availSum - price : 0,
    },
  };
}

module.exports = { MIN_LOT_ITEMS, effectiveLotPrice, computeCartPrice, computeDisplayPricing };
