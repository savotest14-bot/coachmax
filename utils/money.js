const toMinorUnits = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER / 100) throw Object.assign(new Error("Amount must be a non-negative supported currency amount"), { status: 400 });
  return Math.round((amount + Number.EPSILON) * 100);
};
const currencyAmount = (value) => toMinorUnits(value) / 100;
module.exports = { toMinorUnits, currencyAmount };
