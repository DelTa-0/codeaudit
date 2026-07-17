export function helper() {
  return "hello";
}

export function calculateLegacyDiscount(amount) {
  // references a feature flag that no longer exists
  return amount * 0.9;
}

export function zombieFormatter(value) {
  return String(value).trim();
}
