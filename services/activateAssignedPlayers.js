const RegistrationRequest = require("../models/RegistrationRequest");
const User = require("../models/User");

/**
 * Activate assigned players and resolve only the request fulfilled by this
 * assignment. Keep unrelated pending class/program requests in the queue.
 */
async function activateAssignedPlayers(playerIds, options = {}) {
  const ids = [...new Set((playerIds || []).filter(Boolean).map((value) => String(value._id || value)))];
  if (!ids.length) return;

  const sessionOptions = options.session ? { session: options.session } : {};
  const assignedAt = options.assignedAt || new Date();
  const requestUpdate = { status: "APPROVED", assignedAt };
  if (options.assignedBy) requestUpdate.assignedBy = options.assignedBy;

  const requestIds = [...new Set((options.registrationRequestIds || []).filter(Boolean).map((value) => String(value._id || value)))];
  if (requestIds.length) {
    await RegistrationRequest.updateMany(
      { _id: { $in: requestIds }, player: { $in: ids }, status: "PENDING" },
      { $set: requestUpdate },
      sessionOptions,
    );
  } else if (options.resolvePendingRequests === true) {
    // Bulk resolution must be an explicit choice. Assignment to one class or
    // program must never consume a separate request submitted later.
    await RegistrationRequest.updateMany(
      { player: { $in: ids }, status: "PENDING" },
      { $set: requestUpdate },
      sessionOptions,
    );
  }

  for (const playerId of ids) {
    const hasPendingRequest = Boolean(await RegistrationRequest.exists({ player: playerId, status: "PENDING" }).session(options.session || null));
    await User.updateOne(
      { _id: playerId, isBlocked: { $ne: true } },
      { $set: { playerStatus: "ACTIVE", hasPendingRequest } },
      sessionOptions,
    );
  }
}

module.exports = { activateAssignedPlayers };
