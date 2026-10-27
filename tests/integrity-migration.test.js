const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { parseOptions, validateApply, main } = require("../scripts/migrate-integrity");
const { matchingIndex, criticalIndexRequirements } = require("../services/criticalIndexes");

test("migration CLI defaults to dry run and never implicitly selects application credentials", () => {
  assert.throws(() => parseOptions([], { MONGO_URI: "mongodb://production.invalid/app" }), /explicit MongoDB URI/);
  const options = parseOptions(["--uri-env", "TEST_MIGRATION_URI", "--database", "restored_app"], { TEST_MIGRATION_URI: "mongodb://127.0.0.1:12345/restored_app", MONGO_URI: "mongodb://production.invalid/app" });
  assert.equal(options.apply, false);
  assert.equal(options.uri, "mongodb://127.0.0.1:12345/restored_app");
  assert.equal(options.batchSize, 250);
  assert.throws(() => parseOptions(["--uri", "mongodb://local/app", "--uri-env", "OTHER", "--database", "app"], {}), /not both/);
});

test("apply is rejected before connection without actor, tested-backup and stopped-writer confirmations", async () => {
  const base = ["--uri", "mongodb://127.0.0.1:1/app", "--database", "app", "--apply"];
  assert.throws(() => parseOptions(base), /operator identity/);
  assert.throws(() => parseOptions([...base, "--actor", "release-operator"]), /backup/);
  assert.throws(() => parseOptions([...base, "--actor", "release-operator", "--backup-reference", "restored-backup", "--confirm-backup"]), /maintenance/);
  assert.doesNotThrow(() => validateApply({ apply: false }));
  await assert.rejects(main(base), { code: "MIGRATION_INPUT" });
  assert.equal(mongoose.connection.readyState, 0);
});

test("database selection and bounded batch size are explicit", () => {
  for (const database of ["", "admin", "config", "local", "unsafe/name"]) assert.throws(() => parseOptions(["--uri", "mongodb://local/app", "--database", database]), /database|required/);
  for (const batch of ["0", "1001", "1.5", "NaN"]) assert.throws(() => parseOptions(["--uri", "mongodb://local/app", "--database", "app", "--batch-size", batch]), /batch-size/);
});

test("runtime index gate validates uniqueness and partial scope, independently of index naming", () => {
  const requirement = { key: { term: 1, normalizedName: 1 }, options: { unique: true, partialFilterExpression: { term: { $type: "objectId" }, normalizedName: { $type: "string" } } } };
  assert.equal(matchingIndex(requirement, { key: requirement.key, name: "custom_safe_name", unique: true, partialFilterExpression: { normalizedName: { $type: "string" }, term: { $type: "objectId" } } }), true);
  assert.equal(matchingIndex(requirement, { key: requirement.key, unique: false, partialFilterExpression: requirement.options.partialFilterExpression }), false);
  assert.equal(matchingIndex(requirement, { key: requirement.key, unique: true, partialFilterExpression: { term: { $type: "objectId" } } }), false);
  assert.equal(matchingIndex(requirement, { key: { normalizedName: 1, term: 1 }, unique: true, partialFilterExpression: requirement.options.partialFilterExpression }), false);
});

test("required indexes cover enrollment, results, charges, delivery, checkout and attendance", () => {
  const required = criticalIndexRequirements();
  for (const model of ["Team", "Fixture", "Standing", "PlayerStatistics", "Invoice", "Counter", "DeliveryJob", "Notification", "Order", "RegistrationRequest", "Attendance", "Parent", "Admin"]) assert.ok(required.some((index) => index.model === model), model);
  assert.ok(required.some((index) => index.model === "Invoice" && index.key.chargeKey && index.options.unique));
  assert.ok(required.some((index) => index.model === "Fixture" && index.key.participants && index.options.unique));
});
