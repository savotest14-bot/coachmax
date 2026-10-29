const mongoose = require("mongoose");
const User = require("../models/User");
const Class = require("../models/Class");
const Term = require("../models/Term");
const Program = require("../models/Program");
const Category = require("../models/Category");
const RegistrationRequest = require("../models/RegistrationRequest");
const AuditLog = require("../models/AuditLog");
const { dateOnly, todayDateOnly } = require("../utils/dateTime");

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const id = (value) => String(value?._id || value || "");
const sameIds = (left = [], right = []) => left.length === right.length && [...left].map(id).sort().every((value, index) => value === [...right].map(id).sort()[index]);
const PAYMENT_STATUSES = ["TRIAL", "UNPAID", "PAID", "EXTRA", "SUBSTITUTE", "TBC", "HANDSHAKE"];

function validateEnrollmentInput({ playerId, registrationRequestId, classIds, paymentStatus }) {
  if (!mongoose.isValidObjectId(playerId) || (registrationRequestId && !mongoose.isValidObjectId(registrationRequestId))) throw fail(400, "Valid player and registration request IDs are required");
  if (!Array.isArray(classIds) || !classIds.length || classIds.length > 20 || classIds.some((value) => !mongoose.isValidObjectId(value))) throw fail(400, "Select between 1 and 20 valid classes");
  if (new Set(classIds.map(id)).size !== classIds.length) throw fail(400, "A class may only be selected once");
  if (!PAYMENT_STATUSES.includes(paymentStatus)) throw fail(400, "Select an explicit valid payment status");
}

// Only interpret explicit U-group constraints; free-form program descriptions
// are not treated as age rules. A future form can expose structured min/max U.
function validateEligibility(player, program, category, termYear) {
  const birth = dateOnly(player.dob, "dob");
  const group = birth ? Number(termYear) - Number(birth.slice(0, 4)) : null;
  const range = String(program.ageGroup || category.ageRange || "").trim().match(/^U?(\d{1,2})(?:\s*(?:-|–|to)\s*U?(\d{1,2}))?$/i);
  if (range && (group == null || group < Number(range[1]) || group > Number(range[2] || range[1]))) throw fail(409, "Player is outside the selected term's program U group");
  if ((category.genderRestriction === "BOYS" && player.gender !== "MALE") || (category.genderRestriction === "GIRLS" && player.gender !== "FEMALE")) throw fail(409, "Player does not meet this category's eligibility rules");
}

function createEnrollmentService(deps = {}) {
  const models = { User, Class, Term, Program, Category, RegistrationRequest, AuditLog, ...deps.models };
  const invoice = deps.generateClassInvoice || ((command) => require("./invoiceService").generateClassInvoice(command));
  const queueNotification = deps.queueNotification || ((...args) => require("./deliveryService").queueNotification(...args));
  const startSession = deps.startSession || (() => mongoose.startSession());
  return async function enrollPlayer(command, actor) {
    validateEnrollmentInput(command);
    if (!actor || !["SUPER_ADMIN", "ADMIN"].includes(actor.role)) throw fail(403, "Only an administrator can approve and allocate players");
    const { playerId, registrationRequestId, classIds, paymentStatus } = command;
    const overrideReason = String(command.overrideReason || "").trim();
    const hasOverride = command.overrideEligibility === true && overrideReason.length >= 10;
    if (command.overrideEligibility && !hasOverride) throw fail(400, "An eligibility override requires a reason of at least 10 characters");
    const session = await startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const player = await models.User.findById(playerId).session(session);
        if (!player) throw fail(404, "Player not found");
        if (player.isBlocked) throw fail(409, "A blocked player cannot be enrolled");
        player.assignedClasses = player.assignedClasses || [];
        player.classPaymentStatuses = player.classPaymentStatuses || [];
        player.programs = player.programs || [];
        player.categories = player.categories || [];
        let request = registrationRequestId ? await models.RegistrationRequest.findById(registrationRequestId).session(session) : null;
        if (registrationRequestId && !request) throw fail(404, "Registration request not found");
        if (request && (id(request.player) !== id(playerId) || id(request.parent) !== id(player.parentId))) throw fail(400, "Registration request does not belong to this player and parent");
        if (request && request.status !== "PENDING") {
          if (["APPROVED", "COMPLETED"].includes(request.status) && sameIds(request.allocatedClasses, classIds) && request.allocationPaymentStatus === paymentStatus) {
            result = { player, registrationRequest: request, repeated: true, selectedClasses: [] };
            return;
          }
          throw fail(409, "This request was already resolved. Refresh the verification queue.");
        }
        if (!request) {
          // Do not silently resolve whichever pending request happens to be last.
          const pending = await models.RegistrationRequest.find({ player: playerId, status: "PENDING" }).session(session);
          if (pending.length === 1) request = pending[0];
          else if (pending.length > 1) throw fail(409, "Select the registration request to approve; this player has multiple pending requests");
        }
        const classes = await models.Class.find({ _id: { $in: classIds } }).session(session);
        if (classes.length !== classIds.length) throw fail(404, "One or more selected classes no longer exist");
        const alreadyAssignedClass = classes.find((cls) =>
          (player.assignedClasses || []).some((value) => id(value) === id(cls._id))
          || (cls.players || []).some((value) => id(value) === id(playerId))
        );
        if (alreadyAssignedClass) throw fail(409, `Player is already enrolled in ${alreadyAssignedClass.name}. Select a different class.`);
        const termId = id(classes[0].term);
        if (classes.some((cls) => id(cls.term) !== termId)) throw fail(400, "All selected classes must belong to the same term");
        const term = await models.Term.findById(termId).session(session);
        if (!term || term.status === "COMPLETED" || dateOnly(term.endDate) < todayDateOnly()) throw fail(409, "The selected term is completed or unavailable");
        if (request?.preferredTerm && id(request.preferredTerm) !== termId && !hasOverride) throw fail(409, "Selected class is outside the requested term. An explicit eligibility override with reason is required.");
        for (const cls of classes) {
          if (cls.status !== "ACTIVE") throw fail(409, `Class ${cls.name} is inactive`);
          const program = await models.Program.findById(cls.program).session(session);
          const category = await models.Category.findById(cls.category).session(session);
          if (!program || !category || program.status !== "ACTIVE" || id(program.category) !== id(cls.category)) throw fail(409, `Class ${cls.name} has an unavailable program or category`);
          if (!hasOverride) validateEligibility(player, program, category, term.year);
          const existingPayment = (player.classPaymentStatuses || []).find((entry) => id(entry.class) === id(cls._id));
          const existing = (player.assignedClasses || []).some((value) => id(value) === id(cls._id));
          if (paymentStatus === "PAID" && existingPayment?.paymentStatus !== "PAID") throw fail(409, "A new enrollment cannot be marked PAID. Record and approve its payment first.");
          if (existing && existingPayment && existingPayment.paymentStatus !== paymentStatus) throw fail(409, "Player is already enrolled with a different payment status. Use the payment workflow to change it.");
          // Every allocation writes the same class document. Together with a
          // transaction this serializes concurrent reservations and capacity.
          const alreadyInRoster = (cls.players || []).some((value) => id(value) === id(playerId));
          const capacityFilter = alreadyInRoster ? {} : { $or: [ { capacity: { $exists: false } }, { capacity: null }, { capacity: { $lte: 0 } }, { $expr: { $lt: [{ $size: { $ifNull: ["$players", []] } }, "$capacity"] } } ] };
          const reservation = await models.Class.updateOne({ _id: cls._id, status: "ACTIVE", ...capacityFilter }, { $addToSet: { players: player._id }, $inc: { __v: 1 } }, { session });
          if (!reservation.matchedCount) throw fail(409, `Class ${cls.name} is full. Select another class.`);
          if (!existing) player.assignedClasses.push(cls._id);
          if (!existingPayment) player.classPaymentStatuses.push({ class: cls._id, paymentStatus });
          if (!player.programs.some((value) => id(value) === id(cls.program))) player.programs.push(cls.program);
          if (!player.categories.some((value) => id(value) === id(cls.category))) player.categories.push(cls.category);
        }
        player.removedClasses = (player.removedClasses || []).filter((value) => !classIds.map(id).includes(id(value)));
        player.term = term._id;
        player.category = classes[0].category;
        player.playerStatus = "ACTIVE";
        if (request) {
          request.status = "APPROVED";
          request.allocatedClasses = classIds;
          request.allocationPaymentStatus = paymentStatus;
          request.assignedBy = actor._id;
          request.assignedAt = new Date();
          request.overrideReason = hasOverride ? overrideReason : "";
          await request.save({ session });
        }
        player.hasPendingRequest = (await models.RegistrationRequest.countDocuments({ player: playerId, status: "PENDING" }).session(session)) > 0;
        await player.save({ session });
        if (paymentStatus === "UNPAID") {
          for (const cls of classes) {
            const generated = await invoice({ userId: player._id, classId: cls._id, session, idempotencyKey: `class:${player._id}:${cls._id}` });
            if (generated.error) throw fail(409, generated.error);
          }
        }
        await models.AuditLog.create([{ user: actor._id, userRole: actor.role, action: "PLAYER_ALLOCATED", entityType: "User", entityId: player._id, oldValue: null, newValue: { requestId: request?._id, classIds, termId, paymentStatus, overrideReason: hasOverride ? overrideReason : "" }, description: "Player approved and allocated through canonical enrollment" }], { session });
        await queueNotification(`enrollment:${request?._id || `${player._id}:${classIds.map(id).sort().join(":")}`}`, {
          recipientType: "PARENT", parentId: player.parentId,
          title: "Player Enrollment Completed", message: `${player.fullName} has been enrolled in ${classes.map((cls) => cls.name).join(", ")}. Payment status: ${paymentStatus}.`,
          type: "PLAYER_ALLOCATED", data: { playerId: id(player), requestId: id(request), classIds: classIds.map(id), termId, paymentStatus },
        }, session);
        result = { player, registrationRequest: request, selectedClasses: classes, term, repeated: false };
      });
      return result;
    } finally { await session.endSession(); }
  };
}

module.exports = { enrollPlayer: createEnrollmentService(), createEnrollmentService, validateEnrollmentInput, validateEligibility, sameIds };
