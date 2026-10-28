const Admin = require("../models/Admin");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const Banner = require("../models/Banner");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const Category = require("../models/Category");
const mongoose = require("mongoose");
const Program = require("../models/Program");
const Term = require("../models/Term");
const Class = require("../models/Class");
const Team = require("../models/Team");
const League = require("../models/League");
const Standing = require("../models/Standing");
const Attendance = require("../models/Attendance");
const { Parser } = require("json2csv");
const Parent = require("../models/Parent");
const ChatRoom = require("../models/ChatRoom");
const RegistrationRequest = require("../models/RegistrationRequest");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const Order = require("../models/Order");
const Product = require("../models/Product");
const News = require("../models/News");
const AttendanceHistory = require("../models/AttendanceHistory");
const CoachNote = require("../models/CoachNote");
const PlayerStatistics = require("../models/PlayerStatistics");
const TrainingSession = require("../models/TrainingSession");
const Message = require("../models/Message");
const AuditLog = require("../models/AuditLog");
const { generateClassInvoice, generateTransferInvoice, generateTeamInvoice, generateLeagueInvoice } = require("../services/invoiceService");
const {
  normalizePaymentStatus,
  comparePlayersByPaymentStatus,
  paymentStatusRankExpression,
} = require("../utils/paymentStatus");
const { dateOnly, dateOnlyToUtc, serializeTerm, ageGroupContextYear, ageGroupDobRange, parseAgeGroupRange, formatDateOnly, formatTimestamp, dateOnlyStartUtc, dateOnlyEndUtc, todayDateOnly, calendarTimestampRange } = require("../utils/dateTime");
const { validatedTermData } = require("../utils/termDates");

exports.adminLogin = async (req, res) => {
  try {
    const { email, mobile, password, fcmToken } = req.body;

    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }

    const admin = await Admin.findOne({
      $or: [{ email }, { mobile }],
    }).select("+password");

    if (!admin) {
      return res.status(404).json({ message: "Admin not found" });
    }

    if (admin.role === "COACH" && admin.isActive === false) {
      return res.status(403).json({ message: "Coach is inactive and cannot log in" });
    }

    const isMatch = await bcrypt.compare(password, admin.password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = generateToken(admin._id);

    admin.tokens = admin.tokens || [];
    admin.tokens.push(token);
    admin.tokens = admin.tokens.slice(-5);

    if (fcmToken) {
      admin.fcmTokens = admin.fcmTokens || [];
      if (!admin.fcmTokens.includes(fcmToken)) {
        admin.fcmTokens.push(fcmToken);
      }
    }

    await admin.save();

    const adminObj = admin.toObject();
    delete adminObj.password;
    delete adminObj.tokens;

    res.json({
      success: true,
      token,
      admin: adminObj,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.logout = async (req, res) => {
  try {
    const { fcmToken } = req.body || {};

    const updateQuery = {
      $set: { tokens: [] }
    };

    if (fcmToken) {
      updateQuery.$pull = { fcmTokens: fcmToken };
    }

    await Admin.findByIdAndUpdate(req.admin._id, updateQuery);
    res.json({ message: "Logged out successfully" });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getUsers = async (req, res) => {
  try {
    let {
      paymentStatus,
      category,
      program,
      term,
      medical,
      ageGroup,
      subProgram,
      unallocated,
      page = 1,
      limit = 10,
      search = "",
    } = req.query;

    const validPaymentStatus = [
      "TRIAL",
      "UNPAID",
      "PAID",
      "OVER_DUE",
      "HANDSHAKE",
      "TBC",
      "EXTRA",
      "SUBSTITUTE",
      "PAYMENT_PENDING",
      "FAILED",
      "REFUNDED",
      "APPROVED",
      "ACTIVE",
      "OTHERS",
      "ALL",
    ];

    if (paymentStatus && !validPaymentStatus.includes(paymentStatus.toUpperCase())) {
      return res.status(400).json({
        message: "Invalid paymentStatus",
      });
    }

    const requestedPaymentStatus = paymentStatus && paymentStatus.toUpperCase() !== "ALL"
      ? normalizePaymentStatus(paymentStatus, paymentStatus.toUpperCase())
      : paymentStatus;

    page = Math.max(1, parseInt(page, 10) || 1);
    limit = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));

    const andConditions = [{ parentId: { $exists: true } }];

    // Term filtering
    let termClassIds = [];
    if (term && term !== "All") {
      let termId = term;
      if (!mongoose.Types.ObjectId.isValid(term)) {
        const foundTerm = await Term.findOne({ name: { $regex: term, $options: "i" } });
        if (foundTerm) termId = foundTerm._id;
      }
      if (mongoose.Types.ObjectId.isValid(termId)) {
        termClassIds = await Class.find({ term: termId }).distinct("_id");
        andConditions.push({
          $or: [
            { term: termId },
            { assignedClasses: { $in: termClassIds } },
            { "classPaymentStatuses.class": { $in: termClassIds } },
          ],
        });
      }
    }

    // Payment Status filtering (supports term-wise when term is selected)
    if (requestedPaymentStatus && requestedPaymentStatus.toUpperCase() !== "ALL") {
      const statusUpper = normalizePaymentStatus(
        requestedPaymentStatus,
        requestedPaymentStatus.toUpperCase()
      );
      if (termClassIds.length > 0) {
        if (statusUpper === "UNPAID") {
          andConditions.push({
            classPaymentStatuses: {
              $elemMatch: {
                class: { $in: termClassIds },
                paymentStatus: { $in: ["UNPAID", "OVER_DUE"] },
              },
            },
          });
        } else {
          andConditions.push({
            classPaymentStatuses: {
              $elemMatch: {
                class: { $in: termClassIds },
                paymentStatus: statusUpper,
              },
            },
          });
        }
      } else {
        if (statusUpper === "UNPAID") {
          andConditions.push({
            $or: [
              { "classPaymentStatuses.paymentStatus": { $in: ["UNPAID", "OVER_DUE"] } },
              { paymentStatus: { $in: ["UNPAID", "OVER_DUE"] } },
            ],
          });
        } else if (statusUpper === "PAID") {
          andConditions.push({
            $or: [
              { "classPaymentStatuses.paymentStatus": "PAID" },
              { paymentStatus: "PAID" },
            ],
          });
        } else if (statusUpper === "TRIAL") {
          andConditions.push({
            $or: [
              { "classPaymentStatuses.paymentStatus": "TRIAL" },
              { paymentStatus: "TRIAL" },
              { classPaymentStatuses: { $exists: false } },
              { classPaymentStatuses: { $size: 0 } },
            ],
          });
        } else {
          andConditions.push({
            $or: [
              { "classPaymentStatuses.paymentStatus": statusUpper },
              { paymentStatus: statusUpper },
            ],
          });
        }
      }
    }

    // Program / Category filtering
    if (program && program !== "All") {
      const progRegex = new RegExp(program, "i");
      const matchingCats = await Category.find({ name: progRegex }).distinct("_id");
      const matchingProgs = await Program.find({
        $or: [{ name: progRegex }, { category: { $in: matchingCats } }],
      }).distinct("_id");

      const progOr = [];
      if (mongoose.Types.ObjectId.isValid(program)) {
        progOr.push({ programs: program }, { category: program }, { categories: program });
      }
      if (matchingCats.length > 0) {
        progOr.push({ category: { $in: matchingCats } }, { categories: { $in: matchingCats } });
      }
      if (matchingProgs.length > 0) {
        progOr.push({ programs: { $in: matchingProgs } });
      }
      if (progOr.length > 0) {
        andConditions.push({ $or: progOr });
      }
    }

    // Sub-program filtering is separate from the broad Academy/School program type.
    if (subProgram && subProgram !== "All") {
      const subProgramRegex = new RegExp(subProgram, "i");
      const matchingSubPrograms = [];

      if (mongoose.Types.ObjectId.isValid(subProgram)) {
        matchingSubPrograms.push(subProgram);
      }

      const namedSubPrograms = await Program.find({ name: subProgramRegex }).distinct("_id");
      matchingSubPrograms.push(...namedSubPrograms);

      if (matchingSubPrograms.length > 0) {
        andConditions.push({ programs: { $in: matchingSubPrograms } });
      } else {
        andConditions.push({ programs: { $in: [] } });
      }
    }

    if (category && category !== "All") {
      if (mongoose.Types.ObjectId.isValid(category)) {
        andConditions.push({ $or: [{ category }, { categories: category }] });
      } else {
        const catDocs = await Category.find({ name: { $regex: category, $options: "i" } }).distinct("_id");
        if (catDocs.length > 0) {
          andConditions.push({ $or: [{ category: { $in: catDocs } }, { categories: { $in: catDocs } }] });
        }
      }
    }

    // Medical Condition filter
    if (medical !== undefined && medical !== "All") {
      if (medical === "true" || medical === true) {
        andConditions.push({ isMedicalCondition: true });
      } else if (medical === "false" || medical === false) {
        andConditions.push({
          $or: [
            { isMedicalCondition: false },
            { isMedicalCondition: { $exists: false } },
            { isMedicalCondition: null },
          ],
        });
      }
    }

    // Age Group filter
    if (ageGroup && ageGroup !== "All") {
      let ageRange;
      try { ageRange = parseAgeGroupRange(ageGroup); }
      catch (error) { return res.status(400).json({ message: error.message }); }
      const orAgeList = [];

      // Named groups may match a program; numeric U groups always use birth year.
      if (!ageRange) {
        const escaped = String(ageGroup).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const matchingAgePrograms = await Program.find({ $or: [{ ageGroup: { $regex: escaped, $options: "i" } }, { name: { $regex: escaped, $options: "i" } }] }).distinct("_id");
        orAgeList.push({ programs: { $in: matchingAgePrograms } });
      }

      if (ageRange) {
        let contextYear = ageGroupContextYear();
        if (term && term !== "All") {
          if (!mongoose.Types.ObjectId.isValid(term)) return res.status(400).json({ message: "Invalid term ID" });
          const ageTerm = await Term.findById(term).select("year").lean();
          if (!ageTerm) return res.status(404).json({ message: "Term not found" });
          contextYear = ageGroupContextYear(ageTerm.year);
        }
        try { orAgeList.push({ dob: ageGroupDobRange(ageRange.minAge, ageRange.maxAge, contextYear) }); }
        catch (error) { return res.status(400).json({ message: error.message }); }
      }

      if (orAgeList.length > 0) {
        andConditions.push({ $or: orAgeList });
      }
    }

    if (unallocated === "true") {
      const pendingPlayerIds = await RegistrationRequest.find({ status: "PENDING" }).distinct("player");
      andConditions.push({
        $or: [
          { assignedClasses: { $exists: false } },
          { assignedClasses: { $size: 0 } },
          { hasPendingRequest: true },
          { _id: { $in: pendingPlayerIds } },
        ],
      });
    } else {
      // In getUsers, return all official users who are in the user model:
      // Exclude unapproved temporary players and unallocated pending registrations
      andConditions.push({
        playerStatus: { $ne: "PENDING_APPROVAL" },
      });
      andConditions.push({
        $or: [
          { hasPendingRequest: { $ne: true } },
          { "assignedClasses.0": { $exists: true } },
        ],
      });
    }

    if (search && search.trim()) {
      const searchTrim = search.trim();
      const searchRegex = { $regex: searchTrim, $options: "i" };
      const matchingParents = await Parent.find({
        $or: [
          { fullName: searchRegex },
          { email: searchRegex },
          { phone: searchRegex },
          { emergencyContact: searchRegex },
        ],
      }).distinct("_id");

      const searchCriteria = [
        { fullName: searchRegex },
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { phone: searchRegex },
        { contactName: searchRegex },
      ];

      if (matchingParents.length > 0) {
        searchCriteria.push({ parentId: { $in: matchingParents } });
      }

      andConditions.push({ $or: searchCriteria });
    }

    const query = andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

    const total = await User.countDocuments(query);

    // Rank the effective status before pagination. Sorting after skip/limit would
    // only order one page and would make the player list change between pages.
    const paymentStatusExpression = termClassIds.length > 0
      ? {
        $let: {
          vars: {
            termStatuses: {
              $filter: {
                input: { $ifNull: ["$classPaymentStatuses", []] },
                as: "classStatus",
                cond: { $in: ["$$classStatus.class", termClassIds] },
              },
            },
          },
          in: {
            $ifNull: [
              { $arrayElemAt: ["$$termStatuses.paymentStatus", 0] },
              { $ifNull: ["$paymentStatus", "TRIAL"] },
            ],
          },
        },
      }
      : { $ifNull: ["$paymentStatus", { $arrayElemAt: ["$classPaymentStatuses.paymentStatus", 0] }] };

    const users = await User.aggregate([
      { $match: query },
      { $addFields: { _paymentSortStatus: paymentStatusExpression } },
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
      { $skip: (page - 1) * limit },
      { $limit: limit },
      { $project: { password: 0, tokens: 0, _paymentSortStatus: 0, _paymentStatusRank: 0 } },
    ]);

    await User.populate(users, [
      { path: "parentId", select: "fullName email phone address city state postcode country emergencyContact relationship" },
      { path: "category", select: "name" },
      { path: "categories", select: "name" },
      { path: "programs", select: "name" },
      { path: "term", select: "name year" },
      {
        path: "classPaymentStatuses.class",
        select: "name term program category",
        populate: { path: "term", select: "name year" },
      },
      {
        path: "assignedClasses",
        populate: [
          { path: "term", select: "name year" },
          { path: "coach", select: "fullName email" },
          { path: "program", select: "name" },
          { path: "category", select: "name" },
        ],
      },
    ]);

    users.forEach((user) => {
      if (user.paymentStatus) {
        user.paymentStatus = normalizePaymentStatus(user.paymentStatus);
      }
      if (Array.isArray(user.classPaymentStatuses)) {
        user.classPaymentStatuses.forEach((entry) => {
          entry.paymentStatus = normalizePaymentStatus(entry.paymentStatus, "TRIAL");
        });
      }
    });

    // Compute dynamic player stats scoped to term (or all database players if term is not specified)
    const termAndConditions = [{ parentId: { $exists: true } }];
    if (termClassIds.length > 0) {
      termAndConditions.push({
        $or: [
          { term: term },
          { assignedClasses: { $in: termClassIds } },
          { "classPaymentStatuses.class": { $in: termClassIds } },
        ],
      });
    } else if (term && term !== "All" && mongoose.Types.ObjectId.isValid(term)) {
      termAndConditions.push({ term: term });
    }

    const eliteCats = await Category.find({ name: { $regex: "ACADEMY|ELITE", $options: "i" } }).distinct("_id");
    const elitePrograms = await Program.find({ name: { $regex: "ELITE", $options: "i" } }).distinct("_id");
    const schoolCats = await Category.find({ name: { $regex: "SCHOOL", $options: "i" } }).distinct("_id");
    const schoolPrograms = await Program.find({
      $or: [
        { name: { $regex: "SCHOOL", $options: "i" } },
        { category: { $in: schoolCats } },
      ],
    }).distinct("_id");

    const reqTermQuery = (term && term !== "All" && mongoose.Types.ObjectId.isValid(term))
      ? { preferredTerm: term }
      : {};

    const [
      totalCount,
      approvedCount,
      pendingUsers,
      pendingReqs,
      rejectedUsers,
      rejectedReqs,
      eliteCount,
      schoolCount,
    ] = await Promise.all([
      User.countDocuments({ $and: [...termAndConditions, { playerStatus: { $ne: "PENDING_APPROVAL" } }] }),
      User.countDocuments({ $and: [...termAndConditions, { playerStatus: { $in: ["ACTIVE", "APPROVED"] } }] }),
      User.countDocuments({ $and: [...termAndConditions, { $or: [{ playerStatus: "PENDING_APPROVAL" }, { hasPendingRequest: true }] }] }),
      RegistrationRequest.countDocuments({ status: "PENDING", ...reqTermQuery }),
      User.countDocuments({ $and: [...termAndConditions, { playerStatus: "REJECTED" }] }),
      RegistrationRequest.countDocuments({ status: "REJECTED", ...reqTermQuery }),
      User.countDocuments({
        $and: [
          ...termAndConditions,
          { playerStatus: { $ne: "PENDING_APPROVAL" } },
          {
            $or: [
              { programs: { $in: elitePrograms } },
              { category: { $in: eliteCats } },
              { categories: { $in: eliteCats } },
            ],
          },
        ],
      }),
      User.countDocuments({
        $and: [
          ...termAndConditions,
          { playerStatus: { $ne: "PENDING_APPROVAL" } },
          {
            $or: [
              { programs: { $in: schoolPrograms } },
              { category: { $in: schoolCats } },
              { categories: { $in: schoolCats } },
            ],
          },
        ],
      }),
    ]);

    const stats = {
      totalCount,
      approvedCount,
      pendingCount: pendingUsers + pendingReqs,
      rejectedCount: rejectedUsers + rejectedReqs,
      eliteCount,
      schoolCount,
    };

    res.json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      stats,
      users,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPlayerStats = async (req, res) => {
  try {
    const { term } = req.query;
    let termClassIds = [];
    const termAndConditions = [{ parentId: { $exists: true } }];

    if (term && term !== "All") {
      let termId = term;
      if (!mongoose.Types.ObjectId.isValid(term)) {
        const foundTerm = await Term.findOne({ name: { $regex: term, $options: "i" } });
        if (foundTerm) termId = foundTerm._id;
      }
      if (mongoose.Types.ObjectId.isValid(termId)) {
        termClassIds = await Class.find({ term: termId }).distinct("_id");
        termAndConditions.push({
          $or: [
            { term: termId },
            { assignedClasses: { $in: termClassIds } },
            { "classPaymentStatuses.class": { $in: termClassIds } },
          ],
        });
      }
    }

    const eliteCats = await Category.find({ name: { $regex: "ACADEMY|ELITE", $options: "i" } }).distinct("_id");
    const elitePrograms = await Program.find({ name: { $regex: "ELITE", $options: "i" } }).distinct("_id");
    const schoolCats = await Category.find({ name: { $regex: "SCHOOL", $options: "i" } }).distinct("_id");
    const schoolPrograms = await Program.find({
      $or: [
        { name: { $regex: "SCHOOL", $options: "i" } },
        { category: { $in: schoolCats } },
      ],
    }).distinct("_id");

    const reqTermQuery = (term && term !== "All" && mongoose.Types.ObjectId.isValid(term))
      ? { preferredTerm: term }
      : {};

    const [
      totalCount,
      approvedCount,
      pendingUsers,
      pendingReqs,
      rejectedUsers,
      rejectedReqs,
      eliteCount,
      schoolCount,
    ] = await Promise.all([
      User.countDocuments({ $and: [...termAndConditions, { playerStatus: { $ne: "PENDING_APPROVAL" } }] }),
      User.countDocuments({ $and: [...termAndConditions, { playerStatus: { $in: ["ACTIVE", "APPROVED"] } }] }),
      User.countDocuments({ $and: [...termAndConditions, { $or: [{ playerStatus: "PENDING_APPROVAL" }, { hasPendingRequest: true }] }] }),
      RegistrationRequest.countDocuments({ status: "PENDING", ...reqTermQuery }),
      User.countDocuments({ $and: [...termAndConditions, { playerStatus: "REJECTED" }] }),
      RegistrationRequest.countDocuments({ status: "REJECTED", ...reqTermQuery }),
      User.countDocuments({
        $and: [
          ...termAndConditions,
          { playerStatus: { $ne: "PENDING_APPROVAL" } },
          {
            $or: [
              { programs: { $in: elitePrograms } },
              { category: { $in: eliteCats } },
              { categories: { $in: eliteCats } },
            ],
          },
        ],
      }),
      User.countDocuments({
        $and: [
          ...termAndConditions,
          { playerStatus: { $ne: "PENDING_APPROVAL" } },
          {
            $or: [
              { programs: { $in: schoolPrograms } },
              { category: { $in: schoolCats } },
              { categories: { $in: schoolCats } },
            ],
          },
        ],
      }),
    ]);

    const stats = {
      totalCount,
      approvedCount,
      pendingCount: pendingUsers + pendingReqs,
      rejectedCount: rejectedUsers + rejectedReqs,
      eliteCount,
      schoolCount,
    };

    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updatePaymentStatus = async (req, res) => {
  try {
    const userId = req.params.userId;
    let { paymentStatus, classId, teamId } = req.body;

    const leagueId =
      req.body?.leagueId ||
      req.query?.leagueId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const validStatus = [
      "TRIAL",
      "UNPAID",
      "PAID",
      "OVER_DUE",
      "EXTRA",
      "SUBSTITUTE",
      "TBC",
      "HANDSHAKE",
    ];

    paymentStatus = paymentStatus
      ? normalizePaymentStatus(paymentStatus, String(paymentStatus).toUpperCase())
      : paymentStatus;

    if (!paymentStatus || !validStatus.includes(paymentStatus)) {
      return res.status(400).json({
        success: false,
        message: `Invalid or missing paymentStatus. Must be one of: ${validStatus.join(", ")}`,
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Player not found",
      });
    }

    /*
    |--------------------------------------------------------------------------
    | TEAM + LEAGUE PAYMENT STATUS
    |--------------------------------------------------------------------------
    */

    let leagueTeamFee = 0;

    if (teamId) {
      const TeamModel = require("../models/Team");

      const teamDoc = await TeamModel.findById(teamId);

      if (!teamDoc) {
        return res.status(404).json({
          success: false,
          message: "Team not found",
        });
      }

      /*
      |--------------------------------------------------------------------------
      | TEAM + LEAGUE
      |--------------------------------------------------------------------------
      | When both teamId and leagueId are supplied:
      |
      | 1. Find the league inside team.leagues
      | 2. Update player paymentStatus there
      | 3. Get invoice amount from team.leagues[].teamFee
      | 4. Never use League.fee for the invoice amount
      |--------------------------------------------------------------------------
      */

      if (leagueId) {
        if (!mongoose.Types.ObjectId.isValid(leagueId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid League ID format",
          });
        }

        if (!Array.isArray(teamDoc.leagues)) {
          teamDoc.leagues = [];
        }

        let leagueEntry = teamDoc.leagues.find(
          (l) =>
            (l.league?._id || l.league)?.toString() ===
            leagueId.toString()
        );

        /*
        |--------------------------------------------------------------------------
        | CREATE TEAM-LEAGUE ENTRY IF IT DOES NOT EXIST
        |--------------------------------------------------------------------------
        */

        if (!leagueEntry) {
          const LeagueModel = require("../models/League");

          const leagueDoc = await LeagueModel.findById(leagueId);

          if (!leagueDoc) {
            return res.status(404).json({
              success: false,
              message: "League not found",
            });
          }

          teamDoc.leagues.push({
            league: leagueId,

            // Initial team fee when team joins league
            teamFee: Number(leagueDoc.fee || 0),

            status: "ACTIVE",
            enrolledAt: new Date(),

            players: [],

            statistics: {
              played: 0,
              won: 0,
              drawn: 0,
              lost: 0,
              goalsFor: 0,
              goalsAgainst: 0,
              goalDifference: 0,
              points: 0,
            },
          });

          leagueEntry =
            teamDoc.leagues[teamDoc.leagues.length - 1];
        }

        if (!Array.isArray(leagueEntry.players)) {
          leagueEntry.players = [];
        }

        /*
        |--------------------------------------------------------------------------
        | UPDATE PLAYER PAYMENT STATUS INSIDE THIS LEAGUE
        |--------------------------------------------------------------------------
        */

        const lpEntry = leagueEntry.players.find(
          (p) =>
            (p.player?._id || p.player)?.toString() ===
            userId.toString()
        );

        if (lpEntry) {
          lpEntry.paymentStatus = paymentStatus;
        } else {
          leagueEntry.players.push({
            player: userId,
            paymentStatus,
            status: "ACTIVE",
          });
        }

        /*
        |--------------------------------------------------------------------------
        | ENSURE PLAYER EXISTS IN TEAM MASTER PLAYERS
        |--------------------------------------------------------------------------
        */

        if (!Array.isArray(teamDoc.players)) {
          teamDoc.players = [];
        }

        const hasTeamPlayer = teamDoc.players.some(
          (p) =>
            (p.player?._id || p.player)?.toString() ===
            userId.toString()
        );

        if (!hasTeamPlayer) {
          teamDoc.players.push({
            player: userId,
            paymentStatus: "TRIAL",
          });
        }

        /*
        |--------------------------------------------------------------------------
        | IMPORTANT:
        | INVOICE AMOUNT COMES ONLY FROM team.leagues[].teamFee
        |--------------------------------------------------------------------------
        */

        leagueTeamFee = Number(leagueEntry.teamFee || 0);

        teamDoc.markModified("leagues");

        await teamDoc.save();
      }

      /*
      |--------------------------------------------------------------------------
      | TEAM ONLY
      |--------------------------------------------------------------------------
      */

      else {
        if (!Array.isArray(teamDoc.players)) {
          teamDoc.players = [];
        }

        const pEntry = teamDoc.players.find(
          (item) =>
            (item.player?._id || item.player)?.toString() ===
            userId.toString()
        );

        if (pEntry) {
          pEntry.paymentStatus = paymentStatus;
        } else {
          teamDoc.players.push({
            player: userId,
            paymentStatus,
          });
        }

        await teamDoc.save();
      }
    }

    /*
    |--------------------------------------------------------------------------
    | CLASS PAYMENT STATUS
    |--------------------------------------------------------------------------
    */

    else {
      user.classPaymentStatuses =
        user.classPaymentStatuses || [];

      const targetClassIds = classId
        ? [classId.toString()]
        : (user.assignedClasses || []).map((id) =>
          id.toString()
        );

      if (targetClassIds.length > 0) {
        for (const cidStr of targetClassIds) {
          const existingEntry =
            user.classPaymentStatuses.find(
              (cps) =>
                cps.class &&
                cps.class.toString() === cidStr
            );

          if (existingEntry) {
            existingEntry.paymentStatus =
              paymentStatus;
          } else {
            user.classPaymentStatuses.push({
              class: cidStr,
              paymentStatus,
            });
          }
        }
      }

      // Update composite player paymentStatus
      if (!classId) {
        user.paymentStatus = paymentStatus;
      } else {
        const allStatuses = (user.classPaymentStatuses || []).map((s) => s.paymentStatus);
        if (allStatuses.length > 0) {
          if (allStatuses.some((st) => st === "OVER_DUE")) {
            user.paymentStatus = "OVER_DUE";
          } else if (allStatuses.some((st) => st === "UNPAID")) {
            user.paymentStatus = "UNPAID";
          } else if (allStatuses.every((st) => st === "PAID")) {
            user.paymentStatus = "PAID";
          } else if (allStatuses.some((st) => st === "TRIAL")) {
            user.paymentStatus = "TRIAL";
          } else {
            user.paymentStatus = paymentStatus;
          }
        } else {
          user.paymentStatus = paymentStatus;
        }
      }

      // Synchronize matching ACTIVE invoices if set to PAID
      if (paymentStatus === "PAID") {
        try {
          const InvoiceModel = require("../models/Invoice");
          const invQuery = {
            players: user._id,
            status: "ACTIVE",
          };
          if (classId) {
            invQuery.class = classId;
          }
          await InvoiceModel.updateMany(invQuery, {
            $set: { paymentStatus: "PAID" },
          });
        } catch (e) {
          console.error("Error updating invoice to PAID:", e.message);
        }
      }

      await user.save();
    }

    /*
    |--------------------------------------------------------------------------
    | AUTO INVOICE GENERATION
    |--------------------------------------------------------------------------
    */

    if (paymentStatus === "UNPAID") {
      try {
        /*
        |--------------------------------------------------------------------------
        | TEAM + LEAGUE INVOICE
        |--------------------------------------------------------------------------
        |
        | Amount = team.leagues[].teamFee
        |
        */

        if (teamId && leagueId) {
          if (leagueTeamFee <= 0) {
            console.warn(
              `[League Invoice] No valid teamFee found for team=${teamId}, league=${leagueId}`
            );
          } else {
            await generateLeagueInvoice({
              userId: user._id,
              leagueId,
              teamId,

              // IMPORTANT:
              // Use team.leagues[].teamFee
              amount: leagueTeamFee,
            });

            console.log(
              `[League Invoice] Generated for player=${user._id}, team=${teamId}, league=${leagueId}, amount=${leagueTeamFee}`
            );
          }
        }

        /*
        |--------------------------------------------------------------------------
        | CLASS INVOICE
        |--------------------------------------------------------------------------
        */

        else if (classId) {
          await generateClassInvoice({
            userId: user._id,
            classId,
          });
        }

        /*
        |--------------------------------------------------------------------------
        | ALL ASSIGNED CLASS INVOICES
        |--------------------------------------------------------------------------
        */

        else if (
          !teamId &&
          user.assignedClasses &&
          user.assignedClasses.length > 0
        ) {
          for (const cid of user.assignedClasses) {
            await generateClassInvoice({
              userId: user._id,
              classId: cid,
            });
          }
        }
      } catch (invErr) {
        console.error(
          "Auto invoice generation error in updatePaymentStatus:",
          invErr.message
        );
      }
    }

    /*
    |--------------------------------------------------------------------------
    | RESPONSE
    |--------------------------------------------------------------------------
    */

    return res.status(200).json({
      success: true,
      message: `Payment status updated to ${paymentStatus} successfully`,
      data: user,
    });
  } catch (err) {
    console.error(
      "updatePaymentStatus error:",
      err
    );

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};




exports.updatePlayerRating = async (req, res) => {
  try {
    const { userId } = req.params;
    const { rating } = req.body;

    if (rating === undefined || rating < 1 || rating > 5) {
      return res.status(400).json({
        message: "Rating must be between 1 and 5",
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.rating = rating;
    await user.save();

    res.json({
      message: "Player rating updated successfully",
      data: { rating: user.rating },
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.assignClassToUser = async (req, res, next) => {
  const { classId, paymentStatus = 'TRIAL', registrationRequestId } = req.body;
  req.params.playerId = req.params.userId;
  req.body = { classIds: [classId], paymentStatus, registrationRequestId };
  return require('./registrationRequestController').assignClassesToPlayer(req, res, next);
};

exports.removeClassFromUser = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.params?.userId || req.params?.playerId || req.body?.userId || req.body?.playerId;
    const classId = req.params?.classId || req.body?.classId;

    if (!userId || !classId) {
      throw new Error("Both userId/playerId and classId are required");
    }

    const user = await User.findById(userId).session(session);
    const classData = await Class.findById(classId).session(session);

    if (!user) throw new Error("Player not found");
    if (!classData) throw new Error("Class not found");

    user.assignedClasses = (user.assignedClasses || []).filter(
      (c) => c.toString() !== classId.toString()
    );

    user.removedClasses = user.removedClasses || [];
    if (!user.removedClasses.some((c) => c.toString() === classId.toString())) {
      user.removedClasses.push(classId);
    }

    classData.players = (classData.players || []).filter(
      (p) => p.toString() !== userId.toString()
    );

    await user.save({ session });
    await classData.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({
      success: true,
      message: "Player removed from class successfully",
      data: {
        userId,
        classId,
        assignedClasses: user.assignedClasses,
        removedClasses: user.removedClasses,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    res.status(400).json({
      success: false,
      message: err.message,
    });
  }
};

exports.transferPlayerClass = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const userId = req.params?.userId || req.params?.playerId || req.body?.userId || req.body?.playerId;
    const { fromClassId, toClassId } = req.body;
    const reject = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
    if (![userId, fromClassId, toClassId].every((id) => mongoose.isValidObjectId(id))) reject("Valid player, source class and target class IDs are required");
    if (String(fromClassId) === String(toClassId)) reject("Choose a different target class");
    let result;
    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);
      const fromClass = await Class.findById(fromClassId).session(session);
      const toClass = await Class.findById(toClassId).session(session);
      if (!user || !fromClass || !toClass) reject("Player or class not found", 404);
      if (toClass.status !== "ACTIVE" || toClass.isArchived) reject("Target class is not active", 409);
      if (String(fromClass.term) !== String(toClass.term)) reject("Transfer must stay within the same term; use a new enrollment for another term", 409);
      if (!(user.assignedClasses || []).some((id) => String(id) === String(fromClassId))) reject("Player is not assigned to the source class", 409);
      if ((user.assignedClasses || []).some((id) => String(id) === String(toClassId))) reject("Player is already assigned to the target class", 409);
      if (toClass.capacity && toClass.players.length >= toClass.capacity) reject("Target class is at maximum capacity", 409);
      user.assignedClasses = user.assignedClasses.filter((id) => String(id) !== String(fromClassId));
      user.assignedClasses.push(toClassId);
      user.removedClasses = (user.removedClasses || []).filter((id) => String(id) !== String(toClassId));
      if (!user.removedClasses.some((id) => String(id) === String(fromClassId))) user.removedClasses.push(fromClassId);
      fromClass.players = fromClass.players.filter((id) => String(id) !== String(userId));
      if (!toClass.players.some((id) => String(id) === String(userId))) toClass.players.push(userId);
      await user.save({ session });
      await fromClass.save({ session });
      await toClass.save({ session });
      const billing = await generateTransferInvoice({ userId, fromClass, toClass, session });
      result = { player: user, fromClass: { _id: fromClass._id, name: fromClass.name, price: fromClass.price }, toClass: { _id: toClass._id, name: toClass.name, price: toClass.price }, priceDifference: billing.priceDiff, invoiceGenerated: billing.invoiceGenerated, invoice: billing.invoice };
    });
    return res.json({ success: true, message: result.invoice ? "Player transferred and transfer charge saved" : "Player transferred successfully; no additional charge", data: result });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Transfer could not be completed. No changes were saved." });
  } finally { await session.endSession(); }
};

exports.assignCoachToClass = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { classId } = req.params;
    const { coachId } = req.body;

    const classData = await Class.findById(classId).session(session);
    const coach = await Admin.findById(coachId).session(session);

    if (!classData) throw new Error("Class not found");
    if (!coach) throw new Error("Coach not found");

    if (coach.role !== "COACH") {
      throw new Error("User is not a coach");
    }

    if (coach.isActive === false) {
      throw new Error("Coach is inactive and cannot be assigned to class");
    }

    classData.coach = coachId;

    await classData.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.json({
      message: "Coach assigned successfully",
      data: classData,
    });

  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    res.status(400).json({ message: err.message });
  }
};

exports.createBanner = async (req, res) => {
  try {
    const { title, subtitle, link } = req.body;

    let bannerImg = null;

    if (req.file) {
      bannerImg = `uploads/bannerImg/${req.file.filename}`;
    }

    const banner = await Banner.create({
      title,
      subtitle,
      link,
      image: bannerImg,
      createdBy: req.admin?._id,
    });

    res.status(201).json({
      success: true,
      message: "Banner created successfully",
      data: banner,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.updateBanner = async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await Banner.findById(id);
    if (!banner) {
      return res.status(404).json({
        success: false,
        message: "Banner not found",
      });
    }

    if (req.file && banner.image) {
      const oldPath = path.join(__dirname, "..", banner.image);

      if (fs.existsSync(oldPath)) {
        fs.unlink(oldPath, (err) => {
          if (err) console.log("Error deleting file:", err);
        });
      }
    }

    const updated = await Banner.findByIdAndUpdate(
      id,
      {
        ...req.body,
        ...(req.file && { image: `uploads/bannerImg/${req.file.filename}` }),
      },
      { new: true }
    );

    res.json({
      success: true,
      message: "Banner updated successfully",
      data: updated,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.deleteBanner = async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await Banner.findById(id);
    if (!banner) {
      return res.status(404).json({
        success: false,
        message: "Banner not found",
      });
    }

    if (banner.image) {
      const filePath = path.join(__dirname, "..", banner.image);

      if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
          if (err) console.log("File delete error:", err);
        });
      }
    }

    await Banner.findByIdAndDelete(id);

    res.json({
      success: true,
      message: "Banner deleted successfully",
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.getAllBanners = async (req, res) => {
  try {
    const { page = 1, limit = 10, isActive } = req.query;

    const filter = {};
    if (isActive !== undefined) {
      filter.isActive = isActive;
    }

    const banners = await Banner.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Banner.countDocuments(filter);

    res.json({
      success: true,
      total,
      page: Number(page),
      data: banners,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.toggleBannerStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await Banner.findById(id);

    banner.isActive = !banner.isActive;
    await banner.save();

    res.json({
      success: true,
      message: "Banner status updated",
      data: banner,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.exportUsers = async (req, res) => {
  try {
    let {
      paymentStatus,
      search = "",
      format = "csv",
      userIds = [],
    } = req.body;

    const validPaymentStatus = ["TRIAL", "UNPAID", "PAID", "OVER_DUE"];
    if (paymentStatus && !validPaymentStatus.includes(paymentStatus)) {
      return res.status(400).json({ message: "Invalid paymentStatus" });
    }

    const query = {};

    if (userIds && userIds.length > 0) {
      query._id = { $in: userIds };
    }

    if (paymentStatus) {
      query["classPaymentStatuses.paymentStatus"] = paymentStatus;
    }

    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    const users = await User.find(query)
      .select("-password -tokens")
      .sort({ createdAt: -1 });

    if (!users.length) {
      return res.status(404).json({ message: "No users found" });
    }

    const data = users.map((u) => ({
      Name: u.fullName || "",
      Email: u.email || "",
      Phone: u.phone || "",
      PaymentStatus: (u.classPaymentStatuses || []).map((cps) => cps.paymentStatus).join(", ") || "TRIAL",
      SkillLevel: u.skillLevel || "",
      Rating: u.rating || 1,
      Club: u.club || "",
      DOB: u.dob ? formatDateOnly(u.dob) : "",
      ContactName: u.contactName || "",
      Comments: u.comments || "",
      CreatedAt: formatTimestamp(u.createdAt),
    }));

    if (format === "csv") {
      const csv = [
        Object.keys(data[0]).join(","),
        ...data.map((row) =>
          Object.values(row)
            .map((val) => `"${val}"`)
            .join(",")
        ),
      ].join("\n");

      res.header("Content-Type", "text/csv");
      res.attachment("users.csv");
      return res.send(csv);
    }

    if (format === "excel") {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Users");

      worksheet.columns = Object.keys(data[0]).map((key) => ({
        header: key,
        key: key,
        width: 25,
      }));

      data.forEach((row) => {
        worksheet.addRow(row);
      });

      worksheet.getRow(1).font = { bold: true };

      res.header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.attachment("users.xlsx");

      await workbook.xlsx.write(res);
      return res.end();
    }

    return res.status(400).json({
      message: "Invalid format (csv/excel)",
    });

  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
};


exports.createCategory = async (req, res) => {
  try {
    const { name, isEvent } = req.body;

    if (!name) {
      return res.status(400).json({
        message: "Category name is required",
      });
    }

    const existing = await Category.findOne({
      name: name.toUpperCase(),
    });

    if (existing) {
      return res.status(400).json({
        message: "Category already exists",
      });
    }

    const categoryData = {
      name: name.toUpperCase(),
    };

    if (isEvent === true) {
      categoryData.isEvent = true;
    }

    const category = await Category.create(categoryData);

    res.json({
      message: "Category created successfully",
      category,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


exports.updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category ID",
      });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Category name is required",
      });
    }

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    const existing = await Category.findOne({
      name: name.toUpperCase(),
      _id: { $ne: id },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: "A category with this name already exists",
      });
    }

    category.name = name.toUpperCase();
    await category.save();

    res.json({
      success: true,
      message: "Category updated successfully",
      category,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.deletecatCategory = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category ID",
      });
    }

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    const [
      classCount,
      programCount,
      userCount,
      registrationRequestCount,
    ] = await Promise.all([
      Class.countDocuments({ category: id }),
      Program.countDocuments({ category: id }),
      User.countDocuments({
        $or: [{ category: id }, { categories: id }],
      }),
      RegistrationRequest.countDocuments({
        $or: [{ category: id }, { preferredCategories: id }],
      }),
    ]);

    const totalUsage =
      classCount + programCount + userCount + registrationRequestCount;

    if (totalUsage > 0) {
      const connections = [];
      if (classCount > 0) connections.push(`${classCount} class(es)`);
      if (programCount > 0) connections.push(`${programCount} program(s)`);
      if (userCount > 0) connections.push(`${userCount} player(s)`);
      if (registrationRequestCount > 0)
        connections.push(`${registrationRequestCount} registration request(s)`);

      return res.status(400).json({
        success: false,
        message: `Cannot delete category as it is currently connected to: ${connections.join(", ")}`,
        data: {
          classCount,
          programCount,
          userCount,
          registrationRequestCount,
        },
      });
    }

    await Category.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Category deleted successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


exports.createProgram = async (req, res) => {
  try {
    const { name, category } = req.body;

    if (!name || !category) {
      return res.status(400).json({
        message: "Name and category are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(category)) {
      return res.status(400).json({
        message: "Invalid category ID",
      });
    }

    const categoryData = await Category.findById(category);
    if (!categoryData) {
      return res.status(400).json({
        message: "Category not found",
      });
    }

    const existing = await Program.findOne({
      name: name,
      category: category,
    });

    if (existing) {
      return res.status(400).json({
        message: "Program already exists in this category",
      });
    }

    const program = await Program.create({
      name,
      category,
    });

    res.json({
      message: "Program created successfully",
      program,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateProgram = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid program ID",
      });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Program name is required",
      });
    }

    const program = await Program.findById(id);
    if (!program) {
      return res.status(404).json({
        success: false,
        message: "Program not found",
      });
    }

    const existing = await Program.findOne({
      name: name,
      category: program.category,
      _id: { $ne: id },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: "A program with this name already exists in this category",
      });
    }

    program.name = name;
    await program.save();

    res.json({
      success: true,
      message: "Program updated successfully",
      program,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.deleteProgram = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid program ID",
      });
    }

    const program = await Program.findById(id);
    if (!program) {
      return res.status(404).json({
        success: false,
        message: "Program not found",
      });
    }

    const [
      classCount,
      userCount,
      registrationRequestCount,
    ] = await Promise.all([
      Class.countDocuments({ program: id }),
      User.countDocuments({ programs: id }),
      RegistrationRequest.countDocuments({ preferredPrograms: id }),
    ]);

    const totalUsage = classCount + userCount + registrationRequestCount;

    if (totalUsage > 0) {
      const connections = [];
      if (classCount > 0) connections.push(`${classCount} class(es)`);
      if (userCount > 0) connections.push(`${userCount} player(s)`);
      if (registrationRequestCount > 0)
        connections.push(`${registrationRequestCount} registration request(s)`);

      return res.status(400).json({
        success: false,
        message: `Cannot delete program as it is currently connected to: ${connections.join(", ")}`,
        data: {
          classCount,
          userCount,
          registrationRequestCount,
        },
      });
    }

    await Program.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Program deleted successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.createTerm = async (req, res) => {
  try {
    const termData = validatedTermData(req.body || {});
    const term = await Term.create(termData);

    res.json({
      message: "Term created successfully",
      data: serializeTerm(term),
    });
  } catch (err) {
    res.status(err instanceof TypeError || err.name === "ValidationError" ? 400 : 500).json({ message: err.message });
  }
};

exports.deleteTerm = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid term ID",
      });
    }

    const term = await Term.findById(id);
    if (!term) {
      return res.status(404).json({
        success: false,
        message: "Term not found",
      });
    }

    const [
      classCount,
      userCount,
      registrationRequestCount,
      teamCount,
      leagueCount,
      eventCount,
    ] = await Promise.all([
      Class.countDocuments({ term: id }),
      User.countDocuments({ term: id }),
      RegistrationRequest.countDocuments({ preferredTerm: id }),
      Team.countDocuments({ term: id }),
      League.countDocuments({ term: id }),
      Event.countDocuments({ termId: id }),
    ]);

    const totalUsage = classCount + userCount + registrationRequestCount + teamCount + leagueCount + eventCount;

    if (totalUsage > 0) {
      const connections = [];
      if (classCount > 0) connections.push(`${classCount} class(es)`);
      if (userCount > 0) connections.push(`${userCount} player(s)`);
      if (registrationRequestCount > 0)
        connections.push(`${registrationRequestCount} registration request(s)`);
      if (teamCount > 0) connections.push(`${teamCount} team(s)`);
      if (leagueCount > 0) connections.push(`${leagueCount} league(s)`);
      if (eventCount > 0) connections.push(`${eventCount} event(s)`);

      return res.status(400).json({
        success: false,
        message: `Cannot delete term as it is currently connected to: ${connections.join(", ")}`,
        data: {
          classCount,
          userCount,
          registrationRequestCount,
          teamCount,
          leagueCount,
          eventCount,
        },
      });
    }

    await Term.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Term deleted successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getAllTerms = async (req, res) => {
  try {
    const { isEvent, year } = req.query;

    const filter = {};

    if (isEvent === "true") {
      filter.isEvent = true;
    } else if (isEvent === "false" || isEvent === undefined) {
      filter.isEvent = false;
    }

    if (year) {
      try { filter.year = ageGroupContextYear(year); }
      catch (error) { return res.status(400).json({ message: error.message }); }
    }

    const terms = await Term.find(filter).sort({
      year: 1,
      startDate: 1,
    });

    res.json({
      data: terms.map(serializeTerm),
    });
  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
};

exports.getTermById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid term ID" });
    const term = await Term.findById(req.params.id);

    if (!term) {
      return res.status(404).json({ message: "Term not found" });
    }

    res.json({ data: serializeTerm(term) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateTerm = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid term ID" });
    const existing = await Term.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: "Term not found" });
    const updatedData = validatedTermData(req.body || {}, existing.toObject());
    await require("../services/termProtection").assertTermHistoryFits(req.params.id, existing, updatedData);
    const term = await Term.findByIdAndUpdate(
      req.params.id,
      updatedData,
      { new: true, runValidators: true }
    );

    if (!term) {
      return res.status(404).json({ message: "Term not found" });
    }

    res.json({
      message: "Term updated successfully",
      data: serializeTerm(term),
    });
  } catch (err) {
    res.status(err.status || (err instanceof TypeError || err.name === "ValidationError" ? 400 : 500)).json({ message: err.message });
  }
};


exports.createClass = async (req, res) => {
  try {
    const {
      name,
      term,
      program,
      category,
      dayOfWeek,
      startTime,
      endTime,
      location,
      coach,
      capacity,
      price,
      scheduleType: rawScheduleType,
      schedule: rawSchedule,
    } = req.body;

    if (price !== undefined && price !== null) {
      const numPrice = Number(price);
      if (isNaN(numPrice) || numPrice < 0) {
        return res.status(400).json({
          message: "Price must be a non-negative number",
        });
      }
    }

    const scheduleType = (rawScheduleType || "SINGLE_DAY").toUpperCase();
    const validScheduleTypes = ["SINGLE_DAY", "WEEKDAYS", "CUSTOM"];
    if (!validScheduleTypes.includes(scheduleType)) {
      return res.status(400).json({
        message: "Invalid scheduleType. Must be SINGLE_DAY, WEEKDAYS, or CUSTOM",
      });
    }

    const validDays = [
      "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"
    ];

    const toMinutes = (t) => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m;
    };

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

    let finalSchedule = [];
    let rootDayOfWeek;
    let rootStartTime;
    let rootEndTime;

    if (scheduleType === "SINGLE_DAY") {
      if (!dayOfWeek || !startTime || !endTime) {
        return res.status(400).json({
          message: "Required fields missing (dayOfWeek, startTime, endTime required for SINGLE_DAY)",
        });
      }

      const day = dayOfWeek.toUpperCase();
      if (!validDays.includes(day)) {
        return res.status(400).json({ message: "Invalid day" });
      }

      if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        return res.status(400).json({ message: "Time must be in HH:mm format" });
      }

      if (toMinutes(startTime) >= toMinutes(endTime)) {
        return res.status(400).json({
          message: "Start time must be before end time",
        });
      }

      rootDayOfWeek = day;
      rootStartTime = startTime;
      rootEndTime = endTime;

    } else if (scheduleType === "WEEKDAYS") {
      if (!startTime || !endTime) {
        return res.status(400).json({
          message: "startTime and endTime are required for WEEKDAYS schedule",
        });
      }

      if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        return res.status(400).json({ message: "Time must be in HH:mm format" });
      }

      if (toMinutes(startTime) >= toMinutes(endTime)) {
        return res.status(400).json({
          message: "Start time must be before end time",
        });
      }

      const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
      finalSchedule = weekdays.map((d) => ({
        dayOfWeek: d,
        startTime,
        endTime,
      }));

      rootDayOfWeek = "MONDAY";
      rootStartTime = startTime;
      rootEndTime = endTime;

    } else if (scheduleType === "CUSTOM") {
      if (!Array.isArray(rawSchedule) || rawSchedule.length === 0) {
        return res.status(400).json({
          message: "schedule array with at least one entry is required for CUSTOM schedule",
        });
      }

      for (let i = 0; i < rawSchedule.length; i++) {
        const entry = rawSchedule[i];
        if (!entry.dayOfWeek || !entry.startTime || !entry.endTime) {
          return res.status(400).json({
            message: `Schedule entry ${i + 1}: dayOfWeek, startTime, and endTime are required`,
          });
        }

        const entryDay = entry.dayOfWeek.toUpperCase();
        if (!validDays.includes(entryDay)) {
          return res.status(400).json({
            message: `Schedule entry ${i + 1}: Invalid day '${entry.dayOfWeek}'`,
          });
        }

        if (!timeRegex.test(entry.startTime) || !timeRegex.test(entry.endTime)) {
          return res.status(400).json({
            message: `Schedule entry ${i + 1}: Time must be in HH:mm format`,
          });
        }

        if (toMinutes(entry.startTime) >= toMinutes(entry.endTime)) {
          return res.status(400).json({
            message: `Schedule entry ${i + 1}: Start time must be before end time`,
          });
        }
      }

      const normalizedEntries = rawSchedule.map((e) => ({
        dayOfWeek: e.dayOfWeek.toUpperCase(),
        startTime: e.startTime,
        endTime: e.endTime,
      }));

      for (let i = 0; i < normalizedEntries.length; i++) {
        for (let j = i + 1; j < normalizedEntries.length; j++) {
          if (normalizedEntries[i].dayOfWeek === normalizedEntries[j].dayOfWeek) {
            const aStart = toMinutes(normalizedEntries[i].startTime);
            const aEnd = toMinutes(normalizedEntries[i].endTime);
            const bStart = toMinutes(normalizedEntries[j].startTime);
            const bEnd = toMinutes(normalizedEntries[j].endTime);
            if (aStart < bEnd && bStart < aEnd) {
              return res.status(400).json({
                message: `Schedule entries ${i + 1} and ${j + 1} overlap on ${normalizedEntries[i].dayOfWeek}`,
              });
            }
          }
        }
      }

      finalSchedule = normalizedEntries;
      rootDayOfWeek = normalizedEntries[0].dayOfWeek;
      rootStartTime = normalizedEntries[0].startTime;
      rootEndTime = normalizedEntries[0].endTime;
    }

    if (!term || !program || !category || !location || !coach || !capacity) {
      return res.status(400).json({
        message: "Required fields missing",
      });
    }

    const termData = await Term.findById(term);
    if (!termData) throw new Error("Term not found");

    const programData = await Program.findById(program);
    if (!programData) throw new Error("Program not found");

    if (programData.category.toString() !== category.toString()) {
      return res.status(400).json({
        message: "Program does not belong to category",
      });
    }

    const coachData = await Admin.findById(coach);
    if (!coachData) {
      return res.status(400).json({ message: "Coach not found" });
    }
    if (coachData.role !== "COACH") {
      return res.status(400).json({ message: "Assigned user is not a coach" });
    }
    if (coachData.isActive === false) {
      return res.status(400).json({ message: "Coach is inactive and cannot be assigned to classes" });
    }

    const entriesToCheck = finalSchedule.length > 0
      ? finalSchedule
      : [{ dayOfWeek: rootDayOfWeek, startTime: rootStartTime, endTime: rootEndTime }];

    for (const entry of entriesToCheck) {
      const overlapRoot = await Class.findOne({
        coach,
        term,
        dayOfWeek: { $regex: new RegExp(`^${entry.dayOfWeek}$`, "i") },
        startTime: { $lt: entry.endTime },
        endTime: { $gt: entry.startTime },
      });

      if (overlapRoot) {
        return res.status(400).json({
          message: `Coach already has overlapping class on ${entry.dayOfWeek} (${entry.startTime}-${entry.endTime})`,
        });
      }

      const overlapSchedule = await Class.findOne({
        coach,
        term,
        "schedule.dayOfWeek": { $regex: new RegExp(`^${entry.dayOfWeek}$`, "i") },
        schedule: {
          $elemMatch: {
            dayOfWeek: { $regex: new RegExp(`^${entry.dayOfWeek}$`, "i") },
            startTime: { $lt: entry.endTime },
            endTime: { $gt: entry.startTime },
          },
        },
      });

      if (overlapSchedule) {
        return res.status(400).json({
          message: `Coach already has overlapping class on ${entry.dayOfWeek} (${entry.startTime}-${entry.endTime})`,
        });
      }
    }

    if (finalSchedule.length > 0) {
      const classesToCreate = finalSchedule.map((entry) => ({
        name,
        term,
        program,
        category,
        dayOfWeek: entry.dayOfWeek,
        startTime: entry.startTime,
        endTime: entry.endTime,
        location,
        coach,
        capacity,
        price: price !== undefined && price !== null ? Number(price) : 0,
        scheduleType: "SINGLE_DAY",
      }));

      const createdClasses = await Class.insertMany(classesToCreate);

      return res.json({
        message: `${createdClasses.length} classes created successfully`,
        data: createdClasses,
      });
    }

    const classData = await Class.create({
      name,
      term,
      program,
      category,
      dayOfWeek: rootDayOfWeek,
      startTime: rootStartTime,
      endTime: rootEndTime,
      location,
      coach,
      capacity,
      price: price !== undefined && price !== null ? Number(price) : 0,
      scheduleType: "SINGLE_DAY",
    });

    return res.json({
      message: "Class created successfully",
      data: classData,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteClassPermanently = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.admin ? req.admin._id : null;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid class ID",
      });
    }

    const cls = await Class.findById(id);
    if (!cls) {
      return res.status(404).json({
        success: false,
        message: "Class not found",
      });
    }

    const chatRooms = await ChatRoom.find({ classId: id });
    const chatRoomIds = chatRooms.map((r) => r._id);

    if (chatRoomIds.length > 0) {
      const messages = await Message.find({ room: { $in: chatRoomIds } });
      messages.forEach((msg) => {
        if (msg.attachments && Array.isArray(msg.attachments)) {
          msg.attachments.forEach((att) => {
            if (att.url && att.url.startsWith("/uploads/")) {
              const filePath = path.join(__dirname, "..", att.url);
              if (fs.existsSync(filePath)) {
                try {
                  fs.unlinkSync(filePath);
                } catch (e) { }
              }
            }
          });
        }
      });

      await Message.deleteMany({ room: { $in: chatRoomIds } });
      await ChatRoom.deleteMany({ classId: id });
    }

    await User.updateMany(
      { $or: [{ assignedClasses: id }, { removedClasses: id }, { temporaryClass: id }] },
      {
        $pull: { assignedClasses: id, removedClasses: id },
        $unset: { temporaryClass: 1 },
      }
    );

    await RegistrationRequest.updateMany(
      { preferredClasses: id },
      { $pull: { preferredClasses: id } }
    );

    const attendanceDeleteResult = await Attendance.deleteMany({ class: id });
    const attendanceHistoryDeleteResult = await AttendanceHistory.deleteMany({ classId: id });

    const coachNotesDeleteResult = await CoachNote.deleteMany({ classId: id });

    const trainingSessionsDeleteResult = await TrainingSession.deleteMany({
      $or: [{ class: id }, { classId: id }],
    });

    await Class.findByIdAndDelete(id);

    if (adminId) {
      await AuditLog.create({
        user: adminId,
        userRole: req.admin?.role || "SUPER_ADMIN",
        action: "CLASS_DELETED_PERMANENTLY",
        entityType: "Class",
        entityId: id,
        ipAddress: req.ip || "",
        deviceInfo: req.headers["user-agent"] || "",
        description: `Permanently deleted class '${cls.name}' (${id}) while preserving invoice records.`,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Class '${cls.name}' and related class data deleted permanently (Invoices preserved)`,
      data: {
        classId: id,
        className: cls.name,
        attendanceDeletedCount: attendanceDeleteResult.deletedCount || 0,
        attendanceHistoryDeletedCount: attendanceHistoryDeleteResult.deletedCount || 0,
        coachNotesDeletedCount: coachNotesDeleteResult.deletedCount || 0,
        trainingSessionsDeletedCount: trainingSessionsDeleteResult.deletedCount || 0,
        chatRoomsDeletedCount: chatRooms.length,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getAllClasses = async (req, res) => {
  try {
    let {
      termId,
      day,
      programId,
      categoryId,
      search = "",
      page = 1,
      limit = 20,
    } = req.query;

    page = Number(page) || 1;
    limit = Number(limit) || 20;

    let filter = {};

    const selectedTerm = termId;
    const selectedDay = day;
    const selectedProgram = programId;
    const selectedCategory = categoryId;

    if (selectedTerm) filter.term = selectedTerm;
    if (selectedDay) {
      filter.$or = [
        { dayOfWeek: { $regex: new RegExp(`^${selectedDay}$`, "i") } },
        { "schedule.dayOfWeek": { $regex: new RegExp(`^${selectedDay}$`, "i") } },
      ];
    }
    if (selectedProgram) filter.program = selectedProgram;
    if (selectedCategory) filter.category = selectedCategory;
    if (search) {
      filter.name = { $regex: search, $options: "i" };
    }

    const total = await Class.countDocuments(filter);

    const classes = await Class.find(filter)
      .populate("term program category coach assistantCoach")
      .sort({ dayOfWeek: 1, startTime: 1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      success: true,
      message: "Classes fetched successfully",
      totalClasses: total,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: classes,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAllClassesForAssign = async (req, res, next) => {
  try {
    const { categoryId, programId, termId, term, status = 'ACTIVE' } = req.query;
    const filter = {};
    for (const [key,value] of [['category',categoryId],['program',programId],['term',termId || term]]) if(value){if(!mongoose.isValidObjectId(value))return res.status(400).json({success:false,message:'Invalid '+key});filter[key]=value;}
    if(status && status !== 'ALL') {if(!['ACTIVE','INACTIVE'].includes(status))return res.status(400).json({message:'Invalid class status'});filter.status=status;}
    const classes=await Class.find(filter).populate('term','name year startDate endDate status').populate('program','name ageGroup status').populate('category','name').sort({dayOfWeek:1,startTime:1,name:1}).lean();
    return res.json({success:true,data:classes.map(({players,...cls})=>({...cls,playerCount:players?.length||0,term:require('../utils/dateTime').serializeTerm(cls.term)}))});
  } catch(error){return next(error);}
};

exports.getClassById = async (req, res) => {
  try {
    const classData = await Class.findById(req.params.id)
      .populate("term program category coach players");

    if (!classData) {
      return res.status(404).json({ message: "Class not found" });
    }

    res.json({ data: classData });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateClass = async (req, res) => {
  try {
    const {
      name,
      term,
      program,
      category,
      dayOfWeek,
      startTime,
      endTime,
      location,
      coach,
      capacity,
      price,
      scheduleType: rawScheduleType,
      schedule: rawSchedule,
    } = req.body;

    if (price !== undefined && price !== null) {
      const numPrice = Number(price);
      if (isNaN(numPrice) || numPrice < 0) {
        return res.status(400).json({
          message: "Price must be a non-negative number",
        });
      }
    }

    const updatedData = {};

    if (name) updatedData.name = name;
    if (location) updatedData.location = location;

    if (term) {
      if (!mongoose.Types.ObjectId.isValid(term)) {
        return res.status(400).json({ message: "Invalid term ID" });
      }
      const termData = await Term.findById(term);
      if (!termData) {
        return res.status(400).json({ message: "Term not found" });
      }
      updatedData.term = term;
    }

    if (program) {
      if (!mongoose.Types.ObjectId.isValid(program)) {
        return res.status(400).json({ message: "Invalid program ID" });
      }
      const programData = await Program.findById(program);
      if (!programData) {
        return res.status(400).json({ message: "Program not found" });
      }
      updatedData.program = program;

      if (category) {
        if (programData.category.toString() !== category) {
          return res.status(400).json({
            message: "Program does not belong to selected category",
          });
        }
      }
    }

    if (category) {
      if (!mongoose.Types.ObjectId.isValid(category)) {
        return res.status(400).json({ message: "Invalid category ID" });
      }
      const categoryData = await Category.findById(category);
      if (!categoryData) {
        return res.status(400).json({ message: "Category not found" });
      }
      updatedData.category = category;
    }

    if (coach) {
      if (!mongoose.Types.ObjectId.isValid(coach)) {
        return res.status(400).json({ message: "Invalid coach ID" });
      }
      const coachData = await Admin.findById(coach);
      if (!coachData) {
        return res.status(400).json({ message: "Coach not found" });
      }
      if (coachData.role !== "COACH") {
        return res.status(400).json({ message: "Assigned user is not a coach" });
      }
      if (coachData.isActive === false) {
        return res.status(400).json({ message: "Coach is inactive and cannot be assigned to classes" });
      }
      updatedData.coach = coach;
    }

    if (dayOfWeek) {
      const validDays = [
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
        "SATURDAY",
        "SUNDAY",
      ];

      if (!validDays.includes(dayOfWeek)) {
        return res.status(400).json({
          message: "Invalid day of week",
        });
      }

      updatedData.dayOfWeek = dayOfWeek;
    }

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

    if (startTime) {
      if (!timeRegex.test(startTime)) {
        return res.status(400).json({
          message: "Start time must be HH:mm format",
        });
      }
      updatedData.startTime = startTime;
    }

    if (endTime) {
      if (!timeRegex.test(endTime)) {
        return res.status(400).json({
          message: "End time must be HH:mm format",
        });
      }
      updatedData.endTime = endTime;
    }

    if (startTime && endTime) {
      const toMinutes = (t) => {
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
      };

      if (toMinutes(startTime) >= toMinutes(endTime)) {
        return res.status(400).json({
          message: "Start time must be before end time",
        });
      }
    }

    if (capacity !== undefined) {
      if (capacity < 1 || capacity > 200) {
        return res.status(400).json({
          message: "Capacity must be between 1 and 200",
        });
      }
      updatedData.capacity = capacity;
    }

    if (price !== undefined && price !== null) {
      updatedData.price = Number(price);
    }

    if (rawScheduleType) {
      const validScheduleTypes = ["SINGLE_DAY", "WEEKDAYS", "CUSTOM"];
      const st = rawScheduleType.toUpperCase();
      if (!validScheduleTypes.includes(st)) {
        return res.status(400).json({ message: "Invalid scheduleType" });
      }
      updatedData.scheduleType = st;

      if (st === "WEEKDAYS") {
        const sTime = startTime || updatedData.startTime;
        const eTime = endTime || updatedData.endTime;
        if (sTime && eTime) {
          const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
          updatedData.schedule = weekdays.map((d) => ({ dayOfWeek: d, startTime: sTime, endTime: eTime }));
          updatedData.dayOfWeek = "MONDAY";
        }
      } else if (st === "CUSTOM" && Array.isArray(rawSchedule) && rawSchedule.length > 0) {
        const validDaysArr = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
        const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
        const normalized = rawSchedule.map((e) => ({
          dayOfWeek: (e.dayOfWeek || "").toUpperCase(),
          startTime: e.startTime,
          endTime: e.endTime,
        }));
        for (const e of normalized) {
          if (!validDaysArr.includes(e.dayOfWeek) || !e.startTime || !e.endTime) {
            return res.status(400).json({ message: "Invalid schedule entry" });
          }
          if (toMin(e.startTime) >= toMin(e.endTime)) {
            return res.status(400).json({ message: `Schedule ${e.dayOfWeek}: start must be before end` });
          }
        }
        updatedData.schedule = normalized;
        updatedData.dayOfWeek = normalized[0].dayOfWeek;
        updatedData.startTime = normalized[0].startTime;
        updatedData.endTime = normalized[0].endTime;
      } else if (st === "SINGLE_DAY") {
        updatedData.schedule = [];
      }
    }

    if (coach || dayOfWeek || startTime || endTime) {
      const existing = await Class.findOne({
        _id: { $ne: req.params.id },
        coach: coach || undefined,
        dayOfWeek: dayOfWeek || undefined,
        startTime: startTime || undefined,
        endTime: endTime || undefined,
      });

      if (existing) {
        return res.status(400).json({
          message: "Coach already has a class at this time",
        });
      }
    }

    const classData = await Class.findByIdAndUpdate(
      req.params.id,
      updatedData,
      { new: true, runValidators: true }
    );

    if (!classData) {
      return res.status(404).json({ message: "Class not found" });
    }

    res.json({
      message: "Class updated successfully",
      data: classData,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.duplicateClass = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const sourceClass = await Class.findById(req.params.id).session(session);
    if (!sourceClass) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Class not found" });
    }

    const body = req.body || {};
    const copyPlayers = body.copyPlayers === true || body.copyPlayers === "true";
    const className = String(body.name || `${sourceClass.name || "Class"} Copy`).trim();
    const targetTerm = body.term || sourceClass.term;
    const targetProgram = body.program || sourceClass.program;
    const targetCategory = body.category || sourceClass.category;
    const targetCoach = body.coach || sourceClass.coach;
    const targetDay = String(body.dayOfWeek || sourceClass.dayOfWeek || "").toUpperCase();
    const targetStart = body.startTime || sourceClass.startTime;
    const targetEnd = body.endTime || sourceClass.endTime;
    const targetCapacity = Number(body.capacity ?? sourceClass.capacity ?? 20);

    if (!className || !targetTerm || !targetProgram || !targetCategory || !targetDay || !targetStart || !targetEnd) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Class name, term, category, program, schedule, and times are required" });
    }

    if (!Number.isFinite(targetCapacity) || targetCapacity < 1 || targetCapacity > 200) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Capacity must be between 1 and 200" });
    }

    const sourcePlayerIds = (sourceClass.players || []).map((playerId) => String(playerId));
    if (copyPlayers && sourcePlayerIds.length > targetCapacity) {
      await session.abortTransaction();
      return res.status(400).json({
        message: `The duplicate capacity (${targetCapacity}) is smaller than the ${sourcePlayerIds.length} assigned players.`,
      });
    }

    if (targetCoach) {
      const overlappingClass = await Class.findOne({
        _id: { $ne: sourceClass._id },
        coach: targetCoach,
        term: targetTerm,
        dayOfWeek: targetDay,
        startTime: { $lt: targetEnd },
        endTime: { $gt: targetStart },
      }).session(session);
      if (overlappingClass) {
        await session.abortTransaction();
        return res.status(409).json({
          message: `Coach already has an overlapping class on ${targetDay} (${targetStart}-${targetEnd})`,
        });
      }
    }

    const duplicateMatch = await Class.findOne({
      term: targetTerm,
      category: targetCategory,
      program: targetProgram,
      name: className,
      dayOfWeek: targetDay,
      startTime: targetStart,
    }).session(session);
    if (duplicateMatch) {
      await session.abortTransaction();
      return res.status(409).json({ message: "A class with the same name, program, term, day, and start time already exists" });
    }

    const sourceSchedule = Array.isArray(sourceClass.schedule) ? sourceClass.schedule : [];
    const schedule = Array.isArray(body.schedule) ? body.schedule : sourceSchedule;
    const [newClass] = await Class.create([{
      name: className,
      term: targetTerm,
      program: targetProgram,
      category: targetCategory,
      dayOfWeek: targetDay,
      startTime: targetStart,
      endTime: targetEnd,
      location: body.location ?? sourceClass.location,
      venue: body.venue ?? sourceClass.venue,
      coach: targetCoach,
      assistantCoach: body.assistantCoach ?? sourceClass.assistantCoach,
      capacity: targetCapacity,
      price: Number(body.price ?? sourceClass.price ?? 0),
      players: copyPlayers ? sourceClass.players : [],
      trainingType: sourceClass.trainingType,
      sessionDuration: sourceClass.sessionDuration,
      equipmentRequired: sourceClass.equipmentRequired || [],
      status: sourceClass.status,
      scheduleType: body.scheduleType || sourceClass.scheduleType || "SINGLE_DAY",
      schedule,
    }], { session });

    let copiedPlayers = 0;
    if (copyPlayers && sourcePlayerIds.length > 0) {
      const users = await User.find({ _id: { $in: sourcePlayerIds } }).session(session);
      for (const user of users) {
        const sourcePayment = (user.classPaymentStatuses || []).find(
          (entry) => String(entry.class) === String(sourceClass._id)
        );
        user.assignedClasses = user.assignedClasses || [];
        const hasNewClass = user.assignedClasses.some(
          (assignedClass) => String(assignedClass) === String(newClass._id)
        );
        if (!hasNewClass) user.assignedClasses.push(newClass._id);
        user.classPaymentStatuses = user.classPaymentStatuses || [];
        const existingPayment = user.classPaymentStatuses.find(
          (entry) => String(entry.class) === String(newClass._id)
        );
        if (!existingPayment) {
          user.classPaymentStatuses.push({
            class: newClass._id,
            paymentStatus: sourcePayment?.paymentStatus || "TRIAL",
          });
        }
        await user.save({ session });
        copiedPlayers += 1;
      }
    }

    await session.commitTransaction();
    return res.status(201).json({
      message: copyPlayers
        ? `Class duplicated with ${copiedPlayers} players and payment statuses copied`
        : "Class duplicated successfully",
      data: newClass,
      copiedPlayers,
      copyPlayers,
    });
  } catch (error) {
    await session.abortTransaction();
    return res.status(500).json({ message: error.message });
  } finally {
    await session.endSession();
  }
};

exports.getCurrentYearTerms = async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();

    const terms = await Term.find({ year: currentYear }).sort({
      startDate: 1,
    });

    res.json({
      message: "Current year terms fetched successfully",
      count: terms.length,
      data: terms,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getClassesByTerm = async (req, res) => {
  try {
    const { termId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(termId)) {
      return res.status(400).json({ message: "Invalid term ID" });
    }

    const term = await Term.findById(termId);
    if (!term) {
      return res.status(404).json({ message: "Term not found" });
    }

    const classes = await Class.find({ term: termId })
      .populate("program", "name")
      .populate("category", "name")
      .populate("coach", "fullName")
      .sort({ dayOfWeek: 1, startTime: 1 });

    res.json({
      message: "Classes fetched successfully",
      term: term.name,
      count: classes.length,
      data: classes,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const _generateDatesForDay = (start, end, targetDay) => {
  const dates = [];
  let current = new Date(start);

  while (current.getUTCDay() !== targetDay) {
    current.setUTCDate(current.getUTCDate() + 1);
  }

  while (current <= end) {
    dates.push(new Date(current));
    current.setUTCDate(current.getUTCDate() + 7);
  }

  return dates;
};

const DAY_MAP = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

const generateClassSessions = (term, classObj) => {
  const sessions = [];
  if (classObj && classObj.sessionDates && Array.isArray(classObj.sessionDates) && classObj.sessionDates.length > 0) {
    let sorted = [...classObj.sessionDates]
      .map((d) => {
        const date = new Date(d);
        date.setUTCHours(0, 0, 0, 0);
        return date;
      })
      .sort((a, b) => a.getTime() - b.getTime());

    const roundLimit = Number(classObj.round || classObj.rounds || classObj.numberOfRounds);
    if (roundLimit && roundLimit > 0) {
      sorted = sorted.slice(0, roundLimit);
    }
    return sorted;
  }
  if (!term || !term.startDate || !term.endDate) return sessions;

  const start = new Date(term.startDate);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(term.endDate);
  end.setUTCHours(0, 0, 0, 0);

  const scheduleType = classObj.scheduleType || "SINGLE_DAY";
  const schedule = classObj.schedule || [];

  if ((scheduleType === "WEEKDAYS" || scheduleType === "CUSTOM") && schedule.length > 0) {

    for (const entry of schedule) {
      const targetDay = DAY_MAP[(entry.dayOfWeek || "").toUpperCase()];
      if (targetDay === undefined) continue;
      const dates = _generateDatesForDay(start, end, targetDay);
      sessions.push(...dates);
    }

    sessions.sort((a, b) => a.getTime() - b.getTime());
  } else {
    if (!classObj.dayOfWeek) return sessions;
    const targetDay = DAY_MAP[classObj.dayOfWeek.toUpperCase()];
    if (targetDay === undefined) return sessions;
    const dates = _generateDatesForDay(start, end, targetDay);
    sessions.push(...dates);
  }

  const roundLimit = Number(classObj?.round || classObj?.rounds || classObj?.numberOfRounds);
  if (roundLimit && roundLimit > 0) {
    return sessions.slice(0, roundLimit);
  }

  return sessions;
};

const generateClassSessionsEnriched = (term, classObj) => {
  const sessions = [];
  const dayNames = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

  if (classObj && classObj.sessionDates && Array.isArray(classObj.sessionDates) && classObj.sessionDates.length > 0) {
    let sortedDates = [...classObj.sessionDates]
      .map((d) => {
        const date = new Date(d);
        date.setUTCHours(0, 0, 0, 0);
        return date;
      })
      .sort((a, b) => a.getTime() - b.getTime());

    const roundLimit = Number(classObj.round || classObj.rounds || classObj.numberOfRounds);
    if (roundLimit && roundLimit > 0) {
      sortedDates = sortedDates.slice(0, roundLimit);
    }

    sortedDates.forEach((d, idx) => {
      sessions.push({
        date: d,
        dayOfWeek: dayNames[d.getUTCDay()],
        startTime: classObj.startTime || "",
        endTime: classObj.endTime || "",
        round: idx + 1,
      });
    });
    return sessions;
  }

  if (!term || !term.startDate || !term.endDate) return sessions;

  const start = new Date(term.startDate);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(term.endDate);
  end.setUTCHours(0, 0, 0, 0);

  const scheduleType = classObj.scheduleType || "SINGLE_DAY";
  const schedule = classObj.schedule || [];

  if ((scheduleType === "WEEKDAYS" || scheduleType === "CUSTOM") && schedule.length > 0) {
    for (const entry of schedule) {
      const targetDay = DAY_MAP[(entry.dayOfWeek || "").toUpperCase()];
      if (targetDay === undefined) continue;
      const dates = _generateDatesForDay(start, end, targetDay);
      for (const d of dates) {
        sessions.push({
          date: d,
          dayOfWeek: entry.dayOfWeek.toUpperCase(),
          startTime: entry.startTime,
          endTime: entry.endTime,
        });
      }
    }
    sessions.sort((a, b) => a.date.getTime() - b.date.getTime());
  } else {
    if (!classObj.dayOfWeek) return sessions;
    const targetDay = DAY_MAP[classObj.dayOfWeek.toUpperCase()];
    if (targetDay === undefined) return sessions;
    const dates = _generateDatesForDay(start, end, targetDay);
    for (const d of dates) {
      sessions.push({
        date: d,
        dayOfWeek: classObj.dayOfWeek.toUpperCase(),
        startTime: classObj.startTime,
        endTime: classObj.endTime,
      });
    }
  }

  const roundLimit = Number(classObj?.round || classObj?.rounds || classObj?.numberOfRounds);
  if (roundLimit && roundLimit > 0) {
    const limited = sessions.slice(0, roundLimit);
    limited.forEach((s, idx) => {
      s.round = idx + 1;
    });
    return limited;
  }

  sessions.forEach((s, idx) => {
    s.round = idx + 1;
  });

  return sessions;
};

const getSessionTimesForDate = (classObj, sessionDate) => {
  const dayNames = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const scheduleType = classObj.scheduleType || "SINGLE_DAY";
  const schedule = classObj.schedule || [];

  if ((scheduleType === "WEEKDAYS" || scheduleType === "CUSTOM") && schedule.length > 0) {
    const dayName = dayNames[new Date(sessionDate).getUTCDay()];
    const entry = schedule.find((e) => (e.dayOfWeek || "").toUpperCase() === dayName);
    if (entry) {
      return { startTime: entry.startTime, endTime: entry.endTime };
    }
  }
  return { startTime: classObj.startTime, endTime: classObj.endTime };
};

exports.getClassSessions = async (req, res) => {
  try {
    const classData = await Class.findById(req.params.classId).populate("term");

    if (!classData) {
      return res.status(404).json({ message: "Class not found" });
    }

    const enrichedSessions = generateClassSessionsEnriched(classData.term, classData);

    const formatted = enrichedSessions.map((s) => ({
      fullDate: s.date,
      day: s.date.getUTCDate(),
      month: s.date.getUTCMonth() + 1,
      year: s.date.getUTCFullYear(),
      dayOfWeek: s.dayOfWeek,
      startTime: s.startTime,
      endTime: s.endTime,
    }));

    const grouped = {};

    formatted.forEach((s) => {
      const key = `${s.month}-${s.year}`;

      if (!grouped[key]) {
        grouped[key] = [];
      }

      grouped[key].push(s.day);
    });

    res.json({
      totalSessions: enrichedSessions.length,
      scheduleType: classData.scheduleType || "SINGLE_DAY",
      schedule: classData.schedule || [],
      sessions: formatted,
      groupedByMonth: grouped,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


exports.markAttendance = require('../services/attendanceService').markAttendance;

exports.markSingleAttendance = require('../services/attendanceService').markSingleAttendance;

exports.getAttendanceByClass = async (req, res) => {
  try {
    const { classId } = req.params;

    const data = await Attendance.find({ class: classId })
      .select("sessionDate records")
      .populate({
        path: "records.player",
        select: "fullName profile email phone",
      })
      .sort({ sessionDate: 1 });

    const attendanceMap = {};

    data.forEach((att) => {
      const date = att.sessionDate.toISOString().split("T")[0];

      attendanceMap[date] = {};

      att.records.forEach((r) => {
        const player = r.player;

        attendanceMap[date][player._id] = {
          status: r.status,
          reason: r.reason || r.remarks || "",
          markedByParent: r.markedByParent || false,
          fullName: player.fullName,
          profile: player.profile,
          email: player.email,
          phone: player.phone,
        };
      });
    });

    res.json({
      attendanceMap,
      totalSessions: data.length,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


exports.getAttendanceByDate = async (req, res) => {
  try {
    const { classId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        message: "date is required",
      });
    }

    const sessionDate = new Date(date);
    sessionDate.setUTCHours(0, 0, 0, 0);

    const attendance = await Attendance.findOne({
      class: classId,
      sessionDate,
    }).populate({
      path: "records.player",
      select: "fullName profile email phone",
    });

    if (!attendance) {
      return res.json({
        sessionDate,
        records: [],
        attendanceMap: {},
      });
    }

    const attendanceMap = {};

    attendance.records.forEach((r) => {
      const player = r.player;

      attendanceMap[player._id] = {
        status: r.status,
        fullName: player.fullName,
        profile: player.profile,
        email: player.email,
        phone: player.phone,
      };
    });

    res.json({
      sessionDate: attendance.sessionDate,
      attendanceMap,
      totalPlayers: attendance.records.length,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createCoach = async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body || {};

    if (!fullName || !email || !phone || !password) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    const existing = await Admin.findOne({
      $or: [{ email }, { phone }],
    });

    if (existing) {
      return res.status(400).json({
        message: "Email or phone already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const coach = await Admin.create({
      name: fullName,
      email,
      mobile: phone,
      password: hashedPassword,
      role: "COACH",
      profileImage: req.file ? `uploads/profiles/${req.file.filename}` : null,
    });

    res.json({
      message: "Coach created successfully",
      data: coach,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAllCoaches = async (req, res) => {
  try {
    const coaches = await Admin.find({ role: "COACH" })
      .select("-password")
      .sort({ createdAt: -1 });

    res.json({ data: coaches });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getCoachById = async (req, res) => {
  try {
    const coach = await Admin.findOne({
      _id: req.params.id,
      role: "COACH",
    }).select("-password");

    if (!coach) {
      return res.status(404).json({
        message: "Coach not found",
      });
    }

    res.json({ data: coach });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getCoachDetail = async (req, res) => {
  try {
    const { coachId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(coachId)) {
      return res.status(400).json({ success: false, message: "Invalid coach id" });
    }

    const coach = await Admin.findOne({ _id: coachId, role: "COACH" })
      .select("name email mobile profileImage isActive createdAt")
      .lean();
    if (!coach) {
      return res.status(404).json({ success: false, message: "Coach not found" });
    }

    const classes = await Class.find({
      $or: [{ coach: coach._id }, { assistantCoach: coach._id }],
    })
      .populate("term", "name year startDate endDate")
      .populate("program", "name")
      .populate("category", "name")
      .populate("coach", "name profileImage")
      .populate("assistantCoach", "name profileImage")
      .populate("players", "fullName firstName lastName profileImage")
      .sort({ createdAt: -1 })
      .lean();

    const classIds = classes.map((item) => item._id);
    const [attendanceRecords, notes] = await Promise.all([
      classIds.length
        ? Attendance.find({ class: { $in: classIds } })
            .populate("markedBy", "name")
            .sort({ sessionDate: -1, updatedAt: -1 })
            .lean()
        : [],
      CoachNote.find({ coach: coach._id })
        .populate("classId", "name")
        .sort({ createdAt: -1 })
        .limit(30)
        .lean(),
    ]);

    const classById = new Map(classes.map((item) => [String(item._id), item]));
    const rollup = () => ({ sessions: 0, present: 0, late: 0, absent: 0, notMarked: 0 });
    const totals = rollup();
    const perClass = new Map(classes.map((item) => [String(item._id), rollup()]));

    const sessionSummaries = attendanceRecords.map((attendance) => {
      const counts = rollup();
      counts.sessions = 1;
      for (const record of attendance.records || []) {
        const status = String(record.status || "NOT_MARKED").toUpperCase();
        if (status === "PRESENT") counts.present += 1;
        else if (status === "LATE") counts.late += 1;
        else if (status === "ABSENT") counts.absent += 1;
        else counts.notMarked += 1;
      }
      const id = String(attendance.class?._id || attendance.class || "");
      const bucket = perClass.get(id);
      if (bucket) {
        bucket.sessions += 1;
        bucket.present += counts.present;
        bucket.late += counts.late;
        bucket.absent += counts.absent;
        bucket.notMarked += counts.notMarked;
      }
      totals.sessions += 1;
      totals.present += counts.present;
      totals.late += counts.late;
      totals.absent += counts.absent;
      totals.notMarked += counts.notMarked;
      const cls = classById.get(id);
      return {
        id: attendance._id,
        classId: id,
        className: cls?.name || "Class",
        sessionDate: attendance.sessionDate,
        updatedAt: attendance.updatedAt,
        markedByCoach: String(attendance.markedBy?._id || attendance.markedBy || "") === String(coach._id),
        markedBy: attendance.markedBy?.name || "Unknown",
        ...counts,
      };
    });

    const attendanceRate = (counts) => {
      const marked = counts.present + counts.late + counts.absent;
      return marked ? Math.round(((counts.present + counts.late) / marked) * 100) : 0;
    };
    const formattedClasses = classes.map((item) => {
      const stats = perClass.get(String(item._id)) || rollup();
      return {
        id: item._id,
        name: item.name || "Unnamed class",
        role: String(item.coach?._id || item.coach || "") === String(coach._id) ? "HEAD" : "ASSISTANT",
        term: item.term,
        program: item.program,
        category: item.category,
        dayOfWeek: item.dayOfWeek,
        schedule: item.schedule || [],
        startTime: item.startTime,
        endTime: item.endTime,
        location: item.location || item.venue || "",
        status: item.status,
        playerCount: Array.isArray(item.players) ? item.players.length : 0,
        players: (item.players || []).map((player) => ({
          id: player._id,
          name: player.fullName || [player.firstName, player.lastName].filter(Boolean).join(" ") || "Player",
          profileImage: player.profileImage || null,
        })),
        coach: item.coach,
        assistantCoach: item.assistantCoach,
        attendance: { ...stats, rate: attendanceRate(stats) },
      };
    });

    const activity = [
      ...sessionSummaries.map((session) => ({
        id: `attendance-${session.id}`,
        type: "ATTENDANCE",
        title: "Class attendance recorded",
        description: `${session.present} present, ${session.late} late, ${session.absent} absent · marked by ${session.markedBy}`,
        date: session.updatedAt || session.sessionDate,
        classId: session.classId,
        className: session.className,
      })),
      ...notes.map((note) => ({
        id: `note-${note._id}`,
        type: "COACH_NOTE",
        title: String(note.noteType || "Coach note").replace(/_/g, " ").toLowerCase(),
        description: note.description || "Coach note added",
        date: note.createdAt,
        classId: note.classId?._id ? String(note.classId._id) : null,
        className: note.classId?.name || null,
      })),
    ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 40);

    res.json({
      success: true,
      data: {
        coach,
        summary: {
          assignedClasses: formattedClasses.length,
          playerEnrollments: formattedClasses.reduce((sum, item) => sum + item.playerCount, 0),
          attendanceSessions: totals.sessions,
          attendanceRate: attendanceRate(totals),
          sessionsMarkedByCoach: sessionSummaries.filter((item) => item.markedByCoach).length,
        },
        classes: formattedClasses,
        attendance: sessionSummaries,
        activity,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateCoach = async (req, res) => {
  try {
    const coachId = req.params.id;
    const body = req.body || {};
    const newMobile = body.mobile || body.phone;
    const newEmail = body.email;

    if (newMobile) {
      const existingAdminMobile = await Admin.findOne({
        mobile: newMobile,
        _id: { $ne: coachId },
      });
      const existingParentMobile = await Parent.findOne({
        phone: newMobile,
      });

      if (existingAdminMobile || existingParentMobile) {
        return res.status(400).json({
          message: "Mobile number is already registered by another user.",
        });
      }
    }

    if (newEmail) {
      const existingAdminEmail = await Admin.findOne({
        email: newEmail.toLowerCase(),
        _id: { $ne: coachId },
      });
      const existingParentEmail = await Parent.findOne({
        email: newEmail.toLowerCase(),
      });

      if (existingAdminEmail || existingParentEmail) {
        return res.status(400).json({
          message: "Email is already registered by another user.",
        });
      }
    }

    const updateData = { ...body };
    if (req.file) {
      updateData.profileImage = `uploads/profiles/${req.file.filename}`;
    }

    const coach = await Admin.findOneAndUpdate(
      { _id: coachId, role: "COACH" },
      updateData,
      { new: true, runValidators: true }
    ).select("-password");

    if (!coach) {
      return res.status(404).json({
        message: "Coach not found",
      });
    }

    res.json({
      message: "Coach updated successfully",
      data: coach,
    });

  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        message: "Email or mobile number is already registered by another user.",
      });
    }
    res.status(500).json({ message: err.message });
  }
};

exports.toggleCoachActiveStatus = async (req, res) => {
  try {
    const coachId = req.params.id;

    const coach = await Admin.findOne({
      _id: coachId,
      role: "COACH",
    });

    if (!coach) {
      return res.status(404).json({
        message: "Coach not found",
      });
    }

    coach.isActive = !coach.isActive;

    await coach.save();

    return res.json({
      success: true,
      message: `Coach status updated to ${coach.isActive ? "ACTIVE" : "INACTIVE"
        }`,
      data: {
        _id: coach._id,
        name: coach.name,
        email: coach.email,
        role: coach.role,
        isActive: coach.isActive,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.changeCoachPassword = async (req, res) => {
  try {
    const coachId = req.params.id;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        message: "Password is required",
      });
    }

    const coach = await Admin.findOne({ _id: coachId, role: "COACH" });
    if (!coach) {
      return res.status(404).json({
        message: "Coach not found",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    coach.password = hashedPassword;
    await coach.save();

    res.json({
      success: true,
      message: "Coach password updated successfully",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};



exports.getClassPlayers = async (req, res) => {
  try {
    const { classId } = req.params;

    const classData = await Class.findById(classId)
      .populate({
        path: "players",
        select: "-password -tokens",
        populate: [
          { path: "category", select: "name" },
          { path: "programs", select: "name" },
        ],
      })
      .populate("coach", "fullName email")
      .populate("term", "name year");

    if (!classData) {
      return res.status(404).json({
        message: "Class not found",
      });
    }

    const formattedPlayers = classData.players.map((p) => {
      const pObj = p.toObject ? p.toObject() : { ...p };
      const cps = (p.classPaymentStatuses || []).find(
        (item) => item.class && item.class.toString() === classId.toString()
      );
      pObj.paymentStatus = normalizePaymentStatus(cps?.paymentStatus, "TRIAL");
      return pObj;
    }).sort(comparePlayersByPaymentStatus);

    res.json({
      class: {
        _id: classData._id,
        dayOfWeek: classData.dayOfWeek,
        startTime: classData.startTime,
        endTime: classData.endTime,
        location: classData.location,
        coach: classData.coach,
        term: classData.term,
      },
      totalPlayers: classData.players.length,
      players: formattedPlayers,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getCoachClassesWithSessions = async (req, res) => {
  try {
    const coachId = req.params.coachId;

    const classes = await Class.find({ coach: coachId })
      .populate("term", "name startDate endDate")
      .populate("program", "name")
      .populate("category", "name")
      .populate("players", "fullName profile")
      .sort({ createdAt: -1 });

    const result = [];

    for (const cls of classes) {
      const sessions = generateClassSessions(cls.term, cls);
      const formattedSessions = sessions.map((date) => {
        const d = new Date(date);

        return {
          date: d.toISOString().split("T")[0],
          day: d.getUTCDate(),
          month: d.getUTCMonth() + 1,
          year: d.getUTCFullYear(),
        };
      });

      result.push({
        classId: cls._id,
        className: cls.name,
        dayOfWeek: cls.dayOfWeek,
        startTime: cls.startTime,
        endTime: cls.endTime,
        location: cls.location,

        term: cls.term,
        program: cls.program,
        category: cls.category,

        totalPlayers: cls.players.length,
        players: cls.players,

        totalSessions: formattedSessions.length,
        sessions: formattedSessions,
      });
    }

    res.json({
      success: true,
      message: "Coach classes with sessions fetched",
      totalClasses: result.length,
      data: result,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getClassFiltersWithTimeSlots = async (req, res) => {
  try {
    const { categoryId, programId, day, termId, term } = req.query;
    const selectedTerm = termId || term;
    const { WEEKDAYS, weekday, classOccurrences, compareOccurrences } = require("../utils/classSchedule");
    const allDays = !day || ["ALL", "VIEW ALL"].includes(String(day).trim().toUpperCase());
    const selectedDay = allDays ? null : weekday(day);
    if (!allDays && !selectedDay) return res.status(400).json({ message: "Choose a weekday or View All" });

    const query = {};
    for (const [key, value] of [["category", categoryId], ["program", programId], ["term", selectedTerm]]) {
      if (!value) continue;
      if (!mongoose.Types.ObjectId.isValid(value)) return res.status(400).json({ message: `Invalid ${key} ID` });
      query[key] = value;
    }
    if (selectedDay) {
      query.$or = [
        { dayOfWeek: { $regex: new RegExp(`^${selectedDay}$`, "i") } },
        { "schedule.dayOfWeek": { $regex: new RegExp(`^${selectedDay}$`, "i") } },
        { scheduleType: "WEEKDAYS" },
      ];
    }

    const classes = await Class.find(query)
      .select("name dayOfWeek startTime endTime scheduleType schedule coach category program term players status")
      .populate("coach", "name")
      .populate("category", "name")
      .populate("program", "name")
      .populate("term", "name year startDate endDate")
      .lean();

    const categories = [...new Map(
      classes.filter(c => c.category).map(c => [c.category._id.toString(), c.category])
    ).values()];

    const programs = [...new Map(
      classes.filter(c => c.program).map(c => [c.program._id.toString(), c.program])
    ).values()];

    const terms = [...new Map(
      classes.filter(c => c.term).map(c => [c.term._id.toString(), serializeTerm(c.term)])
    ).values()];

    const allOccurrences = classes.flatMap((c) => classOccurrences(c));
    const days = WEEKDAYS.filter((value) => allOccurrences.some((slot) => slot.dayOfWeek === value));
    const timeSlots = allOccurrences.filter((slot) => !selectedDay || slot.dayOfWeek === selectedDay).sort(compareOccurrences);

    res.json({
      terms,
      categories,
      programs,
      days,
      timeSlots,
      totalClasses: new Set(timeSlots.map((slot) => String(slot.classId))).size,
      totalOccurrences: timeSlots.length,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getClassFullTable = async (req, res) => {
  try {
    const { classId } = req.query;

    const cls = await Class.findById(classId)
      .populate("term")
      .populate("coach", "name")
      .populate({
        path: "players",
        select:
          "fullName email dob phone contactName classPaymentStatuses isMedicalCondition medicalConditionDetails rating prefferedFoot parentId profileImage",
        populate: {
          path: "parentId",
          select: "fullName email phone profileImage",
        },
      });

    if (!cls) {
      return res.status(404).json({ message: "Class not found" });
    }

    const allSessions = generateClassSessions(cls.term, cls);

    const sessionDates = allSessions.map((d) =>
      new Date(d).toISOString().split("T")[0]
    );

    const attendanceData = await Attendance.find({
      class: classId,
    }).select("sessionDate records");

    const attendanceMap = {};

    attendanceData.forEach((att) => {
      const date = new Date(att.sessionDate)
        .toISOString()
        .split("T")[0];

      if (!attendanceMap[date]) attendanceMap[date] = {};

      att.records.forEach((r) => {
        attendanceMap[date][r.player.toString()] = {
          status: r.status,
          reason: r.reason || r.remarks || "",
          markedByParent: r.markedByParent || false,
          comment: r.comment || "",
          lateArrival: r.lateArrival || false,
        };
      });
    });

    const players = cls.players.map((player) => {
      const attendance = {};
      const attendanceDetails = {};

      sessionDates.forEach((date) => {
        const rec = attendanceMap[date]?.[player._id];
        const status = rec?.status || "NOT_MARKED";
        attendance[date] = status;
        attendanceDetails[date] = {
          status,
          reason: rec?.reason || "",
          markedByParent: rec?.markedByParent || false,
          comment: rec?.comment || "",
        };
      });

      return {
        playerId: player._id,
        name: player.fullName,
        email: player.email,
        dob: player.dob,
        phone: player.phone,
        profileImage: player.profileImage,
        guardian: player.contactName,
        isMedicalCondition: player.isMedicalCondition,
        medicalConditionDetails: player.medicalConditionDetails,
        rating: player.rating,
        prefferedFoot: player.prefferedFoot,
        paymentStatus: normalizePaymentStatus(
          (player.classPaymentStatuses || []).find(
            (item) => item.class && item.class.toString() === classId.toString()
          )?.paymentStatus,
          "TRIAL"
        ),
        parent: player.parentId
          ? {
            id: player.parentId._id,
            name: player.parentId.fullName,
            email: player.parentId.email,
            phone: player.parentId.phone,
            profileImage: player.parentId.profileImage,
          }
          : null,
        attendance,
        attendanceDetails,
      };
    }).sort(comparePlayersByPaymentStatus);

    const broadcastRoom = await ChatRoom.findOne({
      classId: classId,
      type: "BROADCAST",
    }).select("_id");

    res.json({
      classId: cls._id,
      className: cls.name,
      coach: cls.coach ? { _id: cls.coach._id, name: cls.coach.name } : null,
      term: serializeTerm(cls.term),
      broadcastChatRoomId: broadcastRoom ? broadcastRoom._id : null,
      broadcastRoomId: broadcastRoom ? broadcastRoom._id : null,
      totalSessions: sessionDates.length,
      sessions: sessionDates,
      players,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.exportClassCSV = async (req, res) => {
  const { classId } = req.query;

  const cls = await Class.findById(classId)
    .populate("term")
    .populate(
      "players",
      "fullName email dob phone contactName classPaymentStatuses"
    );

  if (!cls) {
    return res.status(404).json({ message: "Class not found" });
  }

  const allSessions = generateClassSessions(cls.term, cls);

  const sessionDates = allSessions.map(
    (d) => new Date(d).toISOString().split("T")[0]
  );

  const attendanceData = await Attendance.find({
    class: classId,
  }).select("sessionDate records");

  const attendanceMap = {};

  attendanceData.forEach((att) => {
    const date = new Date(att.sessionDate)
      .toISOString()
      .split("T")[0];

    attendanceMap[date] = {};

    att.records.forEach((r) => {
      attendanceMap[date][r.player.toString()] = r.status;
    });
  });

  const rows = cls.players.map((player) => {
    const row = {
      Name: player.fullName,
      Email: player.email,
      DOB: player.dob ? formatDateOnly(player.dob) : "",
      Phone: player.phone,
      Guardian: player.contactName,
      "Payment Status": (player.classPaymentStatuses || []).find((item) => item.class && item.class.toString() === classId.toString())?.paymentStatus || "TRIAL"
    };

    sessionDates.forEach((date) => {
      const status =
        attendanceMap[date]?.[player._id] || "NOT_MARKED";

      let symbol = "";
      if (status === "PRESENT") symbol = "✔";
      else if (status === "ABSENT") symbol = "✘";
      else symbol = "";

      row[date] = symbol;
    });

    return row;
  });

  const fields = [
    "Name",
    "Email",
    "DOB",
    "Phone",
    "Guardian",
    "Payment Status",
    ...sessionDates.map((value) => ({ label: formatDateOnly(value), value })),
  ];

  const parser = new Parser({ fields });
  const csv = parser.parse(rows);

  res.header("Content-Type", "text/csv");
  res.attachment(`class-${cls.name}-attendance.csv`);
  res.send(csv);
};

const resolveTeamSessionConfig = (team, leagueId) => {
  let selectedLeague = null;
  if (leagueId) {
    selectedLeague = (team.leagues || []).find(
      (l) => (l.league?._id || l.league)?.toString() === leagueId.toString()
    );
  } else if (team.leagues && team.leagues.length > 0) {
    selectedLeague = team.leagues.find((l) => l.status === "ACTIVE") || team.leagues[0];
  }

  const explicitLeagueDates = selectedLeague?.sessionDates && selectedLeague.sessionDates.length > 0
    ? selectedLeague.sessionDates
    : (selectedLeague?.league?.sessionDates || []);

  const effectiveSessionDates = explicitLeagueDates.length > 0
    ? explicitLeagueDates
    : (team.sessionDates || []);

  const effectiveRound = selectedLeague?.round != null
    ? selectedLeague.round
    : (selectedLeague?.league?.numberOfRounds != null
      ? selectedLeague.league.numberOfRounds
      : (team.round != null ? team.round : null));

  return {
    selectedLeague,
    effectiveSessionDates,
    effectiveRound,
    sessionConfig: {
      ...(team.toObject ? team.toObject() : team),
      sessionDates: effectiveSessionDates,
      round: effectiveRound,
    },
  };
};

exports.getTeamSessions = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { termId, leagueId } = req.query;

    const teamData = await Team.findById(teamId)
      .populate("term")
      .populate("leagues.league", "name season fee sessionDates numberOfRounds");

    if (!teamData) {
      return res.status(404).json({ message: "Team not found" });
    }

    let targetTerm = teamData.term;
    if (termId) {
      const termDoc = await Term.findById(termId);
      if (termDoc) targetTerm = termDoc;
    }

    const { selectedLeague, effectiveRound, sessionConfig } = resolveTeamSessionConfig(teamData, leagueId);

    const enrichedSessions = generateClassSessionsEnriched(targetTerm, sessionConfig);

    const formatted = enrichedSessions.map((s) => ({
      fullDate: s.date,
      day: s.date.getUTCDate(),
      month: s.date.getUTCMonth() + 1,
      year: s.date.getUTCFullYear(),
      dayOfWeek: s.dayOfWeek,
      startTime: s.startTime,
      endTime: s.endTime,
      round: s.round,
    }));

    const grouped = {};
    formatted.forEach((s) => {
      const key = `${s.month}-${s.year}`;
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(s.day);
    });

    res.json({
      round: effectiveRound || null,
      league: selectedLeague ? {
        _id: selectedLeague.league?._id || selectedLeague.league,
        name: selectedLeague.league?.name || "",
        season: selectedLeague.league?.season || "",
        teamFee: selectedLeague.teamFee,
        round: selectedLeague.round,
      } : null,
      totalSessions: enrichedSessions.length,
      scheduleType: teamData.scheduleType || "SINGLE_DAY",
      schedule: teamData.schedule || [],
      sessions: formatted,
      groupedByMonth: grouped,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getTeamFullTable = async (req, res) => {
  try {
    const { teamId, termId, leagueId } = req.query;

    const team = await Team.findById(teamId)
      .populate("term")
      .populate("coach", "name")
      .populate("leagues.league", "name season fee sessionDates numberOfRounds")
      .populate({
        path: "players.player",
        select:
          "firstName lastName fullName email dob phone contactName isMedicalCondition medicalConditionDetails rating prefferedFoot parentId profileImage statistics",
        populate: {
          path: "parentId",
          select: "firstName lastName fullName email phone profileImage",
        },
      })
      .populate({
        path: "leagues.players.player",
        select:
          "firstName lastName fullName email dob phone contactName isMedicalCondition medicalConditionDetails rating prefferedFoot parentId profileImage statistics",
        populate: {
          path: "parentId",
          select: "firstName lastName fullName email phone profileImage",
        },
      });

    if (!team) {
      return res.status(404).json({ message: "Team not found" });
    }

    let targetTerm = team.term;
    if (termId) {
      const termDoc = await Term.findById(termId);
      if (termDoc) targetTerm = termDoc;
    }

    const { selectedLeague, effectiveSessionDates, effectiveRound, sessionConfig } = resolveTeamSessionConfig(team, leagueId);

    const hasExplicitSessions = effectiveSessionDates && effectiveSessionDates.length > 0;
    const generatedSessions = generateClassSessions(targetTerm, sessionConfig);
    const sessionDateSet = new Set(
      generatedSessions.map((d) => new Date(d).toISOString().split("T")[0])
    );

    const attendanceFilter = { team: teamId };
    if (leagueId || selectedLeague?.league) {
      attendanceFilter.league = leagueId || (selectedLeague.league?._id || selectedLeague.league);
    }
    if (!hasExplicitSessions && targetTerm && targetTerm.startDate && targetTerm.endDate) {
      const start = new Date(targetTerm.startDate);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(targetTerm.endDate);
      end.setUTCHours(23, 59, 59, 999);
      attendanceFilter.sessionDate = { $gte: start, $lte: end };
    }

    const attendanceData = await Attendance.find(attendanceFilter).select("sessionDate records league");

    const attendanceMap = {};
    attendanceData.forEach((att) => {
      const date = new Date(att.sessionDate).toISOString().split("T")[0];
      if (!hasExplicitSessions) {
        sessionDateSet.add(date);
      }
      if (!attendanceMap[date]) attendanceMap[date] = {};
      att.records.forEach((r) => {
        attendanceMap[date][r.player.toString()] = {
          status: r.status,
          reason: r.reason || r.remarks || "",
          markedByParent: r.markedByParent || false,
          comment: r.comment || "",
          lateArrival: r.lateArrival || false,
        };
      });
    });

    const sessionDates = Array.from(sessionDateSet).sort();

    const isLeagueView = Boolean(leagueId);
    const sourcePlayers = isLeagueView
      ? (selectedLeague && Array.isArray(selectedLeague.players) ? selectedLeague.players : [])
      : (team.players || []);

    const players = sourcePlayers.map((item) => {
      const player = item.player && typeof item.player === "object" ? item.player : { _id: item.player };
      const attendance = {};
      const attendanceDetails = {};
      sessionDates.forEach((date) => {
        const rec = attendanceMap[date]?.[player._id?.toString()];
        const status = rec?.status || "NOT_MARKED";
        attendance[date] = status;
        attendanceDetails[date] = {
          status,
          reason: rec?.reason || "",
          markedByParent: rec?.markedByParent || false,
          comment: rec?.comment || "",
        };
      });

      const playerStats = item.statistics ? {
        appearances: Number(item.statistics.appearances) || 0,
        goals: Number(item.statistics.goals) || 0,
        assists: Number(item.statistics.assists) || 0,
        cleanSheets: Number(item.statistics.cleanSheets) || 0,
        yellowCards: Number(item.statistics.yellowCards) || 0,
        redCards: Number(item.statistics.redCards) || 0,
        minutesPlayed: Number(item.statistics.minutesPlayed) || 0,
      } : (player.statistics || {
        appearances: 0,
        goals: 0,
        assists: 0,
        cleanSheets: 0,
        yellowCards: 0,
        redCards: 0,
        minutesPlayed: 0,
      });

      const playerRecord = {
        playerId: player._id,
        name: player.fullName || `${player.firstName || ""} ${player.lastName || ""}`.trim() || "N/A",
        email: player.email,
        dob: player.dob,
        phone: player.phone,
        profileImage: player.profileImage,
        guardian: player.contactName,
        isMedicalCondition: player.isMedicalCondition,
        medicalConditionDetails: player.medicalConditionDetails,
        rating: player.rating,
        prefferedFoot: player.prefferedFoot,
        paymentStatus: normalizePaymentStatus(item.paymentStatus, "TRIAL"),
        statistics: playerStats,
        parent: player.parentId
          ? {
            id: player.parentId._id,
            name: player.parentId.fullName || `${player.parentId.firstName || ""} ${player.parentId.lastName || ""}`.trim() || "N/A",
            email: player.parentId.email,
            phone: player.parentId.phone,
            profileImage: player.parentId.profileImage,
          }
          : null,
        attendance,
        attendanceDetails,
      };

      if (isLeagueView) {
        playerRecord.status = item.status || "ACTIVE";
      }

      return playerRecord;
    }).sort(comparePlayersByPaymentStatus);

    const broadcastRoom = await ChatRoom.findOne({
      teamId: teamId,
      type: "BROADCAST",
    }).select("_id");

    res.json({
      teamId: team._id,
      teamName: team.teamName,
      coach: team.coach ? { _id: team.coach._id, name: team.coach.name } : null,
      broadcastChatRoomId: broadcastRoom ? broadcastRoom._id : null,
      broadcastRoomId: broadcastRoom ? broadcastRoom._id : null,
      term: serializeTerm(targetTerm),
      round: effectiveRound || null,
      league: selectedLeague ? {
        _id: selectedLeague.league?._id || selectedLeague.league,
        name: selectedLeague.league?.name || "",
        season: selectedLeague.league?.season || "",
        teamFee: selectedLeague.teamFee,
        round: selectedLeague.round,
      } : null,
      totalSessions: sessionDates.length,
      sessions: sessionDates,
      players,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.exportTeamCSV = async (req, res) => {
  try {
    const { teamId, termId, leagueId } = req.query;

    const team = await Team.findById(teamId)
      .populate("term")
      .populate("leagues.league", "name season fee sessionDates numberOfRounds")
      .populate({
        path: "players.player",
        select: "fullName email dob phone contactName statistics",
      })
      .populate({
        path: "leagues.players.player",
        select: "fullName email dob phone contactName statistics",
      });

    if (!team) {
      return res.status(404).json({ message: "Team not found" });
    }

    let targetTerm = team.term;
    if (termId) {
      const termDoc = await Term.findById(termId);
      if (termDoc) targetTerm = termDoc;
    }

    const { selectedLeague, effectiveSessionDates, sessionConfig } = resolveTeamSessionConfig(team, leagueId);

    const hasExplicitSessions = effectiveSessionDates && effectiveSessionDates.length > 0;
    const generatedSessions = generateClassSessions(targetTerm, sessionConfig);
    const sessionDateSet = new Set(
      generatedSessions.map((d) => new Date(d).toISOString().split("T")[0])
    );

    const attendanceFilter = { team: teamId };
    if (leagueId || selectedLeague?.league) {
      attendanceFilter.league = leagueId || (selectedLeague.league?._id || selectedLeague.league);
    }
    if (!hasExplicitSessions && targetTerm && targetTerm.startDate && targetTerm.endDate) {
      const start = new Date(targetTerm.startDate);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(targetTerm.endDate);
      end.setUTCHours(23, 59, 59, 999);
      attendanceFilter.sessionDate = { $gte: start, $lte: end };
    }

    const attendanceData = await Attendance.find(attendanceFilter).select("sessionDate records league");

    const attendanceMap = {};
    attendanceData.forEach((att) => {
      const date = new Date(att.sessionDate).toISOString().split("T")[0];
      if (!hasExplicitSessions) {
        sessionDateSet.add(date);
      }
      attendanceMap[date] = {};
      att.records.forEach((r) => {
        attendanceMap[date][r.player.toString()] = r.status;
      });
    });

    const sessionDates = Array.from(sessionDateSet).sort();

    const isLeagueView = Boolean(leagueId);
    const sourcePlayers = isLeagueView
      ? (selectedLeague && Array.isArray(selectedLeague.players) ? selectedLeague.players : [])
      : (team.players || []);

    const rows = sourcePlayers.map((item) => {
      const player = item.player && typeof item.player === "object" ? item.player : { _id: item.player };
      const playerStats = item.statistics ? {
        appearances: Number(item.statistics.appearances) || 0,
        goals: Number(item.statistics.goals) || 0,
        assists: Number(item.statistics.assists) || 0,
        cleanSheets: Number(item.statistics.cleanSheets) || 0,
        yellowCards: Number(item.statistics.yellowCards) || 0,
        redCards: Number(item.statistics.redCards) || 0,
        minutesPlayed: Number(item.statistics.minutesPlayed) || 0,
      } : (player.statistics || {
        appearances: 0,
        goals: 0,
        assists: 0,
        cleanSheets: 0,
        yellowCards: 0,
        redCards: 0,
        minutesPlayed: 0,
      });

      const row = {
        Name: player.fullName || `${player.firstName || ""} ${player.lastName || ""}`.trim() || "",
        Email: player.email,
        DOB: player.dob ? formatDateOnly(player.dob) : "",
        Phone: player.phone,
        Guardian: player.contactName,
        "Payment Status": item.paymentStatus || "TRIAL",
        Goals: playerStats.goals,
        Assists: playerStats.assists,
        Appearances: playerStats.appearances,
      };

      sessionDates.forEach((date) => {
        const rawStatus = attendanceMap[date]?.[player._id?.toString()] || "NOT_MARKED";
        let symbol = "";
        if (rawStatus === "PRESENT") symbol = "P";
        else if (rawStatus === "ABSENT") symbol = "A";
        else if (rawStatus === "LATE") symbol = "L";
        else if (rawStatus === "TRIAL") symbol = "T";
        else symbol = "";

        row[date] = symbol;
      });

      return row;
    });

    const fields = [
      "Name",
      "Email",
      "DOB",
      "Phone",
      "Guardian",
      "Payment Status",
      "Goals",
      "Assists",
      "Appearances",
      ...sessionDates.map((value) => ({ label: formatDateOnly(value), value })),
    ];

    const parser = new Parser({ fields });
    const csv = parser.parse(rows);

    res.header("Content-Type", "text/csv");
    res.attachment(`team-${team.teamName}-attendance.csv`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


exports.getMyRole = async (req, res) => {
  try {
    if (req.admin) {
      return res.status(200).json({
        success: true,
        data: {
          role: req.admin.role,
        },
      });
    }

    if (req.parent) {
      return res.status(200).json({
        success: true,
        data: {
          role: "PARENT",
        },
      });
    }

    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.getPlayerDetails = async (req, res) => {
  try {
    const { playerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(playerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid player ID",
      });
    }

    const player = await User.findById(playerId)
      .populate({
        path: "parentId",
        select: "-password -tokens -otp -otpExpire -__v",
      })
      .populate("category", "name")
      .populate("programs", "name")
      .populate("term", "name year startDate endDate")
      .populate({
        path: "assignedClasses",
        select: "name dayOfWeek startTime endTime price location venue term program category",
        populate: [
          { path: "term", select: "name year startDate endDate" },
          { path: "program", select: "name" },
          { path: "category", select: "name" },
        ],
      })
      .populate({
        path: "classPaymentStatuses.class",
        select: "name dayOfWeek startTime endTime price location venue term program category",
        populate: [
          { path: "term", select: "name year startDate endDate" },
          { path: "program", select: "name" },
          { path: "category", select: "name" },
        ],
      })
      .lean();

    if (!player) {
      return res.status(404).json({
        success: false,
        message: "Player not found",
      });
    }

    const parentId = player.parentId?._id;
    const otherPlayers = parentId
      ? await User.find({
        parentId: parentId,
        _id: { $ne: player._id },
      })
        .select("_id fullName firstName lastName profileImage playerStatus")
        .lean()
      : [];

    const attendanceRecords = await Attendance.find({
      "records.player": playerId,
    })
      .populate({ path: "class", select: "name dayOfWeek startTime endTime term" , populate: { path: "term", select: "name year startDate endDate isEvent" } })
      .populate({ path: "team", select: "teamName term" , populate: { path: "term", select: "name year startDate endDate isEvent" } })
      .populate({ path: "league", select: "name season term startDate endDate", populate: { path: "term", select: "name year startDate endDate isEvent" } })
      .populate({ path: "event", select: "title eventType category termId startDate endDate", populate: { path: "termId", select: "name year startDate endDate isEvent" } })
      .populate("campSession", "sessionDate sessionLabel sessionType")
      .populate("records.noteAuthor", "name")
      .sort({ sessionDate: -1 })
      .lean();

    const perDayAttendance = attendanceRecords.map((att) => {
      const playerRecord = att.records.find(
        (r) => r.player && r.player.toString() === playerId.toString()
      );
      const contextType = att.event ? (/(camp|holiday)/i.test(`${att.event.eventType || ""} ${att.event.category || ""} ${att.event.title || ""}`) ? "HOLIDAY_PROGRAM" : "EVENT") : att.league ? "LEAGUE" : att.team ? "TEAM" : "CLASS";
      const context = att.event || att.league || att.team || att.class || null;
      const term = att.class?.term || att.team?.term || att.league?.term || att.event?.termId || null;
      const contextName = contextType === "HOLIDAY_PROGRAM" || contextType === "EVENT"
        ? context?.title || "Event"
        : contextType === "LEAGUE"
          ? context?.name || "League"
          : contextType === "TEAM"
            ? context?.teamName || "Team"
            : context?.name || "Class";
      return {
        attendanceId: att._id,
        class: att.class,
        contextType,
        contextId: context?._id || null,
        contextName,
        className: att.class?.name || "",
        teamName: att.team?.teamName || "",
        leagueName: att.league?.name || "",
        eventName: att.event?.title || "",
        eventType: att.event?.eventType || att.event?.category || "",
        termId: term?._id ? term._id.toString() : null,
        termName: term?.name || null,
        year: term?.year || null,
        sessionDate: att.sessionDate,
        status: playerRecord?.status || "NOT_MARKED",
        comment: playerRecord?.comment || "",
        remarks: playerRecord?.remarks || "",
        reason: playerRecord?.reason || "",
        note: playerRecord?.note || playerRecord?.reason || playerRecord?.remarks || playerRecord?.comment || "",
        noteAuthorName: playerRecord?.noteAuthor?.name || "",
        noteUpdatedAt: playerRecord?.noteUpdatedAt || null,
        markedByParent: playerRecord?.markedByParent || false,
        lateArrival: playerRecord?.lateArrival || false,
        attendanceType: playerRecord?.attendanceType || "REGULAR",
      };
    });

    const markedAttendance = perDayAttendance.filter((item) => ["PRESENT", "ABSENT", "LATE"].includes(String(item.status).toUpperCase()));
    const totalSessions = markedAttendance.length;
    const presentCount = markedAttendance.filter((a) => a.status === "PRESENT").length;
    const absentCount = markedAttendance.filter((a) => a.status === "ABSENT").length;
    const lateCount = markedAttendance.filter((a) => a.status === "LATE").length;
    const trialCount = perDayAttendance.filter((a) => a.status === "TRIAL").length;
    const attendedCount = presentCount + lateCount;

    const overallAttendancePercentage = totalSessions > 0
      ? Number(((attendedCount / totalSessions) * 100).toFixed(2))
      : 0;

    const overallAttendance = {
      totalSessions,
      presentCount,
      absentCount,
      lateCount,
      trialCount,
      attendedCount,
      percentage: overallAttendancePercentage,
    };

    // Include invoices and actual receipts so partial payments and discounts are
    // reported from finance records rather than inferred from a status flag.
    const playerInvoices = await Invoice.find({
      $or: [
        { players: playerId },
        ...(parentId ? [{ parent: parentId, $or: [{ players: { $exists: false } }, { players: { $size: 0 } }] }] : []),
      ],
    })
      .populate({ path: "class", select: "name term price", populate: { path: "term", select: "name year startDate endDate isEvent" } })
      .populate({ path: "team", select: "teamName teamFee term", populate: { path: "term", select: "name year startDate endDate isEvent" } })
      .populate({ path: "league", select: "name fee term season", populate: { path: "term", select: "name year startDate endDate isEvent" } })
      .populate({ path: "event", select: "title eventType category termId", populate: { path: "termId", select: "name year startDate endDate isEvent" } })
      .sort({ createdAt: -1 })
      .lean();

    const invoiceIds = playerInvoices.map((invoice) => invoice._id);
    const [availableTerms, productOrders, eventRegistrations, leaguePlayerStatistics] = await Promise.all([
      Term.find({}).select("name year startDate endDate isEvent status").sort({ startDate: -1 }).lean(),
      parentId
        ? Order.find({ parent: parentId }).populate("items.product", "name image sku").populate("invoice").sort({ createdAt: -1 }).lean()
        : [],
      EventRegistration.find({ user: playerId, status: { $ne: "CANCELLED" } })
        .populate({ path: "event", select: "title eventType category termId startDate endDate", populate: { path: "termId", select: "name year startDate endDate isEvent" } })
        .populate("invoice")
        .sort({ createdAt: -1 }).lean(),
      PlayerStatistics.find({ player: playerId })
        .populate({ path: "league", select: "name season term startDate endDate", populate: { path: "term", select: "name year startDate endDate isEvent" } })
        .populate("team", "teamName")
        .sort({ updatedAt: -1 }).lean(),
    ]);

    const allInvoiceIds = [...new Set([
      ...invoiceIds.map((id) => id.toString()),
      ...productOrders.map((order) => String(order.invoice?._id || order.invoice || "")),
      ...eventRegistrations.map((registration) => String(registration.invoice?._id || registration.invoice || "")),
    ].filter(Boolean))];
    const invoicePayments = allInvoiceIds.length
      ? await Payment.find({ invoice: { $in: allInvoiceIds } })
        .select("invoice amount status approvedAt createdAt paymentMethod transactionId remarks")
        .lean()
      : [];

    const invoiceReceipts = new Map();
    invoicePayments.forEach((payment) => {
      const key = payment.invoice?.toString();
      if (!key) return;
      if (!invoiceReceipts.has(key)) invoiceReceipts.set(key, { received: 0, awaitingApproval: 0, payments: [] });
      const entry = invoiceReceipts.get(key);
      if (payment.status === "APPROVED") entry.received += Number(payment.amount) || 0;
      if (payment.status === "PENDING") entry.awaitingApproval += Number(payment.amount) || 0;
      entry.payments.push(payment);
    });
    const getInvoiceAmounts = (invoice) => {
      if (!invoice) return { received: 0, pending: 0, awaitingApproval: 0, discount: 0 };
      const amount = Number(invoice.totalAmount ?? invoice.amount ?? 0);
      const receipt = invoiceReceipts.get(invoice._id.toString()) || { received: 0, awaitingApproval: 0 };
      const received = receipt.received > 0 ? Math.min(receipt.received, amount) : invoice.paymentStatus === "PAID" ? amount : 0;
      const remaining = Math.max(0, amount - received);
      const awaitingApproval = Math.min(remaining, receipt.awaitingApproval);
      const pending = Math.max(0, remaining - awaitingApproval);
      return { received, pending, awaitingApproval, discount: Number(invoice.discount) || 0 };
    };

    const classPaymentStatuses = player.classPaymentStatuses || [];

    // Combine unique classes
    const classMap = new Map();
    (player.assignedClasses || []).forEach((cls) => {
      if (cls && cls._id) {
        classMap.set(cls._id.toString(), cls);
      }
    });
    classPaymentStatuses.forEach((cps) => {
      if (cps && cps.class && cps.class._id && !classMap.has(cps.class._id.toString())) {
        classMap.set(cps.class._id.toString(), cps.class);
      }
    });

    const assignedClassesPaymentInfo = Array.from(classMap.values()).map((cls) => {
      const classIdStr = cls._id.toString();
      const className = cls.name || "";
      const classPrice = typeof cls.price === "number" ? cls.price : 0;
      const classTerm = cls.term || player.term || null;

      const paymentEntry = classPaymentStatuses.find((cps) => {
        const cpsClassId = cps.class
          ? (cps.class._id ? cps.class._id.toString() : cps.class.toString())
          : null;
        return cpsClassId === classIdStr;
      });

      const rawStatus = paymentEntry ? paymentEntry.paymentStatus : (player.paymentStatus || "TRIAL");
      const stUpper = (rawStatus || "TRIAL").toUpperCase();

      // Find matching invoice if any
      const matchingInvoice = playerInvoices.find((inv) => {
        const invClassId = inv.class
          ? (inv.class._id ? inv.class._id.toString() : inv.class.toString())
          : null;
        return invClassId === classIdStr;
      });

      const fee = matchingInvoice && typeof matchingInvoice.totalAmount === "number"
        ? matchingInvoice.totalAmount
        : classPrice;
      const invoiceAmounts = getInvoiceAmounts(matchingInvoice);
      const amountReceived = matchingInvoice ? invoiceAmounts.received : stUpper === "PAID" ? fee : 0;
      const amountPending = matchingInvoice ? invoiceAmounts.pending : ["UNPAID", "OVER_DUE"].includes(stUpper) ? fee : 0;

      const effectiveStatus = stUpper === "PAID" || matchingInvoice?.paymentStatus === "PAID" ? "PAID" : stUpper;

      return {
        classId: cls._id,
        className,
        dayOfWeek: cls.dayOfWeek || "",
        startTime: cls.startTime || "",
        endTime: cls.endTime || "",
        location: cls.location || "",
        term: classTerm ? {
          _id: classTerm._id,
          name: classTerm.name,
          year: classTerm.year,
        } : null,
        termId: classTerm?._id ? classTerm._id.toString() : null,
        termName: classTerm?.name || (classTerm?.year ? `Term (${classTerm.year})` : "General"),
        year: classTerm?.year || null,
        program: cls.program || null,
        category: cls.category || null,
        fee,
        discount: invoiceAmounts.discount,
        amountReceived,
        amountPending,
        amountAwaitingApproval: invoiceAmounts.awaitingApproval,
        paymentStatus: effectiveStatus,
        invoiceId: matchingInvoice?._id || null,
        invoiceNumber: matchingInvoice?.invoiceNumber || null,
        invoiceStatus: matchingInvoice?.paymentStatus || null,
        dueDate: matchingInvoice?.dueDate || null,
        createdAt: matchingInvoice?.createdAt || null,
      };
    });

    const paidClasses = assignedClassesPaymentInfo.filter((item) => item.paymentStatus === "PAID");
    const unpaidClasses = assignedClassesPaymentInfo.filter((item) => item.paymentStatus === "UNPAID");
    const trialClasses = assignedClassesPaymentInfo.filter((item) => item.paymentStatus === "TRIAL");
    const overdueClasses = assignedClassesPaymentInfo.filter((item) => item.paymentStatus === "OVER_DUE");

    const classPaymentSummary = {
      totalAssignedClasses: assignedClassesPaymentInfo.length,
      paidClassesCount: paidClasses.length,
      unpaidClassesCount: unpaidClasses.length,
      trialClassesCount: trialClasses.length,
      overdueClassesCount: overdueClasses.length,
      isAllClassesPaid:
        assignedClassesPaymentInfo.length > 0 &&
        paidClasses.length === assignedClassesPaymentInfo.length,
      paidClassNames: paidClasses.map((c) => c.className),
      unpaidClassNames: unpaidClasses.map((c) => c.className),
      trialClassNames: trialClasses.map((c) => c.className),
      overdueClassNames: overdueClasses.map((c) => c.className),
      assignedClassesWithPaymentStatus: assignedClassesPaymentInfo,
    };

    const assignedTeams = await Team.find({ "players.player": playerId })
      .select("teamName teamFee logo players ageGroup term leagues")
      .populate("term", "name year startDate endDate isEvent")
      .populate({ path: "leagues.league", select: "name season term startDate endDate", populate: { path: "term", select: "name year startDate endDate isEvent" } })
      .lean();

    const assignedTeamsPaymentInfo = assignedTeams.map((team) => {
      const pEntry = (team.players || []).find(
        (p) => p.player && p.player.toString() === playerId.toString()
      );
      const rawStatus = (pEntry ? pEntry.paymentStatus : "UNPAID").toUpperCase();
      const teamFee = typeof team.teamFee === "number" ? team.teamFee : 0;
      const matchingInvoice = playerInvoices.find((inv) => {
        const invTeamId = inv.team
          ? (inv.team._id ? inv.team._id.toString() : inv.team.toString())
          : null;
        return invTeamId === team._id.toString() && !inv.league;
      });

      const fee = matchingInvoice && typeof matchingInvoice.totalAmount === "number"
        ? matchingInvoice.totalAmount
        : teamFee;

      const invoiceAmounts = getInvoiceAmounts(matchingInvoice);
      const amountReceived = matchingInvoice ? invoiceAmounts.received : rawStatus === "PAID" ? fee : 0;
      const amountPending = matchingInvoice ? invoiceAmounts.pending : ["UNPAID", "OVER_DUE"].includes(rawStatus) ? fee : 0;

      const effectiveStatus = rawStatus === "PAID" || matchingInvoice?.paymentStatus === "PAID" ? "PAID" : rawStatus;

      return {
        teamId: team._id,
        teamName: team.teamName,
        teamFee: fee,
        term: team.term || null,
        termId: team.term?._id ? team.term._id.toString() : null,
        termName: team.term?.name || "No term linked",
        year: team.term?.year || null,
        fee,
        discount: invoiceAmounts.discount,
        amountReceived,
        amountPending,
        amountAwaitingApproval: invoiceAmounts.awaitingApproval,
        paymentStatus: effectiveStatus,
        invoiceId: matchingInvoice?._id || null,
        invoiceNumber: matchingInvoice?.invoiceNumber || null,
        invoiceStatus: matchingInvoice?.paymentStatus || null,
      };
    });

    const assignedLeagueInfo = assignedTeams.flatMap((team) => (team.leagues || [])
      .filter((leagueEntry) => (leagueEntry.players || []).some((entry) => String(entry.player?._id || entry.player) === String(playerId)))
      .map((leagueEntry) => {
        const league = leagueEntry.league;
        const leagueId = String(league?._id || "");
        const playerEntry = (leagueEntry.players || []).find((entry) => String(entry.player?._id || entry.player) === String(playerId));
        const rawStatus = String(playerEntry?.paymentStatus || "UNPAID").toUpperCase();
        const invoice = playerInvoices.find((item) => String(item.league?._id || item.league || "") === leagueId && String(item.team?._id || item.team || "") === String(team._id));
        const amounts = getInvoiceAmounts(invoice);
        const fee = Number(invoice?.totalAmount ?? leagueEntry.teamFee ?? league?.fee ?? 0);
        const term = league?.term || team.term || null;
        return {
          leagueId,
          leagueName: league?.name || "League",
          season: league?.season || "",
          teamId: team._id,
          teamName: team.teamName,
          termId: term?._id ? term._id.toString() : null,
          termName: term?.name || "No term linked",
          year: term?.year || null,
          status: leagueEntry.status || "ACTIVE",
          paymentStatus: invoice?.paymentStatus === "PAID" ? "PAID" : rawStatus,
          fee,
          discount: amounts.discount,
          amountReceived: invoice ? amounts.received : rawStatus === "PAID" ? fee : 0,
          amountPending: invoice ? amounts.pending : ["UNPAID", "OVER_DUE"].includes(rawStatus) ? fee : 0,
          amountAwaitingApproval: amounts.awaitingApproval,
          invoiceId: invoice?._id || null,
          invoiceNumber: invoice?.invoiceNumber || null,
          statistics: playerEntry?.statistics || {},
        };
      }));

    const paidTeams = assignedTeamsPaymentInfo.filter((item) => item.paymentStatus === "PAID");
    const unpaidTeams = assignedTeamsPaymentInfo.filter((item) => item.paymentStatus === "UNPAID");
    const trialTeams = assignedTeamsPaymentInfo.filter((item) => item.paymentStatus === "TRIAL");
    const overdueTeams = assignedTeamsPaymentInfo.filter((item) => item.paymentStatus === "OVER_DUE");

    const teamPaymentSummary = {
      totalAssignedTeams: assignedTeamsPaymentInfo.length,
      paidTeamsCount: paidTeams.length,
      unpaidTeamsCount: unpaidTeams.length,
      trialTeamsCount: trialTeams.length,
      overdueTeamsCount: overdueTeams.length,
      isAllTeamsPaid:
        assignedTeamsPaymentInfo.length > 0 &&
        paidTeams.length === assignedTeamsPaymentInfo.length,
      paidTeamNames: paidTeams.map((t) => t.teamName),
      unpaidTeamNames: unpaidTeams.map((t) => t.teamName),
      trialTeamNames: trialTeams.map((t) => t.teamName),
      overdueTeamNames: overdueTeams.map((t) => t.teamName),
      assignedTeamsWithPaymentStatus: assignedTeamsPaymentInfo,
    };

    // Build comprehensive payment history items list
    const paymentHistory = [];

    // Add classes
    assignedClassesPaymentInfo.forEach((cls) => {
      paymentHistory.push({
        id: `class-${cls.classId}`,
        type: "CLASS",
        classId: cls.classId,
        name: cls.className,
        termId: cls.termId,
        termName: cls.termName,
        fee: cls.fee,
        amountReceived: cls.amountReceived,
        amountPending: cls.amountPending,
        paymentStatus: cls.paymentStatus,
        invoiceNumber: cls.invoiceNumber,
        invoiceId: cls.invoiceId,
        invoiceStatus: cls.invoiceStatus,
        dueDate: cls.dueDate,
        dayOfWeek: cls.dayOfWeek,
        startTime: cls.startTime,
        category: cls.category?.name || "",
        program: cls.program?.name || "",
        discount: cls.discount || 0,
      });
    });

    // Add teams
    assignedTeamsPaymentInfo.forEach((tm) => {
      paymentHistory.push({
        id: `team-${tm.teamId}`,
        type: "TEAM",
        teamId: tm.teamId,
        name: tm.teamName,
        termId: tm.termId,
        termName: tm.termName,
        year: tm.year,
        fee: tm.fee,
        discount: tm.discount,
        amountReceived: tm.amountReceived,
        amountPending: tm.amountPending,
        amountAwaitingApproval: tm.amountAwaitingApproval,
        paymentStatus: tm.paymentStatus,
        invoiceNumber: tm.invoiceNumber,
        invoiceId: tm.invoiceId,
        invoiceStatus: tm.invoiceStatus,
        createdAt: tm.createdAt || null,
      });
    });

    assignedLeagueInfo.forEach((league) => {
      paymentHistory.push({
        id: `league-${league.leagueId}-${league.teamId}`,
        type: "LEAGUE",
        leagueId: league.leagueId,
        teamId: league.teamId,
        teamName: league.teamName,
        name: league.leagueName,
        termId: league.termId,
        termName: league.termName,
        year: league.year,
        fee: league.fee,
        discount: league.discount,
        amountReceived: league.amountReceived,
        amountPending: league.amountPending,
        amountAwaitingApproval: league.amountAwaitingApproval,
        paymentStatus: league.paymentStatus,
        invoiceNumber: league.invoiceNumber,
        invoiceId: league.invoiceId,
        invoiceStatus: league.paymentStatus,
      });
    });

    eventRegistrations.forEach((registration) => {
      const event = registration.event;
      if (!event) return;
      const invoice = registration.invoice?._id
        ? registration.invoice
        : playerInvoices.find((item) => String(item._id) === String(registration.invoice || ""));
      const amounts = getInvoiceAmounts(invoice);
      const registrationStatus = String(invoice?.paymentStatus || registration.paymentStatus || "UNPAID").toUpperCase();
      const term = event.termId || null;
      paymentHistory.push({
        id: `event-registration-${registration._id}`,
        type: /(camp|holiday)/i.test(`${event.eventType || ""} ${event.category || ""} ${event.title || ""}`) ? "HOLIDAY_PROGRAM" : "EVENT",
        eventId: event._id,
        registrationId: registration._id,
        name: event.title || "Event registration",
        termId: term?._id ? term._id.toString() : null,
        termName: term?.name || "No term linked",
        year: term?.year || null,
        fee: Number(invoice?.totalAmount ?? registration.totalAmount ?? 0),
        discount: amounts.discount,
        amountReceived: invoice ? amounts.received : registrationStatus === "PAID" || registrationStatus === "APPROVED" ? Number(registration.totalAmount) || 0 : 0,
        amountPending: invoice ? amounts.pending : ["UNPAID", "OVER_DUE", "PAYMENT_PENDING"].includes(registrationStatus) ? Number(registration.totalAmount) || 0 : 0,
        amountAwaitingApproval: amounts.awaitingApproval,
        paymentStatus: registrationStatus,
        invoiceNumber: invoice?.invoiceNumber || null,
        invoiceId: invoice?._id || null,
        invoiceStatus: invoice?.paymentStatus || registrationStatus,
        selectedSessions: (registration.selectedSessions || []).map((session) => ({
          date: session.sessionDate,
          label: session.sessionLabel || session.sessionType || "Camp session",
          fee: Number(session.fee) || 0,
        })),
        createdAt: registration.createdAt,
      });
    });

    const orderInvoiceIds = new Set();
    productOrders.forEach((order) => {
      const invoiceId = order.invoice?._id || order.invoice;
      if (invoiceId) orderInvoiceIds.add(String(invoiceId));
      const status = String(order.paymentStatus === "REFUNDED" || order.paymentStatus === "FAILED"
        ? order.paymentStatus
        : order.invoice?.paymentStatus || order.paymentStatus || "PENDING").toUpperCase();
      const amount = Number(order.totalAmount || order.invoice?.totalAmount || 0);
      const receiptAmounts = getInvoiceAmounts(order.invoice);
      const orderIsPaid = status === "PAID" || order.invoice?.paymentStatus === "PAID";
      paymentHistory.push({
        id: `order-${order._id}`,
        type: "STORE_ORDER",
        orderId: order._id,
        name: (order.items || []).map((entry) => entry.product?.name || "Product").join(", ") || "Store order",
        products: (order.items || []).map((entry) => ({
          name: entry.product?.name || "Product",
          quantity: Number(entry.quantity) || 1,
          price: Number(entry.price) || 0,
          size: entry.selectedSize || "",
          color: entry.selectedColor || "",
        })),
        termId: null,
        termName: "Family purchase · no term linked",
        fee: amount,
        discount: receiptAmounts.discount || Number(order.invoice?.discount) || 0,
        amountReceived: order.invoice ? receiptAmounts.received : orderIsPaid ? amount : 0,
        amountPending: order.invoice ? receiptAmounts.pending : orderIsPaid || status === "PENDING" ? 0 : amount,
        amountAwaitingApproval: order.invoice ? receiptAmounts.awaitingApproval : status === "PENDING" ? amount : 0,
        paymentStatus: status,
        invoiceNumber: order.invoice?.invoiceNumber || null,
        invoiceId: invoiceId || null,
        invoiceStatus: order.invoice?.paymentStatus || status,
        createdAt: order.createdAt,
        householdPurchase: true,
      });
    });

    // Add any remaining invoices not matched
    const matchedInvoiceIds = new Set([
      paymentHistory.map((p) => p.invoiceId?.toString()).filter(Boolean)
    ].flat().concat(Array.from(orderInvoiceIds)));

    playerInvoices.forEach((inv) => {
      if (!matchedInvoiceIds.has(inv._id.toString())) {
        const fee = Number(inv.totalAmount || 0);
        const amounts = getInvoiceAmounts(inv);
        const invoiceTerm = inv.class?.term || inv.team?.term || inv.league?.term || inv.event?.termId || null;
        const eventLabel = `${inv.event?.eventType || ""} ${inv.event?.category || ""} ${inv.event?.title || ""}`;
        const itemType = inv.class ? "CLASS" : inv.league ? "LEAGUE" : inv.team ? "TEAM" : inv.event ? (/(camp|holiday)/i.test(eventLabel) ? "HOLIDAY_PROGRAM" : "EVENT") : inv.type === "STORE_ORDER" ? "STORE_ORDER" : "INVOICE";
        const contextName = inv.class?.name || inv.league?.name || inv.team?.teamName || inv.event?.title || inv.items?.[0]?.title || inv.description || inv.invoiceNumber;
        paymentHistory.push({
          id: `inv-${inv._id}`,
          type: itemType,
          name: contextName,
          classId: inv.class?._id || null,
          teamId: inv.team?._id || null,
          leagueId: inv.league?._id || null,
          eventId: inv.event?._id || null,
          termId: invoiceTerm?._id ? invoiceTerm._id.toString() : null,
          termName: invoiceTerm?.name || inv.type?.replace(/_/g, " ") || "No term linked",
          year: invoiceTerm?.year || null,
          fee,
          discount: amounts.discount,
          amountReceived: amounts.received,
          amountPending: amounts.pending,
          amountAwaitingApproval: amounts.awaitingApproval,
          paymentStatus: inv.paymentStatus || "UNPAID",
          invoiceNumber: inv.invoiceNumber,
          invoiceId: inv._id,
          invoiceStatus: inv.paymentStatus,
          dueDate: inv.dueDate,
          createdAt: inv.createdAt,
          invoiceRecordStatus: inv.status,
        });
      }
    });

    // Aggregate overall totals
    const totalFees = paymentHistory.reduce((sum, item) => sum + (Number(item.fee) || 0), 0);
    const totalReceived = paymentHistory.reduce((sum, item) => sum + (Number(item.amountReceived) || 0), 0);
    const totalPending = paymentHistory.reduce((sum, item) => sum + (Number(item.amountPending) || 0), 0);

    // Group by Term for term-wise stats
    const termStatsMap = {};
    paymentHistory.forEach((item) => {
      const tKey = item.termId || item.termName || "Other";
      if (!termStatsMap[tKey]) {
        termStatsMap[tKey] = {
          termId: item.termId || null,
          termName: item.termName || "Other",
          totalFees: 0,
          totalReceived: 0,
          totalPending: 0,
          totalDiscount: 0,
          awaitingApproval: 0,
          itemsCount: 0,
        };
      }
      termStatsMap[tKey].totalFees += Number(item.fee) || 0;
      termStatsMap[tKey].totalReceived += Number(item.amountReceived) || 0;
      termStatsMap[tKey].totalPending += Number(item.amountPending) || 0;
      termStatsMap[tKey].totalDiscount += Number(item.discount) || 0;
      termStatsMap[tKey].awaitingApproval += Number(item.amountAwaitingApproval) || 0;
      termStatsMap[tKey].itemsCount += 1;
    });

    const paymentFinancialSummary = {
      totalFees,
      totalReceived,
      totalPending,
      totalDiscount: paymentHistory.reduce((sum, item) => sum + (Number(item.discount) || 0), 0),
      totalAwaitingApproval: paymentHistory.reduce((sum, item) => sum + (Number(item.amountAwaitingApproval) || 0), 0),
      byTerm: Object.values(termStatsMap),
      history: paymentHistory,
    };

    const leagueStatistics = leaguePlayerStatistics.map((entry) => ({
      id: entry._id,
      leagueId: entry.league?._id || null,
      leagueName: entry.league?.name || "League",
      season: entry.league?.season || "",
      teamId: entry.team?._id || null,
      teamName: entry.team?.teamName || "",
      termId: entry.league?.term?._id ? entry.league.term._id.toString() : null,
      termName: entry.league?.term?.name || "No term linked",
      year: entry.league?.term?.year || null,
      statistics: {
        appearances: Number(entry.appearances) || 0,
        goals: Number(entry.goals) || 0,
        assists: Number(entry.assists) || 0,
        cleanSheets: Number(entry.cleanSheets) || 0,
        yellowCards: Number(entry.yellowCards) || 0,
        redCards: Number(entry.redCards) || 0,
        minutesPlayed: Number(entry.minutesPlayed) || 0,
      },
    }));

    const teamAttendanceRecords = await Attendance.find({
      team: { $exists: true, $ne: null },
      "records.player": playerId,
    })
      .populate("team", "teamName ageGroup startTime endTime")
      .populate("records.noteAuthor", "name")
      .sort({ sessionDate: -1 })
      .lean();

    const perDayTeamAttendance = teamAttendanceRecords.map((att) => {
      const playerRecord = att.records.find(
        (r) => r.player && r.player.toString() === playerId.toString()
      );
      return {
        attendanceId: att._id,
        team: att.team,
        teamName: att.team?.teamName || "",
        sessionDate: att.sessionDate,
        status: playerRecord?.status || "NOT_MARKED",
        comment: playerRecord?.comment || "",
        remarks: playerRecord?.remarks || "",
        reason: playerRecord?.reason || "",
        note: playerRecord?.note || playerRecord?.reason || playerRecord?.remarks || playerRecord?.comment || "",
        noteAuthorName: playerRecord?.noteAuthor?.name || "",
        noteUpdatedAt: playerRecord?.noteUpdatedAt || null,
        markedByParent: playerRecord?.markedByParent || false,
        lateArrival: playerRecord?.lateArrival || false,
        attendanceType: playerRecord?.attendanceType || "REGULAR",
      };
    });

    const totalTeamSessions = perDayTeamAttendance.length;
    const presentTeamCount = perDayTeamAttendance.filter((a) => a.status === "PRESENT").length;
    const absentTeamCount = perDayTeamAttendance.filter((a) => a.status === "ABSENT").length;
    const lateTeamCount = perDayTeamAttendance.filter((a) => a.status === "LATE").length;
    const trialTeamCount = perDayTeamAttendance.filter((a) => a.status === "TRIAL").length;
    const attendedTeamCount = presentTeamCount + lateTeamCount;

    const overallTeamAttendancePercentage =
      totalTeamSessions > 0
        ? Number(((attendedTeamCount / totalTeamSessions) * 100).toFixed(2))
        : 0;

    const overallTeamAttendance = {
      totalSessions: totalTeamSessions,
      presentCount: presentTeamCount,
      absentCount: absentTeamCount,
      lateCount: lateTeamCount,
      trialCount: trialTeamCount,
      attendedCount: attendedTeamCount,
      percentage: overallTeamAttendancePercentage,
    };

    return res.status(200).json({
      success: true,
      message: "Player details fetched successfully.",
      data: {
        player,
        parent: player.parentId || null,
        otherPlayers,
        familyPlayers: [
          { _id: player._id, fullName: player.fullName || [player.firstName, player.lastName].filter(Boolean).join(" "), profileImage: player.profileImage || null, playerStatus: player.playerStatus || player.status || null },
          ...otherPlayers.map((child) => ({ ...child, fullName: child.fullName || [child.firstName, child.lastName].filter(Boolean).join(" ") })),
        ],
        availableTerms,
        assignedClassesPaymentInfo,
        classPaymentSummary,
        assignedTeamsPaymentInfo,
        assignedLeagueInfo,
        teamPaymentSummary,
        leagueStatistics,
        eventRegistrations,
        paymentFinancialSummary,
        perDayAttendance,
        overallAttendance,
        perDayTeamAttendance,
        overallTeamAttendance,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @desc Preview Clone Term - Fetch classes and players to clone, check duplicate class existence
 * @route POST /api/admin/cloneTerm/preview
 * @access Private/Admin
 */

exports.previewCloneTerm = async (req, res) => {
  try {
    const { sourceTermId, targetTermId } = req.body;

    if (!sourceTermId || !targetTermId) {
      return res.status(400).json({
        success: false,
        message: "sourceTermId and targetTermId are required.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(sourceTermId) || !mongoose.Types.ObjectId.isValid(targetTermId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid sourceTermId or targetTermId format.",
      });
    }

    if (sourceTermId === targetTermId) {
      return res.status(400).json({
        success: false,
        message: "Source term and target term cannot be the same.",
      });
    }

    const sourceTerm = await Term.findById(sourceTermId);
    if (!sourceTerm) {
      return res.status(404).json({
        success: false,
        message: "Source term not found.",
      });
    }

    const targetTerm = await Term.findById(targetTermId);
    if (!targetTerm) {
      return res.status(404).json({
        success: false,
        message: "Target term not found.",
      });
    }

    // 1. Preview Classes
    const sourceClasses = await Class.find({ term: sourceTermId })
      .populate("category", "name")
      .populate("program", "name")
      .populate("coach", "fullName name")
      .populate("players", "firstName lastName fullName");

    const targetClasses = await Class.find({ term: targetTermId });

    const classesPreview = sourceClasses.map((cls) => {
      const alreadyExists = targetClasses.some((tCls) => {
        const sameName = tCls.name === cls.name;
        const sameCategory = String(tCls.category) === String(cls.category?._id || cls.category);
        const sameProgram = String(tCls.program) === String(cls.program?._id || cls.program);
        const sameDay = tCls.dayOfWeek === cls.dayOfWeek;
        const sameStartTime = tCls.startTime === cls.startTime;
        return sameName && sameCategory && sameProgram && sameDay && sameStartTime;
      });

      const playersList = (cls.players || []).map((player) => {
        const playerName =
          player.fullName ||
          [player.firstName, player.lastName].filter(Boolean).join(" ") ||
          "Unknown Player";
        return {
          _id: player._id,
          name: playerName,
          selected: true,
        };
      });

      return {
        classId: cls._id,
        name: cls.name,
        category: cls.category?.name || "",
        program: cls.program?.name || "",
        coach: cls.coach?.fullName || cls.coach?.name || "",
        playerCount: playersList.length,
        alreadyExists,
        players: playersList,
      };
    });

    // 2. Preview Leagues & Teams
    const sourceLeagues = await League.find({ term: sourceTermId }).populate({
      path: "teams",
      populate: [
        {
          path: "players.player",
          select: "firstName lastName fullName email phone profileImage jerseyNumber",
        },
        {
          path: "coach",
          select: "name fullName email phone",
        },
      ],
    });

    const targetLeagues = await League.find({ term: targetTermId });

    const leaguesPreview = sourceLeagues.map((lg) => {
      const alreadyExists = targetLeagues.some(
        (tLg) => tLg.name?.trim().toLowerCase() === lg.name?.trim().toLowerCase()
      );

      const teamsList = (lg.teams || []).filter(Boolean).map((t) => {
        const playersList = (t.players || []).map((item) => {
          const playerDoc = item.player;
          const playerName =
            playerDoc?.fullName ||
            [playerDoc?.firstName, playerDoc?.lastName].filter(Boolean).join(" ") ||
            "Unknown Player";
          return {
            _id: playerDoc?._id || item.player,
            name: playerName,
            paymentStatus: "TRAIL",
            selected: true,
          };
        });

        return {
          teamId: t._id,
          teamName: t.teamName,
          logo: t.logo || "",
          coach: t.coach?.fullName || t.coach?.name || "",
          playerCount: playersList.length,
          alreadyExists: false,
          selected: true,
          players: playersList,
        };
      });

      return {
        leagueId: lg._id,
        name: lg.name,
        season: lg.season,
        fixtureFormat: lg.fixtureFormat,
        numberOfRounds: lg.numberOfRounds,
        teamsCount: teamsList.length,
        alreadyExists,
        selected: !alreadyExists,
        teams: teamsList,
      };
    });

    return res.status(200).json({
      success: true,
      sourceTerm: {
        _id: sourceTerm._id,
        name: sourceTerm.name,
      },
      targetTerm: {
        _id: targetTerm._id,
        name: targetTerm.name,
      },
      classes: classesPreview,
      leagues: leaguesPreview,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.cloneTerm = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { sourceTermId, targetTermId, classes, leagues } = req.body;

    if (!sourceTermId || !targetTermId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "sourceTermId and targetTermId are required.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(sourceTermId) || !mongoose.Types.ObjectId.isValid(targetTermId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Invalid sourceTermId or targetTermId format.",
      });
    }

    if (sourceTermId === targetTermId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Source term and target term cannot be the same.",
      });
    }

    const sourceTerm = await Term.findById(sourceTermId).session(session);
    if (!sourceTerm) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "Source term not found.",
      });
    }

    const targetTerm = await Term.findById(targetTermId).session(session);
    if (!targetTerm) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "Target term not found.",
      });
    }

    // 1. Process Classes
    const selectedClasses = Array.isArray(classes) ? classes : [];
    let classesSelected = selectedClasses.length;
    let classesCloned = 0;
    let classesSkipped = 0;
    let playersSelected = 0;
    let playersCopied = 0;

    for (const item of selectedClasses) {
      const { classId, players: playerIds } = item;
      const playerList = Array.isArray(playerIds) ? playerIds : [];
      playersSelected += playerList.length;

      if (!classId || !mongoose.Types.ObjectId.isValid(classId)) {
        classesSkipped++;
        continue;
      }

      const sourceClass = await Class.findById(classId).session(session);
      if (!sourceClass || String(sourceClass.term) !== String(sourceTermId)) {
        classesSkipped++;
        continue;
      }

      const existingClass = await Class.findOne({
        term: targetTermId,
        name: sourceClass.name,
        category: sourceClass.category,
        program: sourceClass.program,
        dayOfWeek: sourceClass.dayOfWeek,
        startTime: sourceClass.startTime,
      }).session(session);

      if (existingClass) {
        classesSkipped++;
        continue;
      }

      const validPlayerIds = playerList.filter((pId) =>
        sourceClass.players.some((spId) => String(spId) === String(pId))
      );

      const classObject = sourceClass.toObject();
      delete classObject._id;
      delete classObject.createdAt;
      delete classObject.updatedAt;

      classObject.term = targetTermId;
      classObject.players = validPlayerIds;

      const [newClass] = await Class.create([classObject], { session });
      classesCloned++;
      playersCopied += validPlayerIds.length;

      for (const playerId of validPlayerIds) {
        const user = await User.findById(playerId).session(session);
        if (user) {
          const updateData = {
            $addToSet: { assignedClasses: newClass._id },
          };

          if (user.term && String(user.term) === String(sourceTermId)) {
            updateData.$set = { term: targetTermId };
          }

          await User.updateOne({ _id: playerId }, updateData, { session });
        }
      }
    }

    // 2. Process Leagues & Teams
    let leaguesToProcess = Array.isArray(leagues) ? leagues : [];
    if (leaguesToProcess.length === 0 && (req.body.cloneAllLeagues === true || req.body.cloneLeagues === true)) {
      const allSourceLeagues = await League.find({ term: sourceTermId }).session(session);
      leaguesToProcess = allSourceLeagues.map((l) => ({ leagueId: l._id }));
    }

    let leaguesSelected = leaguesToProcess.length;
    let leaguesCloned = 0;
    let leaguesSkipped = 0;
    let teamsSelected = 0;
    let teamsCloned = 0;
    let leaguePlayersCopied = 0;

    for (const item of leaguesToProcess) {
      const { leagueId, teams: teamItems, duplicateTeams } = item;

      if (!leagueId || !mongoose.Types.ObjectId.isValid(leagueId)) {
        leaguesSkipped++;
        continue;
      }

      const sourceLeague = await League.findById(leagueId)
        .populate({
          path: "teams",
          select: "teamName logo coach assistantCoach ageGroup teamType term dayOfWeek startTime endTime venue location scheduleType schedule captain viceCaptain players",
        })
        .session(session);

      if (!sourceLeague || String(sourceLeague.term) !== String(sourceTermId)) {
        leaguesSkipped++;
        continue;
      }

      const existingLeague = await League.findOne({
        term: targetTermId,
        name: sourceLeague.name,
      }).session(session);

      if (existingLeague) {
        leaguesSkipped++;
        continue;
      }

      const sourceTeams = (sourceLeague.teams || []).filter(Boolean);
      let teamsToInclude = [];

      if (Array.isArray(teamItems) && teamItems.length > 0) {
        for (const tItem of teamItems) {
          const tId = tItem.teamId || tItem._id || tItem;
          const matchTeam = sourceTeams.find((st) => String(st._id) === String(tId));
          if (matchTeam) {
            teamsToInclude.push({
              teamDoc: matchTeam,
              selectedPlayerIds: Array.isArray(tItem.players) ? tItem.players : null,
            });
          }
        }
      } else {
        for (const st of sourceTeams) {
          teamsToInclude.push({
            teamDoc: st,
            selectedPlayerIds: null,
          });
        }
      }

      teamsSelected += teamsToInclude.length;

      const shouldDuplicateTeams = duplicateTeams !== false;
      const assignedTeamIds = [];
      const oldToNewTeamMap = {};

      if (shouldDuplicateTeams && teamsToInclude.length > 0) {
        for (const { teamDoc, selectedPlayerIds } of teamsToInclude) {
          let playerListToUse = teamDoc.players || [];
          if (selectedPlayerIds) {
            playerListToUse = playerListToUse.filter((p) =>
              selectedPlayerIds.some((spId) => String(spId?._id || spId) === String(p.player?._id || p.player))
            );
          }

          const clonedPlayers = playerListToUse.map((p) => ({
            player: p.player?._id || p.player,
            paymentStatus: p.paymentStatus || "UNPAID",
          }));

          const teamObject = teamDoc.toObject();
          delete teamObject._id;
          delete teamObject.createdAt;
          delete teamObject.updatedAt;
          delete teamObject.statistics;

          teamObject.term = targetTermId;
          teamObject.players = clonedPlayers;
          teamObject.leagues = [];

          const [newTeam] = await Team.create([teamObject], { session });
          assignedTeamIds.push(newTeam._id);
          oldToNewTeamMap[String(teamDoc._id)] = newTeam._id;
          teamsCloned++;
          leaguePlayersCopied += clonedPlayers.length;
        }
      } else {
        for (const { teamDoc } of teamsToInclude) {
          assignedTeamIds.push(teamDoc._id);
          teamsCloned++;
        }
      }

      const newGroups = (sourceLeague.groups || []).map((g) => ({
        name: g.name,
        teams: (g.teams || []).map((tId) => oldToNewTeamMap[String(tId?._id || tId)] || tId),
      }));

      const leagueObject = sourceLeague.toObject();
      delete leagueObject._id;
      delete leagueObject.createdAt;
      delete leagueObject.updatedAt;

      leagueObject.term = targetTermId;
      leagueObject.season = targetTerm.name || sourceLeague.season;
      leagueObject.startDate = targetTerm.startDate || sourceLeague.startDate;
      leagueObject.endDate = targetTerm.endDate || sourceLeague.endDate;
      leagueObject.teams = assignedTeamIds;
      leagueObject.groups = newGroups;
      leagueObject.fixtureGenerated = false; // NO fixtures cloned!

      const [newLeague] = await League.create([leagueObject], { session });
      leaguesCloned++;

      if (assignedTeamIds.length > 0) {
        const standingOps = assignedTeamIds.map((tId) => ({
          updateOne: {
            filter: { league: newLeague._id, team: tId },
            update: {
              $setOnInsert: {
                league: newLeague._id,
                team: tId,
                group: "",
                played: 0,
                won: 0,
                drawn: 0,
                lost: 0,
                goalsFor: 0,
                goalsAgainst: 0,
                goalDifference: 0,
                points: 0,
              },
            },
            upsert: true,
          },
        }));
        await Standing.bulkWrite(standingOps, { session });

        const teamGroupMap = {};
        if (Array.isArray(newGroups)) {
          for (const g of newGroups) {
            if (Array.isArray(g.teams)) {
              for (const t of g.teams) {
                teamGroupMap[String(t?._id || t)] = g.name || "";
              }
            }
          }
        }

        for (const tId of assignedTeamIds) {
          const tDoc = await Team.findById(tId).session(session);
          if (tDoc) {
            const defaultPlayers = (tDoc.players || []).map((p) => ({
              player: p.player,
              paymentStatus: p.paymentStatus || "UNPAID",
              status: "ACTIVE",
            }));

            tDoc.leagues = tDoc.leagues || [];
            tDoc.leagues.push({
              league: newLeague._id,
              teamFee: newLeague.fee || 0,
              round: newLeague.numberOfRounds || null,
              sessionDates: newLeague.sessionDates || [],
              group: teamGroupMap[String(tId)] || "",
              status: "ACTIVE",
              enrolledAt: new Date(),
              players: defaultPlayers,
              statistics: {
                played: 0,
                won: 0,
                drawn: 0,
                lost: 0,
                goalsFor: 0,
                goalsAgainst: 0,
                goalDifference: 0,
                points: 0,
              },
            });

            await tDoc.save({ session });
          }
        }
      }
    }

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      success: true,
      message: "Term cloned successfully.",
      summary: {
        classesSelected,
        classesCloned,
        classesSkipped,
        playersSelected,
        playersCopied,
        leaguesSelected,
        leaguesCloned,
        leaguesSkipped,
        teamsSelected,
        teamsCloned,
        leaguePlayersCopied,
        attendanceCopied: false,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.getAdminDashboardOverview = async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const pendingRequestPlayerIds = await RegistrationRequest.find({ status: "PENDING" }).distinct("player");

    const [
      totalPlayers,
      activePlayers,
      pendingPlayers,
      blockedPlayers,
      unallocatedPlayersCount,
      playersTrial,
      playersUnpaid,
      playersPaid,
      playersOverdue,
      playersOthers,

      totalParents,
      approvedParents,
      pendingParents,
      blockedParents,

      totalCoaches,
      activeCoaches,
      superAdmins,

      totalClasses,
      classCapacityAggregate,
      classRosterAggregate,
      totalPrograms,
      totalCategories,
      totalTerms,
      activeTerms,

      totalRequests,
      pendingRequests,
      completedRequests,
      requestTypesAggregate,

      totalEvents,
      upcomingEvents,
      ongoingEvents,
      completedEvents,
      totalEventRegistrations,

      totalInvoices,
      paidInvoices,
      unpaidInvoices,
      pendingPaymentApprovals,
      rejectedPayments,
      todaysCollectionsAgg,
      monthlyCollectionsAgg,
      totalRevenueAgg,
      outstandingAmountAgg,

      totalProducts,
      totalOrders,
      ordersByStatusAgg,
      storeRevenueAgg,

      totalNews,
      featuredNews,
      rawNewsCategories,

      recentRegistrationRequests,
      recentPendingPayments,
      recentPlayers,
      recentTemporaryPlayers,
    ] = await Promise.all([
      User.countDocuments({ parentId: { $exists: true } }),
      User.countDocuments({ parentId: { $exists: true }, playerStatus: "ACTIVE" }),
      User.countDocuments({ parentId: { $exists: true }, playerStatus: "PENDING_APPROVAL" }),
      User.countDocuments({ parentId: { $exists: true }, isBlocked: true }),
      User.countDocuments({
        parentId: { $exists: true },
        isBlocked: false,
        $or: [
          { assignedClasses: { $exists: false } },
          { assignedClasses: { $size: 0 } },
          { assignedClasses: null },
          { hasPendingRequest: true },
          { _id: { $in: pendingRequestPlayerIds } },
        ],
      }),
      User.countDocuments({ parentId: { $exists: true }, "classPaymentStatuses.paymentStatus": "TRIAL" }),
      User.countDocuments({ parentId: { $exists: true }, "classPaymentStatuses.paymentStatus": "UNPAID" }),
      User.countDocuments({ parentId: { $exists: true }, "classPaymentStatuses.paymentStatus": "PAID" }),
      User.countDocuments({ parentId: { $exists: true }, "classPaymentStatuses.paymentStatus": "OVER_DUE" }),
      User.countDocuments({ parentId: { $exists: true }, "classPaymentStatuses.paymentStatus": "OTHERS" }),

      Parent.countDocuments({}),
      Parent.countDocuments({ status: "APPROVED" }),
      Parent.countDocuments({ status: "PENDING" }),
      Parent.countDocuments({ isBlocked: true }),

      Admin.countDocuments({ role: "COACH" }),
      Admin.countDocuments({ role: "COACH", status: "ACTIVE" }),
      Admin.countDocuments({ role: "SUPER_ADMIN" }),

      Class.countDocuments({}),
      Class.aggregate([{ $group: { _id: null, total: { $sum: "$capacity" } } }]),
      Class.aggregate([{ $project: { count: { $size: { $ifNull: ["$players", []] } } } }, { $group: { _id: null, total: { $sum: "$count" } } }]),
      Program.countDocuments({ status: "ACTIVE" }),
      Category.countDocuments({}),
      Term.countDocuments({}),
      Term.countDocuments({ startDate: { $lte: dateOnlyEndUtc(todayDateOnly()) }, endDate: { $gte: dateOnlyStartUtc(todayDateOnly()) } }),

      RegistrationRequest.countDocuments({}),
      RegistrationRequest.countDocuments({ status: "PENDING" }),
      RegistrationRequest.countDocuments({ status: "COMPLETED" }),
      RegistrationRequest.aggregate([{ $group: { _id: "$requestType", count: { $sum: 1 } } }]),

      Event.countDocuments({}),
      Event.countDocuments({ status: "UPCOMING" }),
      Event.countDocuments({ status: "ONGOING" }),
      Event.countDocuments({ status: "COMPLETED" }),
      EventRegistration.countDocuments({ status: "REGISTERED" }),

      Invoice.countDocuments({ status: "ACTIVE" }),
      Invoice.countDocuments({ status: "ACTIVE", paymentStatus: "PAID" }),
      Invoice.countDocuments({ status: "ACTIVE", paymentStatus: { $ne: "PAID" } }),
      Payment.countDocuments({ status: "PENDING" }),
      Payment.countDocuments({ status: "REJECTED" }),
      Payment.aggregate([{ $match: { status: "APPROVED", approvedAt: { $gte: startOfToday } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Payment.aggregate([{ $match: { status: "APPROVED", approvedAt: { $gte: startOfMonth } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Payment.aggregate([{ $match: { status: "APPROVED" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Invoice.aggregate([{ $match: { status: "ACTIVE", paymentStatus: { $ne: "PAID" } } }, { $group: { _id: null, total: { $sum: { $cond: [{ $gt: ["$totalAmount", 0] }, "$totalAmount", { $ifNull: ["$amount", 0] }] } } } }]),

      Product.countDocuments({}),
      Order.countDocuments({}),
      Order.aggregate([{ $group: { _id: "$orderStatus", count: { $sum: 1 } } }]),
      Order.aggregate([{ $match: { orderStatus: "COMPLETED" } }, { $group: { _id: null, total: { $sum: "$totalAmount" } } }]),

      News.countDocuments({}),
      News.countDocuments({ featured: true }),
      News.distinct("category"),

      RegistrationRequest.find({ status: "PENDING" })
        .populate("parent", "fullName email phone")
        .populate("player", "fullName email phone paymentStatus")
        .populate("category", "name")
        .populate("programs", "name")
        .sort({ createdAt: -1 })
        .limit(5),

      Payment.find({ status: "PENDING" })
        .populate("parent", "fullName email phone")
        .populate("invoice", "invoiceNumber type totalAmount")
        .sort({ createdAt: -1 })
        .limit(5),

      User.find({ parentId: { $exists: true } })
        .populate("parentId", "fullName email phone")
        .populate("category", "name")
        .select("firstName lastName fullName email phone paymentStatus playerStatus createdAt")
        .sort({ createdAt: -1 })
        .limit(5),

      User.find({ parentId: { $exists: true }, createdByRole: "COACH" })
        .populate("parentId", "fullName email phone")
        .populate("createdBy", "name email")
        .select("firstName lastName fullName email phone playerStatus temporarySessionDate createdAt")
        .sort({ createdAt: -1 })
        .limit(5),
    ]);

    const requestTypesBreakdown = {};
    (requestTypesAggregate || []).forEach((item) => {
      if (item._id) requestTypesBreakdown[item._id] = item.count;
    });

    const orderStatusBreakdown = {};
    (ordersByStatusAgg || []).forEach((item) => {
      if (item._id) orderStatusBreakdown[item._id] = item.count;
    });

    const responseData = {
      players: {
        total: totalPlayers,
        active: activePlayers,
        pendingApproval: pendingPlayers,
        unallocated: unallocatedPlayersCount,
        allocated: Math.max(0, totalPlayers - unallocatedPlayersCount),
        blocked: blockedPlayers,
        paymentStatusBreakdown: {
          TRIAL: playersTrial,
          UNPAID: playersUnpaid,
          PAID: playersPaid,
          OVER_DUE: playersOverdue,
          OTHERS: playersOthers,
        },
      },
      parents: {
        total: totalParents,
        approved: approvedParents,
        pending: pendingParents,
        blocked: blockedParents,
      },
      staff: {
        totalCoaches,
        activeCoaches,
        superAdmins,
      },
      academics: {
        totalClasses,
        totalCapacity: classCapacityAggregate.length > 0 ? classCapacityAggregate[0].total : 0,
        enrolledSlots: classRosterAggregate.length > 0 ? classRosterAggregate[0].total : 0,
        totalActivePrograms: totalPrograms,
        totalCategories,
        totalTerms,
        activeTermsCount: activeTerms,
      },
      registrationRequests: {
        total: totalRequests,
        pending: pendingRequests,
        completed: completedRequests,
        byType: requestTypesBreakdown,
      },
      events: {
        total: totalEvents,
        upcoming: upcomingEvents,
        ongoing: ongoingEvents,
        completed: completedEvents,
        totalRegistrations: totalEventRegistrations,
      },
      financials: {
        totalInvoices,
        paidInvoices,
        unpaidInvoices,
        totalRevenue: totalRevenueAgg.length > 0 ? totalRevenueAgg[0].total : 0,
        todaysCollections: todaysCollectionsAgg.length > 0 ? todaysCollectionsAgg[0].total : 0,
        monthlyCollections: monthlyCollectionsAgg.length > 0 ? monthlyCollectionsAgg[0].total : 0,
        outstandingAmount: outstandingAmountAgg.length > 0 ? outstandingAmountAgg[0].total : 0,
        pendingPaymentApprovals,
        rejectedPayments,
      },
      store: {
        totalProducts,
        totalOrders,
        byStatus: orderStatusBreakdown,
        storeRevenue: storeRevenueAgg.length > 0 ? storeRevenueAgg[0].total : 0,
      },
      announcements: {
        totalNews,
        featured: featuredNews,
        categoriesCount: (rawNewsCategories || []).filter(Boolean).length,
      },
      recentActivity: {
        pendingRequests: recentRegistrationRequests,
        pendingPayments: recentPendingPayments,
        recentPlayers,
        recentTemporaryPlayers,
      },
    };

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * Helper to compute earnings across all streams (Academy, Leagues, Camps, Store)
 */
const computeEarningsForTerm = async ({ termId, classId, status }) => {
  const isAllTime = !termId || termId === "ALL";
  let termDoc = null;

  if (!isAllTime) {
    if (!mongoose.Types.ObjectId.isValid(termId)) {
      throw new Error("Invalid Term ID format");
    }
    termDoc = await Term.findById(termId).lean();
    if (!termDoc) {
      throw new Error("Term not found");
    }
  }

  const termInfo = isAllTime
    ? { id: "ALL", name: "All Time (All Streams & Terms)" }
    : {
        id: termDoc._id.toString(),
        name: termDoc.name,
        startDate: termDoc.startDate,
        endDate: termDoc.endDate,
      };

  // 1. Academy Classes & Invoices
  const classFilter = isAllTime ? {} : { term: termDoc._id };
  if (classId && classId !== "ALL" && mongoose.Types.ObjectId.isValid(classId)) {
    classFilter._id = classId;
  }

  const classes = await Class.find(classFilter)
    .populate("program", "name")
    .populate("category", "name")
    .populate("coach", "name email mobile profileImage")
    .populate({
      path: "players",
      select: "firstName lastName fullName email phone dob gender profileImage jerseyNumber paymentStatus classPaymentStatuses parentId",
      populate: { path: "parentId", select: "fullName email phone" }
    })
    .lean();

  const classIds = classes.map((c) => c._id);

  // Invoices & Payments for classes
  const [classInvoices, allPayments] = await Promise.all([
    Invoice.find({ class: { $in: classIds }, status: "ACTIVE" }).lean(),
    Payment.find({}).lean(),
  ]);

  const paymentByInvoiceId = {};
  for (const p of allPayments) {
    if (!p.invoice) continue;
    const invId = p.invoice.toString();
    if (!paymentByInvoiceId[invId]) paymentByInvoiceId[invId] = [];
    paymentByInvoiceId[invId].push(p);
  }

  let academyExpected = 0;
  let academyHandshake = 0;
  let academyPaid = 0;
  let academyPending = 0;
  let academyTrialPotential = 0;
  let academyTrialCount = 0;
  let academyHandshakeCount = 0;
  const academyPlayersSet = new Set();
  const classReports = [];
  const allRecords = [];

  for (const classDoc of classes) {
    const classPlayers = classDoc.players || [];
    const playerReports = [];
    let cExpected = 0;
    let cHandshake = 0;
    let cPaid = 0;
    let cPending = 0;

    for (const player of classPlayers) {
      const pIdStr = player._id.toString();
      const parent = player.parentId || {};
      const basePrice = classDoc.price || 0;

      // Check player's classPaymentStatuses
      const cps = (player.classPaymentStatuses || []).find(
        (s) => s.class && s.class.toString() === classDoc._id.toString()
      );
      const rawStatus = (cps ? cps.paymentStatus : (player.paymentStatus || "UNPAID")).toUpperCase();

      // Match player invoices for this class
      const playerInvoices = classInvoices.filter(
        (inv) =>
          inv.class &&
          inv.class.toString() === classDoc._id.toString() &&
          inv.players &&
          inv.players.some((p) => p.toString() === pIdStr)
      );

      let expected = basePrice;
      let handshake = 0;
      let paid = 0;
      let pending = 0;
      let pStatus = rawStatus;

      if (rawStatus === "HANDSHAKE") {
        handshake = basePrice;
        pStatus = "HANDSHAKE";
        academyHandshakeCount++;
      } else if (rawStatus === "TRIAL") {
        pStatus = "TRIAL";
        academyTrialCount++;
        academyTrialPotential += basePrice;
      } else if (playerInvoices.length > 0) {
        const invTotal = playerInvoices.reduce((s, inv) => s + (inv.totalAmount || inv.amount || 0), 0);
        const invDiscount = playerInvoices.reduce((s, inv) => s + (inv.discount || 0), 0);
        expected = invTotal + invDiscount;
        handshake = invDiscount;
        if (handshake > 0) academyHandshakeCount++;

        let totalApprovedPaid = 0;
        let hasPendingPayment = false;
        for (const inv of playerInvoices) {
          const invPayments = paymentByInvoiceId[inv._id.toString()] || [];
          for (const pm of invPayments) {
            if (pm.status === "APPROVED") totalApprovedPaid += (pm.amount || 0);
            if (pm.status === "PENDING") hasPendingPayment = true;
          }
          if (inv.paymentStatus === "PAYMENT_PENDING") hasPendingPayment = true;
        }

        paid = totalApprovedPaid;
        const netBilled = Math.max(0, expected - handshake);
        pending = Math.max(0, netBilled - paid);

        if (paid >= netBilled && netBilled > 0) {
          pStatus = "PAID";
        } else if (paid > 0) {
          pStatus = "PARTIAL";
        } else if (hasPendingPayment) {
          pStatus = "PENDING";
        } else {
          pStatus = "UNPAID";
        }
      } else {
        pending = basePrice;
        pStatus = "UNPAID";
      }

      if (!status || status === "ALL" || pStatus.toUpperCase() === status.toUpperCase()) {
        academyPlayersSet.add(pIdStr);
        cExpected += expected;
        cHandshake += handshake;
        cPaid += paid;
        cPending += pending;

        const pReport = {
          playerId: player._id,
          playerName: player.fullName || `${player.firstName || ""} ${player.lastName || ""}`.trim() || "Player",
          playerEmail: player.email || null,
          parentName: parent.fullName || null,
          parentPhone: parent.phone || player.phone || null,
          class: {
            id: classDoc._id,
            name: classDoc.name,
          },
          term: termInfo,
          expectedAmount: expected,
          handshakeAmount: handshake,
          netAmount: Math.max(0, expected - handshake),
          paidAmount: paid,
          pendingAmount: pending,
          paymentStatus: pStatus,
        };
        playerReports.push(pReport);

        allRecords.push({
          id: `class-${classDoc._id}-${player._id}`,
          stream: "ACADEMY",
          streamLabel: "Academy Class",
          playerId: player._id.toString(),
          playerName: pReport.playerName,
          playerEmail: pReport.playerEmail,
          parentName: pReport.parentName,
          parentPhone: pReport.parentPhone,
          avatar: player.profileImage || "",
          title: classDoc.name,
          categoryOrProgram: `${classDoc.category?.name || "Academy"} › ${classDoc.program?.name || "Program"}`,
          termName: termInfo.name,
          price: expected,
          handshakeAmount: handshake,
          netAmount: Math.max(0, expected - handshake),
          paidAmount: paid,
          pendingAmount: pending,
          paymentStatus: pStatus,
          createdAt: classDoc.createdAt,
        });
      }
    }

    if (!status || status === "ALL" || playerReports.length > 0) {
      classReports.push({
        classId: classDoc._id,
        className: classDoc.name,
        program: classDoc.program?.name || null,
        category: classDoc.category?.name || null,
        coach: classDoc.coach ? { id: classDoc.coach._id, name: classDoc.coach.name } : null,
        price: classDoc.price || 0,
        totalPlayers: playerReports.length,
        expectedAmount: cExpected,
        handshakeAmount: cHandshake,
        paidAmount: cPaid,
        pendingAmount: cPending,
        refundedAmount: 0,
        outstandingAmount: cPending,
        players: playerReports,
      });

      academyExpected += cExpected;
      academyHandshake += cHandshake;
      academyPaid += cPaid;
      academyPending += cPending;
    }
  }

  // 2. Leagues Stream
  const teamFilter = isAllTime ? {} : { term: termDoc._id };
  const teams = await Team.find(teamFilter)
    .populate("coach", "name")
    .populate("leagues.league", "name fee")
    .populate({
      path: "players.player",
      select: "firstName lastName fullName email phone profileImage parentId",
      populate: { path: "parentId", select: "fullName email phone" }
    })
    .lean();

  let leagueExpected = 0;
  let leagueHandshake = 0;
  let leaguePaid = 0;
  let leaguePending = 0;
  let leagueTrialPotential = 0;
  let leagueTrialCount = 0;
  let leagueHandshakeCount = 0;
  const leaguePlayersSet = new Set();
  const leagueReports = [];

  for (const team of teams) {
    const primaryLeague = team.leagues && team.leagues[0]?.league;
    const leagueFee = (primaryLeague && primaryLeague.fee) ? primaryLeague.fee : 150;
    const teamName = team.teamName || "Team";
    const leagueName = primaryLeague?.name || "League Tournament";

    for (const item of (team.players || [])) {
      const pl = item.player;
      if (!pl) continue;
      const plIdStr = pl._id.toString();
      const parent = pl.parentId || {};
      const rawStatus = (item.paymentStatus || "UNPAID").toUpperCase();

      let expected = leagueFee;
      let handshake = 0;
      let paid = 0;
      let pending = 0;
      let pStatus = rawStatus;

      if (rawStatus === "HANDSHAKE") {
        handshake = leagueFee;
        pStatus = "HANDSHAKE";
        leagueHandshakeCount++;
      } else if (rawStatus === "TRIAL") {
        pStatus = "TRIAL";
        leagueTrialCount++;
        leagueTrialPotential += leagueFee;
      } else if (rawStatus === "PAID" || rawStatus === "APPROVED") {
        paid = leagueFee;
        pStatus = "PAID";
      } else if (rawStatus === "PENDING" || rawStatus === "PAYMENT_PENDING") {
        pending = leagueFee;
        pStatus = "PENDING";
      } else {
        pending = leagueFee;
        pStatus = "UNPAID";
      }

      if (!status || status === "ALL" || pStatus.toUpperCase() === status.toUpperCase()) {
        leaguePlayersSet.add(plIdStr);
        leagueExpected += expected;
        leagueHandshake += handshake;
        leaguePaid += paid;
        leaguePending += pending;

        allRecords.push({
          id: `league-${team._id}-${pl._id}`,
          stream: "LEAGUES",
          streamLabel: "League Team",
          playerId: plIdStr,
          playerName: pl.fullName || `${pl.firstName || ""} ${pl.lastName || ""}`.trim() || "Player",
          playerEmail: pl.email || null,
          parentName: parent.fullName || null,
          parentPhone: parent.phone || pl.phone || null,
          avatar: pl.profileImage || "",
          title: `${teamName} (${leagueName})`,
          categoryOrProgram: "Leagues & Tournaments",
          termName: termInfo.name,
          price: expected,
          handshakeAmount: handshake,
          netAmount: Math.max(0, expected - handshake),
          paidAmount: paid,
          pendingAmount: pending,
          paymentStatus: pStatus,
          createdAt: team.createdAt,
        });
      }
    }
  }

  // 3. Holiday Camps & Events Stream
  const eventDateFilter = {};
  if (!isAllTime && termDoc.startDate && termDoc.endDate) {
    eventDateFilter.createdAt = calendarTimestampRange(termDoc.startDate, termDoc.endDate);
  }
  const eventRegistrations = await EventRegistration.find(eventDateFilter)
    .populate("event", "title startDate endDate category")
    .populate({
      path: "user",
      select: "firstName lastName fullName email phone profileImage parentId",
      populate: { path: "parentId", select: "fullName email phone" }
    })
    .lean();

  let campExpected = 0;
  let campHandshake = 0;
  let campPaid = 0;
  let campPending = 0;
  let campTrialPotential = 0;
  let campTrialCount = 0;
  let campHandshakeCount = 0;
  const campPlayersSet = new Set();

  for (const reg of eventRegistrations) {
    const user = reg.user;
    if (!user) continue;
    const userIdStr = user._id.toString();
    const parent = user.parentId || {};
    const eventTitle = reg.event?.title || "Holiday Camp / Event";
    const amount = reg.totalAmount || 0;
    const rawStatus = (reg.paymentStatus || "UNPAID").toUpperCase();

    let expected = amount;
    let handshake = 0;
    let paid = 0;
    let pending = 0;
    let pStatus = rawStatus;

    if (rawStatus === "HANDSHAKE") {
      handshake = amount;
      pStatus = "HANDSHAKE";
      campHandshakeCount++;
    } else if (rawStatus === "TRIAL") {
      pStatus = "TRIAL";
      campTrialCount++;
      campTrialPotential += amount;
    } else if (rawStatus === "PAID" || rawStatus === "APPROVED") {
      paid = amount;
      pStatus = "PAID";
    } else if (rawStatus === "PENDING" || rawStatus === "PAYMENT_PENDING") {
      pending = amount;
      pStatus = "PENDING";
    } else {
      pending = amount;
      pStatus = "UNPAID";
    }

    if (!status || status === "ALL" || pStatus.toUpperCase() === status.toUpperCase()) {
      campPlayersSet.add(userIdStr);
      campExpected += expected;
      campHandshake += handshake;
      campPaid += paid;
      campPending += pending;

      allRecords.push({
        id: `camp-${reg._id}`,
        stream: "CAMPS",
        streamLabel: "Holiday Camp / Event",
        playerId: userIdStr,
        playerName: user.fullName || `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Participant",
        playerEmail: user.email || null,
        parentName: parent.fullName || null,
        parentPhone: parent.phone || user.phone || null,
        avatar: user.profileImage || "",
        title: eventTitle,
        categoryOrProgram: reg.event?.category || "Holiday Camps & Events",
        termName: termInfo.name,
        price: expected,
        handshakeAmount: handshake,
        netAmount: Math.max(0, expected - handshake),
        paidAmount: paid,
        pendingAmount: pending,
        paymentStatus: pStatus,
        createdAt: reg.createdAt,
      });
    }
  }

  // 4. Store Merchandise Orders Stream
  const orderDateFilter = {};
  if (!isAllTime && termDoc.startDate && termDoc.endDate) {
    orderDateFilter.createdAt = calendarTimestampRange(termDoc.startDate, termDoc.endDate);
  }
  const orders = await Order.find(orderDateFilter)
    .populate("parent", "fullName email phone")
    .populate("items.product", "name price")
    .lean();

  let storeExpected = 0;
  let storePaid = 0;
  let storePending = 0;

  for (const ord of orders) {
    const parent = ord.parent || {};
    const ordTotal = ord.totalAmount || 0;
    const isPaid = ord.paymentStatus === "PAID" || ord.status === "DELIVERED";
    const isPending = ord.paymentStatus === "PENDING" || ord.status === "PENDING" || ord.status === "PROCESSING";

    let paid = isPaid ? ordTotal : 0;
    let pending = !isPaid ? ordTotal : 0;
    let pStatus = isPaid ? "PAID" : isPending ? "PENDING" : "UNPAID";

    if (!status || status === "ALL" || pStatus.toUpperCase() === status.toUpperCase()) {
      storeExpected += ordTotal;
      storePaid += paid;
      storePending += pending;

      const itemTitles = (ord.items || []).map((i) => i.product?.name || "Product").join(", ");

      allRecords.push({
        id: `order-${ord._id}`,
        stream: "STORE",
        streamLabel: "Store Order",
        playerId: ord._id.toString(),
        playerName: parent.fullName || "Customer",
        playerEmail: parent.email || null,
        parentName: parent.fullName || null,
        parentPhone: parent.phone || null,
        avatar: "",
        title: `Order #${ord.orderNumber || ord._id.toString().slice(-6).toUpperCase()}: ${itemTitles || "Store Merchandise"}`,
        categoryOrProgram: "Commerce & Merchandise",
        termName: termInfo.name,
        price: ordTotal,
        handshakeAmount: 0,
        netAmount: ordTotal,
        paidAmount: paid,
        pendingAmount: pending,
        paymentStatus: pStatus,
        createdAt: ord.createdAt,
      });
    }
  }

  // Aggregate Total Metrics
  const totalExpected = academyExpected + leagueExpected + campExpected + storeExpected;
  const totalHandshake = academyHandshake + leagueHandshake + campHandshake;
  const totalNetExpected = Math.max(0, totalExpected - totalHandshake);
  const totalPaid = academyPaid + leaguePaid + campPaid + storePaid;
  const totalPending = academyPending + leaguePending + campPending + storePending;
  const totalTrialPotential = academyTrialPotential + leagueTrialPotential + campTrialPotential;
  const totalTrialCount = academyTrialCount + leagueTrialCount + campTrialCount;
  const totalHandshakeCount = academyHandshakeCount + leagueHandshakeCount + campHandshakeCount;

  const totalDistinctPlayers = new Set([
    ...academyPlayersSet,
    ...leaguePlayersSet,
    ...campPlayersSet,
  ]).size;

  const collectionRate = totalNetExpected > 0 ? Math.round((totalPaid / totalNetExpected) * 100) : 0;

  return {
    term: termInfo,
    isAllTime,
    summary: {
      totalClasses: classReports.length,
      totalPlayers: totalDistinctPlayers || allRecords.length,
      totalExpected,
      totalHandshake,
      totalNetExpected,
      totalPaid,
      totalPending,
      totalOutstanding: totalPending,
      totalRefunded: 0,
      totalTrialPotential,
      totalTrialCount,
      totalHandshakeCount,
      collectionRate,
      streams: {
        academy: {
          label: "Academy Classes",
          expected: academyExpected,
          handshake: academyHandshake,
          netExpected: Math.max(0, academyExpected - academyHandshake),
          paid: academyPaid,
          pending: academyPending,
          trials: academyTrialPotential,
          count: academyPlayersSet.size,
        },
        leagues: {
          label: "Leagues & Tournaments",
          expected: leagueExpected,
          handshake: leagueHandshake,
          netExpected: Math.max(0, leagueExpected - leagueHandshake),
          paid: leaguePaid,
          pending: leaguePending,
          trials: leagueTrialPotential,
          count: leaguePlayersSet.size,
        },
        camps: {
          label: "Holiday Camps & Events",
          expected: campExpected,
          handshake: campHandshake,
          netExpected: Math.max(0, campExpected - campHandshake),
          paid: campPaid,
          pending: campPending,
          trials: campTrialPotential,
          count: campPlayersSet.size,
        },
        store: {
          label: "Store Merchandise",
          expected: storeExpected,
          handshake: 0,
          netExpected: storeExpected,
          paid: storePaid,
          pending: storePending,
          trials: 0,
          count: orders.length,
        },
      },
    },
    classes: classReports,
    allRecords,
  };
};

exports.getTermEarningsReport = async (req, res) => {
  try {
    const { termId } = req.params;
    const { classId, status, compareTermId } = req.query;

    const mainResult = await computeEarningsForTerm({
      termId,
      classId,
      status,
    });

    let comparison = null;
    if (compareTermId && compareTermId !== "NONE" && mongoose.Types.ObjectId.isValid(compareTermId)) {
      try {
        const compareResult = await computeEarningsForTerm({
          termId: compareTermId,
          classId: "ALL",
          status: "ALL",
        });
        comparison = {
          termA: mainResult.summary,
          termB: compareResult.summary,
          termAName: mainResult.term.name,
          termBName: compareResult.term.name,
          growthExpected: compareResult.summary.totalExpected - mainResult.summary.totalExpected,
          growthPaid: compareResult.summary.totalPaid - mainResult.summary.totalPaid,
          growthPercent: mainResult.summary.totalPaid > 0
            ? Math.round(((compareResult.summary.totalPaid - mainResult.summary.totalPaid) / mainResult.summary.totalPaid) * 100)
            : 0,
        };
      } catch (err) {
        console.warn("Failed to calculate comparison:", err.message);
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        ...mainResult,
        comparison,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.updatePlayer = async (req, res, next) => {
  const tx = await mongoose.startSession();
  let result; let oldImage; let committed = false;
  try {
    if (!req.admin || !['ADMIN','SUPER_ADMIN'].includes(req.admin.role)) return res.status(403).json({ success: false, message: 'Admin access required' });
    const { playerId } = req.params;
    if (!mongoose.isValidObjectId(playerId)) return res.status(400).json({ success: false, message: 'Invalid player ID' });
    await tx.withTransaction(async () => {
      const player = await User.findById(playerId).session(tx);
      if (!player) throw Object.assign(new Error('Player not found'), { status: 404 });
      const input = req.body; const update = {};
      for (const key of ['school','comments','additionalComments','contactName','relationship','club']) if (input[key] !== undefined) update[key] = String(input[key]).trim();
      if (input.fullName !== undefined) {
        const name = String(input.fullName).trim(); if (!name) throw Object.assign(new Error('Player name is required'),{status:400});
        update.fullName=name; const [first,...last]=name.split(/\s+/); update.firstName=first; update.lastName=last.join(' ');
      } else if (input.firstName !== undefined || input.lastName !== undefined) {
        update.firstName=String(input.firstName ?? player.firstName ?? '').trim(); update.lastName=String(input.lastName ?? player.lastName ?? '').trim(); update.fullName=[update.firstName,update.lastName].filter(Boolean).join(' ');
      }
      for (const key of ['email','phone']) if (input[key] !== undefined) update[key]=String(input[key] || '').trim() || null;
      if(update.email) update.email=update.email.toLowerCase();
      for(const key of ['gender','playerStatus']) if(input[key] !== undefined) update[key]=String(input[key]).toUpperCase();
      const foot=input.prefferedFoot ?? input.preferredFoot; if(foot !== undefined) update.prefferedFoot=String(foot).toUpperCase();
      for(const key of ['jerseyNumber','rating']) if(input[key] !== undefined && input[key] !== '') { const value=Number(input[key]); if(!Number.isFinite(value)) throw Object.assign(new Error('Invalid '+key),{status:400}); update[key]=value; }
      if(input.isBlocked !== undefined) {if(![true,false,'true','false'].includes(input.isBlocked))throw Object.assign(new Error('Invalid blocked flag'),{status:400});update.isBlocked=input.isBlocked===true||input.isBlocked==='true';}
      const dates=require('../utils/dateTime');
      if(input.dob) { update.dob=dates.dateOnlyToUtc(input.dob,'Date of birth'); if(dates.dateOnly(update.dob)>dates.todayDateOnly()) throw Object.assign(new Error('Date of birth cannot be in the future'),{status:400}); }
      for(const [key,Model] of [['term',Term],['category',Category]]) if(input[key] !== undefined) {
        if(!input[key])update[key]=null;
        else {if(!mongoose.isValidObjectId(input[key])||!await Model.exists({_id:input[key]}).session(tx))throw Object.assign(new Error('Invalid '+key),{status:400});update[key]=input[key];}
      }
      if(input.parentId && String(input.parentId)!==String(player.parentId)) throw Object.assign(new Error('Household transfers require verified parent ownership; update the existing parent contact here'),{status:409});
      if(input.programs !== undefined || input.program !== undefined) {
        let programs=input.programs ?? [input.program]; if(typeof programs==='string'){try{programs=JSON.parse(programs)}catch{programs=programs.split(',')}}
        if(!Array.isArray(programs)||programs.some(value=>!mongoose.isValidObjectId(value)))throw Object.assign(new Error('Invalid programs'),{status:400});
        programs=[...new Set(programs.map(String))];if(await Program.countDocuments({_id:{$in:programs}}).session(tx)!==programs.length)throw Object.assign(new Error('Program not found'),{status:400});update.programs=programs;
      }
      const parentFields={parentFullName:'fullName',parentPhone:'phone',parentEmail:'email',emergencyContact:'emergencyContact',parentRelationship:'relationship'};
      const contact={};for(const [from,to] of Object.entries(parentFields))if(input[from]!==undefined){contact[to]=String(input[from]).trim();if(!contact[to])throw Object.assign(new Error(to+' cannot be empty'),{status:400});}
      if(contact.email)contact.email=contact.email.toLowerCase();
      if(Object.keys(contact).length) await Parent.findByIdAndUpdate(player.parentId,{$set:contact},{runValidators:true,session:tx});
      const MedicalProfile=require('../models/MedicalProfile');
      if(['isMedicalCondition','medicalConditions','medicalConditionDetails','allergies'].some(key=>input[key]!==undefined)){
        const profile=await MedicalProfile.findOne({player:playerId}).session(tx);
        const normalized=require('../utils/medicalStatus').normalizeMedicalStatus({isMedicalCondition:input.isMedicalCondition ?? player.isMedicalCondition,medicalConditionDetails:input.medicalConditionDetails ?? input.medicalConditions ?? player.medicalConditionDetails,allergies:input.allergies ?? profile?.allergies ?? []});
        update.isMedicalCondition=normalized.isMedicalCondition;update.medicalConditionDetails=normalized.medicalConditionDetails;
        await MedicalProfile.updateOne({player:playerId},{$set:{medicalConditions:normalized.medicalConditions,allergies:normalized.allergies}},{upsert:true,session:tx,runValidators:true});
        await require('../models/MedicalRevision').create([{player:playerId,actor:req.admin._id,actorType:'ADMIN',previous:{isMedicalCondition:player.isMedicalCondition,medicalConditionDetails:player.medicalConditionDetails},current:normalized}],{session:tx});
      }
      if(req.file){oldImage=player.profileImage;update.profileImage='uploads/profiles/'+req.file.filename;}
      else if(input.profileImage === ''){oldImage=player.profileImage;update.profileImage='';}
      else if(input.profileImage !== undefined && input.profileImage !== player.profileImage)throw Object.assign(new Error('Upload a file to change the profile image'),{status:400});
      Object.assign(player,update);await player.save({session:tx});
      result=await User.findById(playerId).populate('parentId','fullName email phone emergencyContact relationship profileImage').populate('category','name').populate('programs','name').populate('term','name year').session(tx).lean();
      if(result.dob)result.dob=dates.dateOnly(result.dob);
    });
    committed = true;
    if(oldImage && oldImage !== result.profileImage) await require('../utils/upload').removeStoredUpload(oldImage).catch(()=>{});
    return res.json({success:true,message:'Player updated successfully',data:result});
  } catch(error) {
    return next(error);
  } finally {await tx.endSession();if(!committed && req.file?.filename)await require('../utils/upload').removeStoredUpload('uploads/profiles/'+req.file.filename).catch(()=>{});}
};

/**
 * Calculate dynamic badge counts for sidebar navigation
 */
const calculateSidebarBadges = async () => {
  const [
    verificationRequestDocs,
    temporaryPlayerDocs,
    unallocatedPlayerDocs,
    unpaidInvoiceDocs,
    pendingPaymentDocs,
    eventRegistrationDocs,
    orderDocs,
  ] = await Promise.all([
    // 1. Verification requests (parent/player registration requests pending review)
    RegistrationRequest.find({
      status: "PENDING",
    })
      .select("_id")
      .lean(),
    // 2. Temporary players (pending coach temporary player approvals)
    RegistrationRequest.find({ status: "PENDING", requestType: { $in: ["TEMPORARY_PLAYER", "TEMPORARY"] } }).select("_id").lean(),
    // 3. Unallocated players (players without assigned classes or with pending class requests)
    User.find({
      parentId: { $exists: true },
      isBlocked: false,
      $or: [
        { assignedClasses: { $exists: false } },
        { assignedClasses: { $size: 0 } },
        { assignedClasses: null },
        { hasPendingRequest: true },
      ],
    })
      .select("_id")
      .lean(),
    // 4. Invoices needing payment / action
    Invoice.find({ status: "ACTIVE", paymentStatus: { $ne: "PAID" } })
      .select("_id")
      .lean(),
    // 5. Payments pending admin approval
    Payment.find({ status: "PENDING" }).select("_id").lean(),
    // 6. Event registrations pending payment / approval
    EventRegistration.find({
      status: { $in: ["REGISTERED", "PENDING"] },
      paymentStatus: { $ne: "PAID" },
    })
      .select("_id")
      .lean(),
    // 7. Store orders pending processing / placed
    Order.find({ status: { $in: ["PENDING", "PROCESSING"] } })
      .select("_id")
      .lean(),
  ]);

  const pendingItemIds = {
    verificationRequests: verificationRequestDocs.map((d) => d._id.toString()),
    temporaryPlayers: temporaryPlayerDocs.map((d) => d._id.toString()),
    unallocatedPlayers: unallocatedPlayerDocs.map((d) => d._id.toString()),
    unpaidInvoices: unpaidInvoiceDocs.map((d) => d._id.toString()),
    pendingPayments: pendingPaymentDocs.map((d) => d._id.toString()),
    eventRegistrations: eventRegistrationDocs.map((d) => d._id.toString()),
    orders: orderDocs.map((d) => d._id.toString()),
  };

  return {
    verificationRequests: verificationRequestDocs.length,
    temporaryPlayers: temporaryPlayerDocs.length,
    unallocatedPlayers: unallocatedPlayerDocs.length,
    unpaidInvoices: unpaidInvoiceDocs.length,
    pendingPayments: pendingPaymentDocs.length,
    eventRegistrations: eventRegistrationDocs.length,
    orders: orderDocs.length,
    pendingItemIds,
    playersManagementTotal:
      verificationRequestDocs.length,
    financeTotal: unpaidInvoiceDocs.length + pendingPaymentDocs.length,
  };
};

exports.calculateSidebarBadges = calculateSidebarBadges;

exports.getSidebarBadges = async (req, res) => {
  try {
    const badges = await calculateSidebarBadges();
    return res.status(200).json({
      success: true,
      data: badges,
    });
  } catch (error) {
    console.error("getSidebarBadges error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
