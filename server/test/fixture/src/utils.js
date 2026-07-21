import { Sequelize } from "sequelize";

// `pg` is declared but never imported directly — Sequelize requires it
// internally based on `dialect: "postgres"`, invisible to static analysis.
export const db = new Sequelize({ dialect: "postgres" });

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

// Exported but only ever called from within this same file — must not be
// flagged dead just because it's `export`ed (the JS analog of the Python
// same-file rescue).
export function formatTag(value) {
  return `<${value}>`;
}

export function renderTag(value) {
  return formatTag(value);
}
