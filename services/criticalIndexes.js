const mongoose = require("mongoose");

const MODEL_NAMES = ["Team", "Fixture", "Standing", "PlayerStatistics", "Invoice", "Notification", "Order", "RegistrationRequest", "Attendance", "Parent", "Admin", "Cart", "CampSession", "EventRegistration", "MedicalProfile", "Category", "ProductCategory", "Wishlist"];
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const sameOptions = (left, right) => JSON.stringify(canonical(left || null)) === JSON.stringify(canonical(right || null));
const sameKey = (left, right) => JSON.stringify(Object.entries(left)) === JSON.stringify(Object.entries(right));

function criticalIndexRequirements() {
  return MODEL_NAMES.flatMap((name) => {
    const Model = require(`../models/${name}`);
    const collection = Model.collection.collectionName;
    const required = Model.schema.indexes().filter(([, options]) => options.unique || name === "RegistrationRequest").map(([key, options]) => ({ model: name, collection, key, options: Object.fromEntries(Object.entries(options).filter(([option]) => ["name", "unique", "sparse", "partialFilterExpression", "collation"].includes(option))) }));
    return required;
  });
}

function matchingIndex(requirement, actual) {
  return sameKey(requirement.key, actual.key) && (requirement.implicit || Boolean(actual.unique) === Boolean(requirement.options.unique)) && Boolean(actual.sparse) === Boolean(requirement.options.sparse) && sameOptions(actual.partialFilterExpression, requirement.options.partialFilterExpression) && sameOptions(actual.collation, requirement.options.collation);
}

async function indexesFor(connection, collection) {
  try { return await connection.db.collection(collection).indexes(); }
  catch (error) { if (error.code === 26) return []; throw error; }
}

function obsoleteTeamNameIndexes(indexes) {
  return indexes.filter((index) => index.unique && !index.key.term && Object.keys(index.key).length === 1 && (index.key.teamName || index.key.normalizedName)).map((index) => ({ name: index.name, key: index.key }));
}

async function inspectCriticalIndexes({ connection = mongoose.connection, requireBackfill = true } = {}) {
  if (!connection.db || connection.readyState !== 1) throw new Error("A connected database is required to verify integrity indexes.");
  const required = criticalIndexRequirements();
  const actual = new Map();
  for (const collection of new Set(required.map((index) => index.collection))) actual.set(collection, await indexesFor(connection, collection));
  const missing = required.filter((requirement) => !(actual.get(requirement.collection) || []).some((index) => matchingIndex(requirement, index))).map((requirement) => ({ model: requirement.model, collection: requirement.collection, key: requirement.key, options: requirement.options }));
  const obsolete = obsoleteTeamNameIndexes(actual.get(require("../models/Team").collection.collectionName) || []);
  let uncoveredTeams = 0, uncoveredFixtures = 0;
  if (requireBackfill) {
    const Team = require("../models/Team"), Fixture = require("../models/Fixture");
    uncoveredTeams = await connection.db.collection(Team.collection.collectionName).countDocuments({ $or: [{ term: { $not: { $type: "objectId" } } }, { normalizedName: { $not: { $type: "string" } } }, { normalizedName: "" }] });
    uncoveredFixtures = await connection.db.collection(Fixture.collection.collectionName).countDocuments({ $expr: { $or: [{ $ne: ["$participants", ["$homeTeam", "$awayTeam"]] }, { $eq: ["$homeTeam", "$awayTeam"] }] } });
  }
  return { ready: missing.length === 0 && obsolete.length === 0 && uncoveredTeams === 0 && uncoveredFixtures === 0, missing, obsoleteTeamNameIndexes: obsolete, uncoveredTeams, uncoveredFixtures };
}

async function assertCriticalIndexes(options = {}) {
  const report = await inspectCriticalIndexes(options);
  if (!report.ready) {
    const error = new Error(`Integrity prerequisites are missing: ${report.missing.length} indexes, ${report.uncoveredTeams} teams, ${report.uncoveredFixtures} fixtures, ${report.obsoleteTeamNameIndexes.length} obsolete global team-name indexes. Run the reviewed integrity migration in maintenance mode before starting the API.`);
    error.code = "INTEGRITY_INDEX_GATE";
    error.report = report;
    throw error;
  }
  return report;
}

// Explicit migration use only. Runtime startup calls assertCriticalIndexes, never this.
async function createCriticalIndexes({ connection = mongoose.connection } = {}) {
  for (const requirement of criticalIndexRequirements()) {
    if (requirement.implicit) {
      try { await connection.db.createCollection(requirement.collection); } catch (error) { if (error.code !== 48) throw error; }
    } else await connection.db.collection(requirement.collection).createIndex(requirement.key, requirement.options);
  }
}

module.exports = { criticalIndexRequirements, matchingIndex, indexesFor, obsoleteTeamNameIndexes, inspectCriticalIndexes, assertCriticalIndexes, createCriticalIndexes };
