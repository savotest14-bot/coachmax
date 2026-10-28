const RegistrationRequest = require("../models/RegistrationRequest");
const User = require("../models/User");

/**
 * Move assigned players out of the verification queue and into the active
 * player list. Call this only after the assignment itself has succeeded.
 */
async function activateAssignedPlayers(playerIds, options = {}) {
  const ids = [...new Set((playerIds || []).filter(Boolean).map((value) => String(value._id || value)))];
  if (!ids.length) return;

  const sessionOptions = options.session ? { session: options.session } : {};
  const assignedAt = options.assignedAt || new Date();
  const requestUpdate = { status: "APPROVED", assignedAt };
  if (options.assignedBy) requestUpdate.assignedBy = options.assignedBy;

  await RegistrationRequest.updateMany(
    { player: { $in: ids }, status: "PENDING" },
    { $set: requestUpdate },
    sessionOptions,
  );
  await User.updateMany(
    { _id: { $in: ids }, isBlocked: { $ne: true } },
    { $set: { playerStatus: "ACTIVE", hasPendingRequest: false } },
    sessionOptions,
  );
}

module.exports = { activateAssignedPlayers };
