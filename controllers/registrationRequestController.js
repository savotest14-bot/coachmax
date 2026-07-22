const RegistrationRequest = require("../models/RegistrationRequest");
const User = require("../models/User");
const Parent = require("../models/Parent");
const Class = require("../models/Class");
const Term = require("../models/Term");
const Category = require("../models/Category");
const Program = require("../models/Program");
const Notification = require("../models/Notification");

// ✅ List / Search / Filter Registration Requests (Admin)
exports.getRegistrationRequests = async (req, res) => {
  try {
    let {
      status,
      requestType,
      category,
      program,
      searchParent,
      searchPlayer,
      search,
      page = 1,
      limit = 10,
    } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = {};

    if (status) {
      query.status = status;
    }

    if (requestType) {
      query.requestType = requestType;
    }

    if (category) {
      query.category = category;
    }

    if (program) {
      query.programs = program;
    }

    // Search by parent name
    const parentSearchTerm = searchParent || search;
    if (parentSearchTerm) {
      const parents = await Parent.find({
        fullName: { $regex: parentSearchTerm, $options: "i" },
      }).select("_id");
      const parentIds = parents.map((p) => p._id);
      query.parent = { $in: parentIds };
    }

    // Search by player name
    if (searchPlayer) {
      const players = await User.find({
        $or: [
          { fullName: { $regex: searchPlayer, $options: "i" } },
          { firstName: { $regex: searchPlayer, $options: "i" } },
          { lastName: { $regex: searchPlayer, $options: "i" } },
        ],
      }).select("_id");
      const playerIds = players.map((p) => p._id);
      query.player = { $in: playerIds };
    }

    const total = await RegistrationRequest.countDocuments(query);

    const requests = await RegistrationRequest.find(query)
      .populate("parent", "fullName email phone address city")
      .populate(
        "player",
        "firstName lastName fullName email phone dob gender profileImage rating paymentStatus term assignedClasses"
      )
      .populate("category", "name")
      .populate("programs", "name")
      .populate("preferredTerm", "name startDate endDate")
      .populate("preferredClasses", "name dayOfWeek startTime endTime venue location")
      .populate("assignedBy", "name email")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data: requests,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Fetch Unallocated Players by Category and Program (Admin)
// Requirement: GET /admin/players/unallocated?category=CAT_ID&program=PROGRAM_ID&search=SEARCH
exports.getUnallocatedPlayers = async (req, res) => {
  try {
    const { category, program, search } = req.query;

    // Find players from RegistrationRequest if category/program supplied
    let playerIdsFromRequests = [];
    if (category || program) {
      const reqFilter = {};
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
      ],
    };

    if (category || program) {
      const catProgConditions = [];
      const userDirectMatch = {};
      if (category) userDirectMatch.category = category;
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

    // Fetch matching unallocated players
    const unallocatedPlayers = await User.find(query)
      .populate("parentId", "fullName email phone emergencyContact relationship")
      .populate("category", "name")
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
    const { category, program, search, allocationStatus } = req.query;

    const query = {
      isBlocked: false,
    };

    // ---------------------------------------------------
    // UNALLOCATED -> Players having a PENDING Registration Request
    // ---------------------------------------------------
    if (allocationStatus === "UNALLOCATED") {
      const requestFilter = {
        status: "PENDING",
      };

      if (category) requestFilter.category = category;
      if (program) requestFilter.programs = program;

      const pendingPlayerIds = await RegistrationRequest.find(requestFilter).distinct(
        "player"
      );

      query._id = { $in: pendingPlayerIds };
    } else {
      // ---------------------------------------------------
      // Normal Category / Program Filter
      // ---------------------------------------------------
      if (category) {
        query.category = category;
      }

      if (program) {
        query.programs = program;
      }
    }

    // ---------------------------------------------------
    // ALLOCATED -> Players having assigned classes
    // ---------------------------------------------------
    if (allocationStatus === "ALLOCATED") {
      query["assignedClasses.0"] = { $exists: true };
    }

    // ---------------------------------------------------
    // Search
    // ---------------------------------------------------
    if (search) {
      const regex = new RegExp(search, "i");

      query.$or = [
        { fullName: regex },
        { firstName: regex },
        { lastName: regex },
        { email: regex },
        { phone: regex },
      ];
    }

    // ---------------------------------------------------
    // Fetch Players
    // ---------------------------------------------------
    const players = await User.find(query)
      .populate(
        "parentId",
        "fullName email phone emergencyContact relationship"
      )
      .populate("category", "name")
      .populate("programs", "name")
      .populate("term", "name")
      .populate(
        "assignedClasses",
        "name dayOfWeek startTime endTime venue location"
      )
      .sort({ createdAt: -1 });

    // ---------------------------------------------------
    // Attach Registration Request (Only for UNALLOCATED)
    // ---------------------------------------------------
    let registrationRequestsMap = {};

    if (allocationStatus === "UNALLOCATED") {
      const registrationRequests = await RegistrationRequest.find({
        player: { $in: players.map((p) => p._id) },
        status: "PENDING",
      })
        .populate("category", "name")
        .populate("programs", "name")
        .populate("preferredTerm", "name");

      registrationRequestsMap = registrationRequests.reduce((acc, request) => {
        acc[request.player.toString()] = request;
        return acc;
      }, {});
    }

    // ---------------------------------------------------
    // Build Response
    // ---------------------------------------------------
    const data = players.map((player) => {
      const obj = player.toObject();

      if (allocationStatus === "UNALLOCATED") {
        obj.registrationRequest =
          registrationRequestsMap[player._id.toString()] || null;
      }

      return obj;
    });

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


// ✅ Assign Classes to Player (Admin)
// Requirement: PATCH /admin/player/:playerId/assign-classes
exports.assignClassesToPlayer = async (req, res) => {
  try {
    const playerId = req.params.playerId || req.body.playerId;
    const { registrationRequestId, classIds, paymentStatus } = req.body;

    if (!playerId) {
      return res.status(400).json({
        success: false,
        message: "playerId is required",
      });
    }

    if (!classIds || !Array.isArray(classIds) || classIds.length === 0 || !paymentStatus) {
      return res.status(400).json({
        success: false,
        message: "classIds (array) and paymentStatus are required",
      });
    }

    // Validate paymentStatus
    const validPaymentStatuses = ["TRIAL", "UNPAID", "PAID", "OVER_DUE"];
    if (!validPaymentStatuses.includes(paymentStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid paymentStatus value",
      });
    }

    // Fetch Player
    const playerDoc = await User.findById(playerId);
    if (!playerDoc) {
      return res.status(404).json({
        success: false,
        message: "Player not found",
      });
    }

    // Handle RegistrationRequest (Optional)
    let requestDoc = null;
    if (registrationRequestId) {
      requestDoc = await RegistrationRequest.findById(registrationRequestId);
      if (!requestDoc) {
        return res.status(404).json({
          success: false,
          message: "Registration request not found",
        });
      }

      if (requestDoc.player.toString() !== playerId.toString()) {
        return res.status(400).json({
          success: false,
          message: "Registration request does not match specified player",
        });
      }

      if (requestDoc.status === "COMPLETED") {
        return res.status(400).json({
          success: false,
          message: "This registration request has already been completed",
        });
      }
    } else {
      // Look up any pending RegistrationRequest for this player
      requestDoc = await RegistrationRequest.findOne({
        player: playerId,
        status: "PENDING",
      }).sort({ createdAt: -1 });
    }

    // Fetch Selected Classes
    const selectedClasses = await Class.find({ _id: { $in: classIds } });
    if (selectedClasses.length !== classIds.length) {
      return res.status(404).json({
        success: false,
        message: "One or more selected classes were not found",
      });
    }

    // -------------------------------------------------------------
    // VALIDATIONS:
    // 1. Every selected class belongs to the SAME Term.
    // -------------------------------------------------------------
    const firstClassTermStr = selectedClasses[0].term.toString();

    for (const cls of selectedClasses) {
      if (cls.term.toString() !== firstClassTermStr) {
        return res.status(400).json({
          success: false,
          message: "All selected classes must belong to the same Term",
        });
      }
    }

    // Automatic Term Assignment from derived class term
    const derivedTermId = selectedClasses[0].term;

    // Derived category and programs from selected classes / request / player
    const assignedCategory = selectedClasses[0].category || (requestDoc ? requestDoc.category : playerDoc.category);
    const newProgramIds = selectedClasses.map((c) => c.program.toString());
    if (requestDoc && requestDoc.programs) {
      newProgramIds.push(...requestDoc.programs.map((p) => p.toString()));
    }
    if (playerDoc.programs) {
      newProgramIds.push(...playerDoc.programs.map((p) => p.toString()));
    }

    const updatedProgramIds = [...new Set(newProgramIds.filter(Boolean))];

    // Update Player Document (Save actual allocation)
    playerDoc.assignedClasses = classIds;
    if (playerDoc.removedClasses) {
      playerDoc.removedClasses = playerDoc.removedClasses.filter(
        (c) => !classIds.map((id) => id.toString()).includes(c.toString())
      );
    }
    playerDoc.term = derivedTermId;
    playerDoc.paymentStatus = paymentStatus;
    playerDoc.category = assignedCategory;
    playerDoc.programs = updatedProgramIds;
    await playerDoc.save();

    // Ensure player is added to selected classes' players array
    await Class.updateMany(
      { _id: { $in: classIds } },
      { $addToSet: { players: playerId } }
    );

    // Update RegistrationRequest Document if exists
    if (requestDoc) {
      requestDoc.status = "COMPLETED";
      requestDoc.assignedBy = req.admin ? req.admin._id : null;
      requestDoc.assignedAt = new Date();
      await requestDoc.save();
    }

    // Send Parent Notification
    try {
      const termObj = await Term.findById(derivedTermId).select("name");
      const classNames = selectedClasses.map((c) => c.name).join(", ");
      const notificationMsg = `Your player ${playerDoc.fullName} has been allocated and enrolled.
Assigned Classes: ${classNames}
Term: ${termObj ? termObj.name : "N/A"}
Payment Status: ${paymentStatus}`;

      await Notification.create({
        parent: playerDoc.parentId,
        title: "Player Enrollment Completed 🎉",
        message: notificationMsg,
        type: "PLAYER_ALLOCATED",
      });
    } catch (notifErr) {
      console.error("Failed to create parent allocation notification:", notifErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Player allocated to classes and enrolled successfully",
      data: {
        player: playerDoc,
        registrationRequest: requestDoc,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
