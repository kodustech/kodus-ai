function ran(a) {
  return a + 1;
}

function never(b) {
  const c = b * 2;
  return c;
}

module.exports = { ran, never };
ran(1);
