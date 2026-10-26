const PAYMENT_STATUS_ALIASES = Object.freeze({
  "APPROVED (UNPAID)": "UNPAID",
  APPROVED_UNPAID: "UNPAID",
  APPROVED: "PAID",
  ACTIVE: "PAID",
  OVERDUE: "UNPAID",
  OVER_DUE: "UNPAID",
  "OVER-DUE": "UNPAID",
  PAYMENT_PENDING: "UNPAID",
  FAILED: "UNPAID",
  REFUNDED: "UNPAID",
  OTHERS: "EXTRA",
  SUBSTITUTE: "EXTRA",
});

// Keep the order shared by player, class, team, event, and league views.
// Unknown values are intentionally placed last so old data remains visible.
const PAYMENT_STATUS_RANK = Object.freeze({
  PAID: 0,
  UNPAID: 1,
  HANDSHAKE: 2,
  TRIAL: 3,
  TBC: 4,
  EXTRA: 5,
});

const normalizePaymentStatus = (value, fallback = "UNPAID") => {
  const raw = value === undefined || value === null ? "" : String(value);
  const upper = raw.trim().replace(/\s+/g, " ").toUpperCase();
  if (!upper) return fallback;

  const normalized = PAYMENT_STATUS_ALIASES[upper] || upper;
  return normalized;
};

const getPaymentStatusRank = (value) => {
  const normalized = normalizePaymentStatus(value);
  return PAYMENT_STATUS_RANK[normalized] ?? 99;
};

const getPlayerDisplayName = (player) => {
  if (!player) return "";
  const source = player.player && typeof player.player === "object" ? player.player : player;
  return String(
    source.fullName ||
    [source.firstName, source.lastName].filter(Boolean).join(" ") ||
    source.name ||
    ""
  ).trim();
};

const comparePlayersByPaymentStatus = (left, right) => {
  const rankDifference =
    getPaymentStatusRank(left?.paymentStatus) - getPaymentStatusRank(right?.paymentStatus);
  if (rankDifference !== 0) return rankDifference;

  const nameDifference = getPlayerDisplayName(left).localeCompare(
    getPlayerDisplayName(right),
    undefined,
    { sensitivity: "base" }
  );
  if (nameDifference !== 0) return nameDifference;

  return String(left?.playerId || left?.player?._id || left?._id || "").localeCompare(
    String(right?.playerId || right?.player?._id || right?._id || "")
  );
};

// MongoDB expression used where the API paginates before returning results.
const paymentStatusRankExpression = (statusExpression) => ({
  $switch: {
    branches: [
      ...Object.entries(PAYMENT_STATUS_RANK),
      ...Object.entries(PAYMENT_STATUS_ALIASES).map(([alias, canonical]) => [
        alias,
        PAYMENT_STATUS_RANK[canonical],
      ]),
    ].map(([status, rank]) => ({
      case: { $eq: [statusExpression, status] },
      then: rank,
    })),
    default: 99,
  },
});

module.exports = {
  PAYMENT_STATUS_ALIASES,
  PAYMENT_STATUS_RANK,
  normalizePaymentStatus,
  getPaymentStatusRank,
  getPlayerDisplayName,
  comparePlayersByPaymentStatus,
  paymentStatusRankExpression,
};
