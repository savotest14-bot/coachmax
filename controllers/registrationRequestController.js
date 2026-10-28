const RegistrationRequest = require("../models/RegistrationRequest");
const User = require("../models/User");
const Parent = require("../models/Parent");
const Class = require("../models/Class");
const Term = require("../models/Term");
const Team = require("../models/Team");
const {
  normalizePaymentStatus,
  paymentStatusRankExpression,
} = require("../utils/paymentStatus");
let broadcastSidebarBadges = null;
try {
  ({ broadcastSidebarBadges } = require("../sockets/chatSocket"));
} catch (e) {}

const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const { enrollPlayer } = require("../services/enrollmentService");
const { serializeDateOnly, serializeTerm } = require("../utils/dateTime");
const escapeSearch = (value) => String(value || "").slice(0, 150).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TEMPORARY_REQUEST_TYPES = ["TEMPORARY_PLAYER", "TEMPORARY"];
const serializeRequest = (request) => {
  const raw = request.toObject ? request.toObject() : { ...request };
  if (raw.player && typeof raw.player === "object") {
    raw.player.dob = serializeDateOnly(raw.player.dob);
    raw.player.temporarySessionDate = serializeDateOnly(raw.player.temporarySessionDate);
    const requestType = String(raw.requestType || "").toUpperCase();
    const creatorRole = String(raw.player.createdByRole || raw.player.createdBy?.role || "").toUpperCase();
    if (TEMPORARY_REQUEST_TYPES.includes(requestType) && creatorRole === "COACH") {
      const coachName = raw.player.createdBy?.name;
      raw.addedBy = coachName ? `Coach · ${coachName}` : "Coach";
    } else if (TEMPORARY_REQUEST_TYPES.includes(requestType) && creatorRole === "ADMIN") {
      raw.addedBy = "Admin";
    } else if (TEMPORARY_REQUEST_TYPES.includes(requestType) && creatorRole === "SUPER_ADMIN") {
      raw.addedBy = "Super Admin";
    } else if (TEMPORARY_REQUEST_TYPES.includes(requestType) && raw.player.createdBy) {
      raw.addedBy = "Super Admin";
    } else if (raw.createdBy) {
      raw.addedBy = "App";
    } else {
      raw.addedBy = "Super Admin";
    }
  }
  if (raw.preferredTerm?.name) raw.preferredTerm = serializeTerm(raw.preferredTerm);
  return raw;
};

exports.getRegistrationRequests = async (req, res) => {
  try {
    const { status = "PENDING", requestType, category, program, searchParent, searchPlayer, isMedicalCondition, search, ageGroup, term } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    if (!["PENDING", "APPROVED", "REJECTED", "CANCELLED", "COMPLETED", "ALL"].includes(String(status).toUpperCase())) return res.status(400).json({ success: false, message: "Invalid request status" });
    const query = status.toUpperCase() === "ALL" ? {} : { status: status.toUpperCase() };
    if (requestType && requestType !== "ALL") query.requestType = ["TEMPORARY_PLAYER", "TEMPORARY"].includes(requestType) ? { $in: ["TEMPORARY_PLAYER", "TEMPORARY"] } : requestType;
    if (category) query.category = category;
    if (program) query.programs = program;
    let termDoc = null;
    if (term) {
      if (!mongoose.isValidObjectId(term)) return res.status(400).json({ success: false, message: "Invalid term ID" });
      termDoc = await Term.findById(term).select("year");
      if (!termDoc) return res.status(404).json({ success: false, message: "Selected term was not found" });
      query.preferredTerm = term;
    }
    // A request remains visible even if the player is already active in a
    // different class. Queue identity is the request, not the player.
    const playerFilter = {};
    if (searchPlayer) {
      const regex = new RegExp(escapeSearch(searchPlayer), "i");
      playerFilter.$or = [{ fullName: regex }, { firstName: regex }, { lastName: regex }];
    }
    if (["true", "false", "YES", "NO"].includes(String(isMedicalCondition))) playerFilter.isMedicalCondition = ["true", "YES"].includes(String(isMedicalCondition));
    if (ageGroup) {
      const { ageGroupDobRange, ageGroupContextYear, parseAgeGroupRange } = require("../utils/dateTime");
      const ageRange = parseAgeGroupRange(ageGroup);
      if (!ageRange) return res.status(400).json({ success: false, message: "Invalid U group filter" });
      const range = ageGroupDobRange(ageRange.minAge, ageRange.maxAge, ageGroupContextYear(termDoc?.year));
      playerFilter.dob = range;
    }
    if (Object.keys(playerFilter).length) query.player = { $in: (await User.find(playerFilter).select("_id")).map((player) => player._id) };
    if (searchParent) query.parent = { $in: (await Parent.find({ fullName: new RegExp(escapeSearch(searchParent), "i") }).select("_id")).map((parent) => parent._id) };
    if (search) {
      const regex = new RegExp(escapeSearch(search), "i");
      const [players, parents] = await Promise.all([
        User.find({ $or: [{ fullName: regex }, { firstName: regex }, { lastName: regex }] }).select("_id"),
        Parent.find({ $or: [{ fullName: regex }, { email: regex }, { phone: regex }] }).select("_id"),
      ]);
      query.$and = [{ $or: [{ player: { $in: players.map((player) => player._id) } }, { parent: { $in: parents.map((parent) => parent._id) } }] }];
    }
    const [total, requests] = await Promise.all([
      RegistrationRequest.countDocuments(query),
      RegistrationRequest.find(query)
        .populate("parent", "fullName email phone address city")
        .populate({
          path: "player",
          select: "firstName lastName fullName email phone dob gender profileImage rating classPaymentStatuses term assignedClasses prefferedFoot isMedicalCondition medicalConditionDetails hasPendingRequest playerStatus temporaryClass temporarySessionDate createdBy createdByRole",
          populate: { path: "createdBy", select: "name email role" },
        })
        .populate("category", "name")
        .populate("programs", "name")
        .populate("preferredTerm", "name year startDate endDate status")
        .populate("preferredClasses", "name dayOfWeek startTime endTime venue location term capacity status")
        .populate("assignedBy", "name email")
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);
    return res.json({ success: true, page, limit, total, totalPages: Math.ceil(total / limit), data: requests.map(serializeRequest) });
  } catch (error) {
    return res.status(error.name === "CastError" || error instanceof TypeError ? 400 : 500).json({ success: false, message: error.message });
  }
};

exports.getUnallocatedPlayers = async (req, res) => {
  try {
    const { category, program, search } = req.query;

    const pendingPlayerIds = await RegistrationRequest.find({ status: "PENDING" }).distinct("player");

    let playerIdsFromRequests = [];
    if (category || program) {
      const reqFilter = { status: "PENDING" };
      if (category) reqFilter.category = category;
      if (program) reqFilter.programs = program;
      const requests = await RegistrationRequest.find(reqFilter).select("player");
      playerIdsFromRequests = requests.map((r) => r.player.toString());
    }

    const query = {
      isBlocked: false,
      $or: [
        { assignedClasses: { $exists: false } },
        { assignedClasses: { $size: 0 } },
        { assignedClasses: null },
        { hasPendingRequest: true },
        { _id: { $in: pendingPlayerIds } },
      ],
    };

    if (category || program) {
      const catProgConditions = [];
      const userDirectMatch = {};
      if (category) {
        userDirectMatch.$or = [{ category: category }, { categories: category }];
      }
      if (program) userDirectMatch.programs = program;
      catProgConditions.push(userDirectMatch);

      if (playerIdsFromRequests.length > 0) {
        catProgConditions.push({ _id: { $in: playerIdsFromRequests } });
      }

      query.$and = [{ $or: catProgConditions }];
    }

    if (search) {
      const searchRegex = new RegExp(search, "i");
      const searchCondition = {
        $or: [
          { fullName: searchRegex },
          { firstName: searchRegex },
          { lastName: searchRegex },
          { email: searchRegex },
          { phone: searchRegex },
        ],
      };
      if (query.$and) {
        query.$and.push(searchCondition);
      } else {
        query.$and = [searchCondition];
      }
    }

    const unallocatedPlayers = await User.find(query)
      .populate("parentId", "fullName email phone emergencyContact relationship")
      .populate("category", "name")
      .populate("categories", "name")
      .populate("programs", "name")
      .populate("term", "name")
      .populate("assignedClasses", "name dayOfWeek startTime endTime venue");

    return res.status(200).json({
      success: true,
      count: unallocatedPlayers.length,
      data: unallocatedPlayers,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


exports.getPlayersByCategoryAndProgram = async (req, res) => {
  try {
    const { category, program, search, allocationStatus, page = 1, limit = 10, offset } = req.query;

    const limitNum = Math.max(1, parseInt(limit, 10) || 10);
    let skip = 0;
    let pageNum = 1;

    if (offset !== undefined && offset !== null && offset !== "") {
      skip = Math.max(0, parseInt(offset, 10) || 0);
      pageNum = Math.floor(skip / limitNum) + 1;
    } else {
      pageNum = Math.max(1, parseInt(page, 10) || 1);
      skip = (pageNum - 1) * limitNum;
    }

    const query = {
      isBlocked: false,
    };

    if (category) {
      query.$or = [{ category: category }, { categories: category }];
    }

    if (program) {
      query.programs = program;
    }

    const andConditions = [];

    if (allocationStatus === "UNALLOCATED") {
      const requestFilter = { status: "PENDING" };
      if (category) requestFilter.category = category;
      if (program) requestFilter.programs = program;

      const pendingPlayerIds = await RegistrationRequest.find(requestFilter).distinct(
        "player"
      );

      andConditions.push({
        $or: [
          { "assignedClasses.0": { $exists: false } },
          { assignedClasses: { $size: 0 } },
          { _id: { $in: pendingPlayerIds } },
          { hasPendingRequest: true },
        ],
      });
    } else if (allocationStatus === "ALLOCATED") {
      const requestFilter = { status: "PENDING" };
      const pendingPlayerIds = await RegistrationRequest.find(requestFilter).distinct(
        "player"
      );

      andConditions.push({
        "assignedClasses.0": { $exists: true },
        _id: { $nin: pendingPlayerIds },
        hasPendingRequest: { $ne: true },
      });
    }

    if (search) {
      const regex = new RegExp(search, "i");

      andConditions.push({
        $or: [
          { fullName: regex },
          { firstName: regex },
          { lastName: regex },
          { email: regex },
          { phone: regex },
        ],
      });
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    const [total, players] = await Promise.all([
      User.countDocuments(query),
      User.aggregate([
        { $match: query },
        {
          $addFields: {
            _paymentSortStatus: {
              $ifNull: [
                "$paymentStatus",
                { $arrayElemAt: ["$classPaymentStatuses.paymentStatus", 0] },
              ],
            },
          },
        },
        {
          $addFields: {
            _paymentStatusRank: paymentStatusRankExpression({
              $toUpper: {
                $trim: { input: { $ifNull: ["$_paymentSortStatus", ""] } },
              },
            }),
          },
        },
        { $sort: { _paymentStatusRank: 1, fullName: 1, firstName: 1, createdAt: -1, _id: 1 } },
        { $skip: skip },
        { $limit: limitNum },
        { $project: { password: 0, tokens: 0, _paymentSortStatus: 0, _paymentStatusRank: 0 } },
      ]),
    ]);

    await User.populate(players, [
      { path: "parentId", select: "fullName email phone emergencyContact relationship" },
      { path: "category", select: "name" },
      { path: "categories", select: "name" },
      { path: "programs", select: "name" },
      { path: "term", select: "name" },
      { path: "assignedClasses", select: "name dayOfWeek startTime endTime venue location" },
    ]);
    players.forEach((player) => {
      if (player.paymentStatus) player.paymentStatus = normalizePaymentStatus(player.paymentStatus);
      if (Array.isArray(player.classPaymentStatuses)) {
        player.classPaymentStatuses.forEach((entry) => {
          entry.paymentStatus = normalizePaymentStatus(entry.paymentStatus, "TRIAL");
        });
      }
    });

    // Team membership is stored on Team documents rather than on User. Build a
    // compact lookup so allocated-player cards can show the current teams too.
    const playerIds = players.map((player) => player._id);
    const teamDocs = allocationStatus === "ALLOCATED" && playerIds.length
      ? await Team.find({
          $or: [
            { "players.player": { $in: playerIds } },
            { "leagues.players.player": { $in: playerIds } },
          ],
        })
          .select("teamName ageGroup players leagues")
          .lean()
      : [];
    const teamsByPlayer = new Map();
    const addTeamAssignment = (playerId, team) => {
      const key = String(playerId);
      const current = teamsByPlayer.get(key) || [];
      if (!current.some((item) => String(item.id) === String(team._id))) {
        current.push({
          id: team._id,
          name: team.teamName || "Team",
          ageGroup: team.ageGroup || "",
        });
        teamsByPlayer.set(key, current);
      }
    };
    teamDocs.forEach((team) => {
      (team.players || []).forEach((entry) => {
        if (entry.player) addTeamAssignment(entry.player, team);
      });
      (team.leagues || []).forEach((league) => {
        (league.players || []).forEach((entry) => {
          if (entry.player) addTeamAssignment(entry.player, team);
        });
      });
    });

    let registrationRequestsMap = {};

    if (players.length > 0) {
      const pendingRequests = await RegistrationRequest.find({
        player: { $in: players.map((p) => p._id) },
        status: "PENDING",
      })
        .populate("category", "name")
        .populate("programs", "name")
        .populate("preferredClasses", "name dayOfWeek startTime endTime venue location")
        .populate("preferredTerm", "name startDate endDate");

      registrationRequestsMap = pendingRequests.reduce((acc, request) => {
        acc[request.player.toString()] = request;
        return acc;
      }, {});
    }

    const data = players.map((player) => {
      const obj = { ...player };
      obj.registrationRequest =
        registrationRequestsMap[player._id.toString()] || null;
      obj.assignedTeams = teamsByPlayer.get(player._id.toString()) || [];
      return obj;
    });

    const hasMore = skip + players.length < total;
    const nextPage = hasMore ? pageNum + 1 : null;
    const totalPages = Math.ceil(total / limitNum);

    return res.status(200).json({
      success: true,
      count: data.length,
      total,
      hasMore,
      nextPage,
      pagination: {
        page: pageNum,
        limit: limitNum,
        offset: skip,
        total,
        totalPages,
        hasMore,
        nextPage,
      },
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


exports.assignClassesToPlayer = async (req, res) => {
  try {
    const result = await enrollPlayer({ ...req.body, playerId: req.params?.playerId || req.body?.playerId }, req.admin);
    if (broadcastSidebarBadges) broadcastSidebarBadges().catch(() => {});
    return res.json({ success: true, message: result.repeated ? "This allocation was already completed" : "Player approved and allocated successfully", data: { player: result.player, registrationRequest: result.registrationRequest }, repeated: result.repeated });
  } catch (error) {
    return res.status(error.statusCode || error.status || (error.name === "CastError" || error instanceof TypeError ? 400 : error.code === 11000 ? 409 : 500)).json({ success: false, message: error.message });
  }
};

exports.rejectRegistrationRequest = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    if (!["SUPER_ADMIN", "ADMIN"].includes(req.admin?.role)) return res.status(403).json({ success: false, message: "Administrator access required" });
    const reason = String(req.body.reason || "").trim();
    if (!reason || reason.length > 2000) return res.status(400).json({ success: false, message: "Provide a rejection reason of 1 to 2000 characters" });
    let request;
    await session.withTransaction(async () => {
      request = await RegistrationRequest.findById(req.params.id).session(session);
      if (!request) throw Object.assign(new Error("Registration request not found"), { statusCode: 404 });
      if (request.status === "REJECTED" && request.rejectionReason === reason) return;
      if (request.status !== "PENDING") throw Object.assign(new Error("This request was already resolved"), { statusCode: 409 });
      request.status = "REJECTED";
      request.rejectionReason = reason;
      request.assignedBy = req.admin._id;
      request.assignedAt = new Date();
      await request.save({ session });
      const remaining = await RegistrationRequest.countDocuments({ player: request.player, status: "PENDING" }).session(session);
      const player = await User.findById(request.player).session(session);
      if (player) {
        player.hasPendingRequest = remaining > 0;
        if (!remaining && !player.assignedClasses?.length && player.playerStatus === "PENDING_APPROVAL") player.playerStatus = "REJECTED";
        await player.save({ session });
      }
      await AuditLog.create([{ user: req.admin._id, userRole: req.admin.role, action: "REGISTRATION_REJECTED", entityType: "RegistrationRequest", entityId: request._id, newValue: { reason }, description: "Registration request rejected; player and historical records retained" }], { session });
    });
    if (broadcastSidebarBadges) broadcastSidebarBadges().catch(() => {});
    return res.json({ success: true, message: "Request rejected; player history retained", data: request });
  } catch (error) { return res.status(error.statusCode || (error.name === "CastError" ? 400 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
};
