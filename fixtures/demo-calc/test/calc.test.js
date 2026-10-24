const assert = require('node:assert/strict');
const { calculateDiscount } = require('../src/calc');

// Test case: calculateDiscount should return numeric discount amount
function testCalculateDiscount() {
  const discount = calculateDiscount(100, 20);
  assert.equal(discount, 20);
}

testCalculateDiscount();
