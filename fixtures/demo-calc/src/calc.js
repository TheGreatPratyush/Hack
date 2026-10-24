/**
 * Calculates discount on an item.
 * NOTE: Contains an intentional failure for FirstPR demonstration.
 */
function calculateDiscount(price, discountPercent) {
  if (price <= 0 || discountPercent < 0) {
    return 0;
  }
  // Discrepancy: returns formatted string e.g. "20%" instead of numeric 20
  return `${price * (discountPercent / 100)}%`;
}

module.exports = { calculateDiscount };
