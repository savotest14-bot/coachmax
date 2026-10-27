const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeMedicalStatus } = require("../utils/medicalStatus");
const { createEnrollmentService, validateEnrollmentInput, validateEligibility } = require("../services/enrollmentService");

const ids = { player: "111111111111111111111111", parent: "222222222222222222222222", request: "333333333333333333333333", otherRequest: "333333333333333333333334", class: "444444444444444444444444", term: "555555555555555555555555", program: "666666666666666666666666", category: "777777777777777777777777", admin: "888888888888888888888888" };
const actor = { _id: ids.admin, role: "SUPER_ADMIN" };
const command = { playerId: ids.player, registrationRequestId: ids.request, classIds: [ids.class], paymentStatus: "UNPAID" };

function harness(options = {}) {
  let state = {
    player: { _id: ids.player, parentId: ids.parent, fullName: "Test player", dob: "2015-10-30", gender: "MALE", assignedClasses: [], programs: [], categories: [], classPaymentStatuses: [], hasPendingRequest: true, playerStatus: "PENDING_APPROVAL" },
    requests: [{ _id: ids.request, player: ids.player, parent: ids.parent, status: "PENDING", preferredTerm: ids.term, allocatedClasses: [] }, { _id: ids.otherRequest, player: ids.player, parent: ids.parent, status: "PENDING", preferredTerm: ids.term, allocatedClasses: [] }],
    classes: [{ _id: ids.class, name: "U12 development", term: ids.term, program: ids.program, category: ids.category, status: "ACTIVE", capacity: 1, players: [] }],
    invoices: [], audits: [], deliveries: [],
  };
  const chain = (value) => ({ session: async () => value });
  const doc = (data, save) => data ? Object.assign(structuredClone(data), { save: async function () { const { save: ignored, ...raw } = this; save(structuredClone(raw)); return this; } }) : null;
  const requestDoc = (data) => doc(data, (saved) => { state.requests = state.requests.map((request) => request._id === saved._id ? saved : request); });
  const models = {
    User: { findById: () => chain(doc(state.player, (saved) => { state.player = saved; })) },
    RegistrationRequest: {
      findById: (requestId) => chain(requestDoc(state.requests.find((request) => request._id === requestId))),
      find: () => chain(state.requests.filter((request) => request.status === "PENDING").map(requestDoc)),
      countDocuments: () => chain(state.requests.filter((request) => request.status === "PENDING").length),
    },
    Class: {
      find: () => chain(structuredClone(state.classes)),
      updateOne: async (filter, update) => {
        const cls = state.classes.find((entry) => entry._id === filter._id);
        if (!cls || (filter.$or && cls.players.length >= cls.capacity)) return { matchedCount: 0 };
        if (!cls.players.includes(update.$addToSet.players)) cls.players.push(update.$addToSet.players);
        return { matchedCount: 1 };
      },
    },
    Term: { findById: () => chain({ _id: ids.term, year: 2027, status: "UPCOMING", endDate: "2099-12-31" }) },
    Program: { findById: () => chain({ _id: ids.program, status: "ACTIVE", category: ids.category, ageGroup: "U12" }) },
    Category: { findById: () => chain({ _id: ids.category, genderRestriction: "COED" }) },
    AuditLog: { create: async (entries) => state.audits.push(...entries) },
  };
  let ended = 0;
  const enroll = createEnrollmentService({
    models,
    startSession: async () => ({ withTransaction: async (callback) => { const previous = structuredClone(state); try { await callback(); } catch (error) { state = previous; throw error; } }, endSession: async () => { ended += 1; } }),
    generateClassInvoice: async (input) => {
      assert.ok(input.session, "invoice participates in the enrollment transaction");
      if (options.invoiceError) return { error: "Billing unavailable" };
      state.invoices.push(input.idempotencyKey);
      return { invoice: { _id: "test-invoice" } };
    },
    queueNotification: async (key, payload, session) => { assert.ok(session); state.deliveries.push({ key, payload }); },
  });
  return { enroll, state: () => state, ended: () => ended };
}

test("negative medical text does not set an alert; explicit YES requires meaningful details", () => {
  for (const text of ["None", "No medical conditions", "NONE.", "N/A", " no "]) assert.equal(normalizeMedicalStatus({ medicalConditions: text }).isMedicalCondition, false);
  assert.equal(normalizeMedicalStatus({ isMedicalCondition: false, medicalConditions: "Old condition" }).medicalConditionDetails, "");
  assert.throws(() => normalizeMedicalStatus({ isMedicalCondition: true, medicalConditions: "None" }), /provide details/);
  assert.throws(() => normalizeMedicalStatus({ isMedicalCondition: "maybe" }), /YES or NO/);
  assert.throws(() => normalizeMedicalStatus({ isMedicalCondition: true, medicalConditionDetails: { value: "Asthma" } }), /must be text/);
  assert.throws(() => normalizeMedicalStatus({ isMedicalCondition: false, allergies: ["Peanuts"] }), /Select YES/);
  assert.deepEqual(normalizeMedicalStatus({ isMedicalCondition: true, medicalConditions: "Asthma", allergies: ["None", "Peanuts"] }).allergies, ["Peanuts"]);
});

test("allocation validates duplicate IDs and explicit payment state", () => {
  assert.throws(() => validateEnrollmentInput({ ...command, classIds: [ids.class, ids.class] }), /once/);
  assert.throws(() => validateEnrollmentInput({ ...command, paymentStatus: undefined }), /explicit/);
  assert.throws(() => validateEnrollmentInput({ ...command, playerId: "invalid" }), /Valid player/);
});

test("eligibility uses selected term year, never exact birthday", () => {
  assert.doesNotThrow(() => validateEligibility({ dob: "2015-10-30", gender: "MALE" }, { ageGroup: "U11" }, { genderRestriction: "COED" }, 2026));
  assert.throws(() => validateEligibility({ dob: "2015-10-30", gender: "MALE" }, { ageGroup: "U11" }, { genderRestriction: "COED" }, 2027), /U group/);
});

test("canonical allocation completes only the selected request, preserves other pending requests and is retry-safe", async () => {
  const h = harness();
  const first = await h.enroll(command, actor);
  assert.equal(first.repeated, false);
  assert.equal(h.state().requests[0].status, "APPROVED");
  assert.equal(h.state().requests[1].status, "PENDING");
  assert.equal(h.state().player.hasPendingRequest, true);
  assert.deepEqual(h.state().player.assignedClasses, [ids.class]);
  assert.deepEqual(h.state().classes[0].players, [ids.player]);
  assert.equal(h.state().invoices.length, 1);
  const retry = await h.enroll(command, actor);
  assert.equal(retry.repeated, true);
  assert.equal(h.state().invoices.length, 1);
  assert.equal(h.state().audits.length, 1);
  assert.equal(h.state().deliveries.length, 1);
  assert.equal(h.ended(), 2);
});

test("invoice failures roll back request, roster, player and audit together", async () => {
  const h = harness({ invoiceError: true });
  await assert.rejects(h.enroll(command, actor), /Billing unavailable/);
  assert.equal(h.state().requests[0].status, "PENDING");
  assert.deepEqual(h.state().classes[0].players, []);
  assert.deepEqual(h.state().player.assignedClasses, []);
  assert.equal(h.state().audits.length, 0);
  assert.equal(h.ended(), 1);
});

test("allocation rejects full classes, parent mismatch, missing request identity, unpaid-to-paid shortcuts and non-admins", async () => {
  const full = harness(); full.state().classes[0].players = ["someone-else"];
  await assert.rejects(full.enroll(command, actor), /full/);
  const mismatch = harness(); mismatch.state().requests[0].parent = "another-parent";
  await assert.rejects(mismatch.enroll(command, actor), /does not belong/);
  const multiple = harness();
  await assert.rejects(multiple.enroll({ ...command, registrationRequestId: undefined }, actor), /multiple pending/);
  const paid = harness();
  await assert.rejects(paid.enroll({ ...command, paymentStatus: "PAID" }, actor), /Record and approve/);
  await assert.rejects(harness().enroll(command, { ...actor, role: "COACH" }), /administrator/);
});

test("request term exceptions require explicit reason and are audited", async () => {
  const h = harness(); h.state().requests[0].preferredTerm = "999999999999999999999999";
  await assert.rejects(h.enroll(command, actor), /outside the requested term/);
  await assert.rejects(h.enroll({ ...command, overrideEligibility: true, overrideReason: "short" }, actor), /10 characters/);
  await h.enroll({ ...command, overrideEligibility: true, overrideReason: "Approved by head coach after assessment" }, actor);
  assert.match(h.state().audits[0].newValue.overrideReason, /head coach/);
});
