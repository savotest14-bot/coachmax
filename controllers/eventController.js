const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const User = require("../models/User");
const Category = require("../models/Category");
const RegistrationRequest = require("../models/RegistrationRequest");
const CampSession = require("../models/CampSession");
const Attendance = require("../models/Attendance");
const Invoice = require("../models/Invoice");
const Parent = require("../models/Parent");
const { generateInvoiceNumber } = require("./invoiceController");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

exports.createEvent = async (req, res) => {
  try {
    let bannerImage = null;

    if (req.file) {
      bannerImage = `uploads/eventImg/${req.file.filename}`;
    }

    let bodyData = { ...req.body };
    if (typeof bodyData.campConfig === "string") {
      try {
        bodyData.campConfig = JSON.parse(bodyData.campConfig);
      } catch (e) {}
    }

    let initialSessions = [];
    if (bodyData.sessions) {
      if (typeof bodyData.sessions === "string") {
        try {
          initialSessions = JSON.parse(bodyData.sessions);
        } catch (e) {}
      } else if (Array.isArray(bodyData.sessions)) {
        initialSessions = bodyData.sessions;
      }
      delete bodyData.sessions;
    }

    const event = await Event.create({
      ...bodyData,
      bannerImage,
      createdBy: req.admin._id,
    });

    if (Array.isArray(initialSessions) && initialSessions.length > 0) {
      const sessionDocs = initialSessions.map((s) => ({
        event: event._id,
        sessionDate: new Date(s.sessionDate),
        sessionType: s.sessionType || "FULL_DAY",
        sessionLabel: s.sessionLabel || (s.sessionType === "HALF_DAY" ? "Half Day" : "Full Day"),
        startTime: s.startTime || (s.sessionType === "HALF_DAY" ? "08:00 AM" : "08:00 AM"),
        endTime: s.endTime || (s.sessionType === "HALF_DAY" ? "02:00 PM" : "04:00 PM"),
        fee: Number(s.fee !== undefined ? s.fee : (s.sessionType === "HALF_DAY" ? 70 : 90)),
        capacity: s.capacity !== undefined && s.capacity !== null && s.capacity !== "" ? Number(s.capacity) : null,
        isAvailable: s.isAvailable !== false,
      }));
      await CampSession.insertMany(sessionDocs);
    }

    res.status(201).json({
      success: true,
      message: "Event created successfully",
      data: event,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.getAllEventsForAdmin = async (req, res) => {
  try {
    const events = await Event.find()
      .sort({ createdAt: -1 })
      .populate("createdBy", "name email");

    const updatedEvents = events.map((event) => {
      const totalSlots = event.maxParticipants || 0;
      const registered = event.totalRegistered || 0;
      const availableSlots = totalSlots - registered;

      return {
        ...event._doc,
        stats: {
          totalSlots,
          registered,
          availableSlots,
        },
      };
    });

    res.status(200).json({
      success: true,
      count: updatedEvents.length,
      data: updatedEvents,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.updateEventStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowedStatus = ["UPCOMING", "ONGOING", "COMPLETED"];
    if (!allowedStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Allowed values: ${allowedStatus.join(", ")}`,
      });
    }

    const event = await Event.findById(id);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    event.status = status;

  
    if (["ONGOING", "COMPLETED"].includes(status)) {
      event.isRegistrationOpen = false;
    }

    await event.save();

    res.status(200).json({
      success: true,
      message: `Event status updated to ${status} and registration closed if applicable`,
      data: event,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.updateEvent = async (req, res) => {
  try {
    const { id } = req.params;

    const event = await Event.findById(id);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const updates = { ...req.body };
    if (typeof updates.campConfig === "string") {
      try {
        updates.campConfig = JSON.parse(updates.campConfig);
      } catch (e) {}
    }

    if (updates.title && updates.title.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Title cannot be empty",
      });
    }

    if (updates.category && updates.category.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Category cannot be empty",
      });
    }

    if (updates.maxParticipants && updates.maxParticipants <= 0) {
      return res.status(400).json({
        success: false,
        message: "Max participants must be greater than 0",
      });
    }

    if (updates.startDate && updates.endDate) {
      if (new Date(updates.startDate) > new Date(updates.endDate)) {
        return res.status(400).json({
          success: false,
          message: "Start date cannot be after end date",
        });
      }
    }

    if (updates.registrationDeadline && updates.startDate) {
      if (new Date(updates.registrationDeadline) > new Date(updates.startDate)) {
        return res.status(400).json({
          success: false,
          message: "Registration deadline must be before event start date",
        });
      }
    }

    if (updates.status) {
      const allowedStatus = ["UPCOMING", "ONGOING", "COMPLETED"];
      if (!allowedStatus.includes(updates.status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Allowed: ${allowedStatus.join(", ")}`,
        });
      }
    }

    if (req.file) {
      if (event.bannerImage) {
        const oldImagePath = path.join(__dirname, "..", event.bannerImage);
        if (fs.existsSync(oldImagePath)) {
          fs.unlink(oldImagePath, (err) => {
            if (err) console.log("Error deleting old image:", err);
          });
        }
      }

      updates.bannerImage = `uploads/eventImg/${req.file.filename}`;
    }

    const updatedEvent = await Event.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    res.status(200).json({
      success: true,
      message: "Event updated successfully",
      data: updatedEvent,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


exports.getAllEventsForUser = async (req, res) => {
  try {
    const userId = req.user._id;

    const events = await Event.find({
      status: "UPCOMING",
      isRegistrationOpen: true,
    }).sort({ startDate: 1 });

    const registrations = await EventRegistration.find({
      user: userId,
      status: "REGISTERED",
    }).select("event");

    const registeredEventIds = new Set(
      registrations.map((r) => r.event.toString())
    );

    const updatedEvents = events.map((event) => ({
      ...event._doc,
      isRegistered: registeredEventIds.has(event._id.toString()),
    }));

    res.json({
      success: true,
      data: updatedEvents,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.registerForEvent = async (req, res) => {
  try {
    const { eventId, playerId, selectedSessionIds = [], paymentMethod = "ONLINE" } = req.body;
    const targetPlayerId = playerId || req.body.userId || req.user?._id;

    if (!targetPlayerId) {
      return res.status(400).json({ success: false, message: "Target player ID is required" });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }

    if (event.status !== "UPCOMING") {
      return res.status(400).json({
        success: false,
        message: "Event is not open for registration",
      });
    }

    if (!event.isRegistrationOpen) {
      return res.status(400).json({
        success: false,
        message: "Registration is closed",
      });
    }

    if (
      event.registrationDeadline &&
      new Date() > new Date(event.registrationDeadline)
    ) {
      return res.status(400).json({
        success: false,
        message: "Registration deadline passed",
      });
    }

    const player = await User.findById(targetPlayerId).populate("parentId");
    if (!player) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }

    const isHolidayCamp = (event.eventType || "").toUpperCase() === "CAMP" || 
                          (event.eventType || "").toUpperCase() === "HOLIDAY CAMP" ||
                          (event.category || "").toLowerCase().includes("camp");

    let validatedSessions = [];
    let calculatedTotal = 0;
    let invoiceItems = [];

    if (isHolidayCamp) {
      if (!Array.isArray(selectedSessionIds) || selectedSessionIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Please select at least one camp session for Holiday Camp registration",
        });
      }

      // Fetch authoritative sessions from DB
      const dbSessions = await CampSession.find({
        _id: { $in: selectedSessionIds },
        event: eventId,
        isAvailable: true,
      });

      if (dbSessions.length !== selectedSessionIds.length) {
        return res.status(400).json({
          success: false,
          message: "One or more selected sessions are unavailable or invalid",
        });
      }

      // Check dates within event range and conflicting sessions on the same date
      const dateMap = new Map();
      const eventStart = new Date(event.startDate);
      eventStart.setUTCHours(0, 0, 0, 0);
      const eventEnd = new Date(event.endDate);
      eventEnd.setUTCHours(23, 59, 59, 999);

      for (const s of dbSessions) {
        const sDate = new Date(s.sessionDate);
        if (sDate < eventStart || sDate > eventEnd) {
          return res.status(400).json({
            success: false,
            message: `Session date ${sDate.toISOString().split("T")[0]} is outside the configured camp range`,
          });
        }

        const dateKey = sDate.toISOString().split("T")[0];
        if (dateMap.has(dateKey)) {
          return res.status(400).json({
            success: false,
            message: `Conflicting sessions selected for date ${dateKey}. You can select at most one session per date.`,
          });
        }
        dateMap.set(dateKey, true);

        // Capacity check
        if (s.capacity !== null && s.capacity !== undefined) {
          if (s.registeredCount >= s.capacity) {
            return res.status(400).json({
              success: false,
              message: `Session on ${dateKey} (${s.sessionLabel || s.sessionType}) is fully booked`,
            });
          }
        }

        calculatedTotal += Number(s.fee || 0);

        validatedSessions.push({
          session: s._id,
          sessionDate: s.sessionDate,
          sessionType: s.sessionType,
          fee: Number(s.fee || 0),
          startTime: s.startTime,
          endTime: s.endTime,
        });

        const formattedDateStr = new Date(s.sessionDate).toLocaleDateString("en-US", {
          day: "numeric",
          month: "short",
          year: "numeric",
        });

        invoiceItems.push({
          title: `Holiday Camp: ${formattedDateStr} (${s.sessionLabel || s.sessionType})`,
          description: `Time: ${s.startTime} - ${s.endTime}`,
          amount: Number(s.fee || 0),
        });
      }
    } else {
      // Regular tournament or league
      if (event.totalRegistered >= event.maxParticipants) {
        return res.status(400).json({
          success: false,
          message: "Event is full",
        });
      }
      calculatedTotal = Number(event.registrationFee || 0);
      if (calculatedTotal > 0) {
        invoiceItems.push({
          title: `Event Registration: ${event.title}`,
          description: `Category: ${event.category || "General"}`,
          amount: calculatedTotal,
        });
      }
    }

    let existing = await EventRegistration.findOne({
      user: targetPlayerId,
      event: eventId,
    });

    if (existing && existing.status === "REGISTERED") {
      return res.status(400).json({
        success: false,
        message: "Already registered for this event",
        registration: existing,
      });
    }

    // Determine parent for invoice and registration request
    let parentDocId = player.parentId?._id || player.parentId;
    if (!parentDocId && req.user) {
      const parentUser = await Parent.findOne({ user: req.user._id });
      if (parentUser) parentDocId = parentUser._id;
    }
    if (!parentDocId) {
      let firstParent = await Parent.findOne();
      if (firstParent) parentDocId = firstParent._id;
    }

    // Process category / request
    const processRegistrationRequest = async () => {
      if (player) {
        let reqCategory = player.category || (player.categories && player.categories[0]);

        if (event.category) {
          if (mongoose.Types.ObjectId.isValid(event.category)) {
            reqCategory = event.category;
          } else {
            const matchedCat = await Category.findOne({
              name: new RegExp(`^${event.category}$`, "i"),
            });
            if (matchedCat) reqCategory = matchedCat._id;
          }
        }

        if (reqCategory) {
          player.categories = player.categories || [];
          const catStr = reqCategory.toString();
          if (!player.categories.some((c) => c.toString() === catStr)) {
            player.categories.push(reqCategory);
          }
          if (!player.category) player.category = reqCategory;
        }

        player.hasPendingRequest = true;
        await player.save();

        if (reqCategory && parentDocId) {
          await RegistrationRequest.create({
            parent: parentDocId,
            player: player._id,
            category: reqCategory,
            programs: [],
            requestType: "EVENT_REGISTRATION",
            status: "PENDING",
            createdBy: req.user?._id || parentDocId,
          });
        }
      }
    };

    let invoiceDoc = null;
    if (calculatedTotal > 0 && parentDocId) {
      const invoiceNum = await generateInvoiceNumber();
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 7);

      invoiceDoc = await Invoice.create({
        invoiceNumber: invoiceNum,
        parent: parentDocId,
        players: [player._id],
        items: invoiceItems,
        subtotal: calculatedTotal,
        discount: 0,
        totalAmount: calculatedTotal,
        amount: calculatedTotal,
        dueDate,
        type: isHolidayCamp ? "CAMP_FEE" : "TOURNAMENT_FEE",
        description: `${event.title} Registration`,
        notes: isHolidayCamp ? `Holiday Camp for ${player.fullName || player.firstName}` : "Event Registration",
        paymentMethod: ["ONLINE", "COD"].includes(paymentMethod) ? paymentMethod : "ONLINE",
        paymentStatus: "UNPAID",
        status: "ACTIVE",
        event: event._id,
      });
    }

    let registration;
    if (existing && existing.status === "CANCELLED") {
      existing.status = "REGISTERED";
      existing.selectedSessions = validatedSessions;
      existing.totalAmount = calculatedTotal;
      existing.paymentStatus = calculatedTotal === 0 ? "PAID" : "UNPAID";
      if (invoiceDoc) existing.invoice = invoiceDoc._id;
      await existing.save();
      registration = existing;
    } else {
      registration = await EventRegistration.create({
        user: targetPlayerId,
        event: eventId,
        status: "REGISTERED",
        selectedSessions: validatedSessions,
        totalAmount: calculatedTotal,
        paymentStatus: calculatedTotal === 0 ? "PAID" : "UNPAID",
        invoice: invoiceDoc ? invoiceDoc._id : undefined,
      });
    }

    if (invoiceDoc) {
      invoiceDoc.eventRegistration = registration._id;
      await invoiceDoc.save();
    }

    // Increment counts
    await Event.findByIdAndUpdate(eventId, {
      $inc: { totalRegistered: 1 },
    });

    if (isHolidayCamp && selectedSessionIds.length > 0) {
      await CampSession.updateMany(
        { _id: { $in: selectedSessionIds } },
        { $inc: { registeredCount: 1 } }
      );
    }

    await processRegistrationRequest();

    res.json({
      success: true,
      message: "Registered successfully",
      data: {
        registration,
        invoice: invoiceDoc,
        totalAmount: calculatedTotal,
        selectedSessions: validatedSessions,
      },
    });

  } catch (error) {
    console.error("registerForEvent error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.cancelRegistration = async (req, res) => {
  try {
    const userId = req.user._id;
    const { eventId } = req.body;

    const registration = await EventRegistration.findOne({
      user: userId,
      event: eventId,
      status: "REGISTERED",
    });

    if (!registration) {
      return res.status(404).json({
        message: "Active registration not found",
      });
    }

    registration.status = "CANCELLED";
    await registration.save();

    await Event.findOneAndUpdate(
      { _id: eventId, totalRegistered: { $gt: 0 } },
      { $inc: { totalRegistered: -1 } }
    );

    res.json({
      success: true,
      message: "Registration cancelled",
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getMyEvents = async (req, res) => {
  try {
    const userId = req.user._id;

    const events = await EventRegistration.find({
      user: userId,
      status: "REGISTERED",
    }).populate("event");

    res.json({
      success: true,
      data: events,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getEventDetails = async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user?._id;

    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    const totalSlots = event.maxParticipants || 0;
    const registered = event.totalRegistered || 0;
    const availableSlots = totalSlots - registered;

    let userRegistrationStatus = "NOT_REGISTERED";
    let userRegistration = null;

    if (userId) {
      const registration = await EventRegistration.findOne({
        user: userId,
        event: eventId,
      }).populate("invoice");

      if (registration) {
        userRegistrationStatus = registration.status;
        userRegistration = registration;
      }
    }

    // Fetch camp sessions if Holiday Camp
    const campSessions = await CampSession.find({ event: eventId }).sort({ sessionDate: 1, sessionType: 1 });

    res.json({
      success: true,
      data: {
        ...event._doc,

        stats: {
          totalSlots,
          registered,
          availableSlots,
        },

        userRegistrationStatus,
        userRegistration,
        campSessions,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getEventDetailsAdmin = async (req, res) => {
  try {
    const { eventId } = req.params;

    const event = await Event.findById(eventId).populate(
      "createdBy",
      "fullName email"
    );

    if (!event) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    const totalRegistered = await EventRegistration.countDocuments({
      event: eventId,
      status: "REGISTERED",
    });

    const totalCancelled = await EventRegistration.countDocuments({
      event: eventId,
      status: "CANCELLED",
    });

    const totalParticipants = await EventRegistration.countDocuments({
      event: eventId,
    });

    const totalSlots = event.maxParticipants || 0;
    const availableSlots = totalSlots - totalRegistered;

    const campSessions = await CampSession.find({ event: eventId }).sort({ sessionDate: 1, sessionType: 1 });

    res.json({
      success: true,
      data: {
        ...event._doc,

        stats: {
          totalSlots,
          registered: totalRegistered,
          cancelled: totalCancelled,
          totalParticipants,
          availableSlots,
        },
        campSessions,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getEventParticipants = async (req, res) => {
  try {
    const { eventId } = req.params;
    let { page = 1, limit = 10, search = "", exportCsv } = req.query;

    const pageNumber = parseInt(page);
    const limitNumber = parseInt(limit);
    const skip = (pageNumber - 1) * limitNumber;

    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    const pipeline = [
      {
        $match: {
          event: new mongoose.Types.ObjectId(eventId),
          status: "REGISTERED",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
    ];

    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { "user.fullName": { $regex: search, $options: "i" } },
            { "user.email": { $regex: search, $options: "i" } },
            { "user.phone": { $regex: search, $options: "i" } },
          ],
        },
      });
    }

    const totalData = await EventRegistration.aggregate([
      ...pipeline,
      { $count: "total" },
    ]);

    const total = totalData[0]?.total || 0;

    if (exportCsv === "true") {
      const data = await EventRegistration.aggregate(pipeline);

      const csv = [
        ["Name", "Email", "Phone", "Skill Level"],
        ...data.map((d) => [
          d.user.fullName,
          d.user.email,
          d.user.phone,
          d.user.skillLevel,
        ]),
      ]
        .map((row) => row.join(","))
        .join("\n");

      res.header("Content-Type", "text/csv");
      res.attachment("participants.csv");

      return res.send(csv);
    }

    pipeline.push({ $sort: { createdAt: -1 } });
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNumber });

    const participants = await EventRegistration.aggregate(pipeline);

    const stats = {
      totalSlots: event.maxParticipants,
      registered: event.totalRegistered,
      availableSlots: event.maxParticipants - event.totalRegistered,
    };

    res.json({
      success: true,
      page: pageNumber,
      limit: limitNumber,
      total,
      stats,
      data: participants,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.exportEventParticipants = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { format = "csv" } = req.body;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    const data = await EventRegistration.aggregate([
      {
        $match: {
          event: new mongoose.Types.ObjectId(eventId),
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $sort: { createdAt: -1 },
      },
    ]);

    if (!data.length) {
      return res.status(404).json({ message: "No participants found" });
    }

    const formatted = data.map((d) => ({
      // 🔹 Event Info
      EventTitle: event.title,
      EventCategory: event.category,
      EventStartDate: event.startDate
        ? new Date(event.startDate).toLocaleDateString()
        : "",
      EventVenue: event.venueName || "",

      Name: d.user.fullName || "",
      Email: d.user.email || "",
      Phone: d.user.phone || "",
      Status: d.user.status || "",
      ProgramType: d.user.programType || "",
      SkillLevel: d.user.skillLevel || "",
      PreferredFoot: d.user.preferredFoot || "",
      Club: d.user.club || "",
      DOB: d.user.dob
        ? new Date(d.user.dob).toLocaleDateString()
        : "",
      ContactName: d.user.contactName || "",
      MedicalCondition: d.user.medicalCondition || "",
      Comments: d.user.comments || "",

      RegistrationStatus: d.status,
      RegisteredAt: new Date(d.createdAt).toLocaleString(),
    }));

    // ================= CSV =================
    if (format === "csv") {
      const csv = [
        Object.keys(formatted[0]).join(","),
        ...formatted.map((row) =>
          Object.values(row)
            .map((val) => `"${val}"`)
            .join(",")
        ),
      ].join("\n");

      res.header("Content-Type", "text/csv");
      res.attachment("event-participants.csv");
      return res.send(csv);
    }

    // ================= EXCEL =================
    if (format === "excel") {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Participants");

      worksheet.columns = Object.keys(formatted[0]).map((key) => ({
        header: key,
        key: key,
        width: 25,
      }));

      formatted.forEach((row) => {
        worksheet.addRow(row);
      });

      // header bold
      worksheet.getRow(1).font = { bold: true };

      res.header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.attachment("event-participants.xlsx");

      await workbook.xlsx.write(res);
      return res.end();
    }

    return res.status(400).json({
      message: "Invalid format (csv/excel)",
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ==========================================
// HOLIDAY CAMP SPECIFIC CONTROLLERS
// ==========================================

/**
 * Configure / bulk update camp sessions for an event
 */
exports.configureCampSessions = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { sessions = [], campConfig } = req.body;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }

    if (campConfig) {
      event.campConfig = { ...event.campConfig, ...campConfig };
      await event.save();
    }

    if (Array.isArray(sessions)) {
      // Find sessions with existing registrations to protect them
      const existingSessionsWithRegistrations = await EventRegistration.find({
        event: eventId,
        status: "REGISTERED",
      }).select("selectedSessions.session");

      const registeredSessionIds = new Set();
      existingSessionsWithRegistrations.forEach((reg) => {
        (reg.selectedSessions || []).forEach((s) => {
          if (s.session) registeredSessionIds.add(s.session.toString());
        });
      });

      for (const s of sessions) {
        if (s._id && mongoose.Types.ObjectId.isValid(s._id)) {
          // Update existing session
          await CampSession.findByIdAndUpdate(s._id, {
            sessionType: s.sessionType,
            sessionLabel: s.sessionLabel || (s.sessionType === "HALF_DAY" ? "Half Day" : "Full Day"),
            startTime: s.startTime,
            endTime: s.endTime,
            fee: Number(s.fee !== undefined ? s.fee : (s.sessionType === "HALF_DAY" ? 70 : 90)),
            capacity: s.capacity !== undefined && s.capacity !== null && s.capacity !== "" ? Number(s.capacity) : null,
            isAvailable: s.isAvailable !== false,
          });
        } else if (s.sessionDate && s.sessionType) {
          // Check if session exists for this date and type
          const date = new Date(s.sessionDate);
          date.setUTCHours(0, 0, 0, 0);

          let existingSession = await CampSession.findOne({
            event: eventId,
            sessionDate: date,
            sessionType: s.sessionType,
          });

          if (existingSession) {
            existingSession.sessionLabel = s.sessionLabel || (s.sessionType === "HALF_DAY" ? "Half Day" : "Full Day");
            existingSession.startTime = s.startTime || existingSession.startTime;
            existingSession.endTime = s.endTime || existingSession.endTime;
            existingSession.fee = Number(s.fee !== undefined ? s.fee : existingSession.fee);
            existingSession.capacity = s.capacity !== undefined && s.capacity !== null && s.capacity !== "" ? Number(s.capacity) : existingSession.capacity;
            existingSession.isAvailable = s.isAvailable !== false;
            await existingSession.save();
          } else {
            await CampSession.create({
              event: eventId,
              sessionDate: date,
              sessionType: s.sessionType,
              sessionLabel: s.sessionLabel || (s.sessionType === "HALF_DAY" ? "Half Day" : "Full Day"),
              startTime: s.startTime || (s.sessionType === "HALF_DAY" ? "08:00 AM" : "08:00 AM"),
              endTime: s.endTime || (s.sessionType === "HALF_DAY" ? "02:00 PM" : "04:00 PM"),
              fee: Number(s.fee !== undefined ? s.fee : (s.sessionType === "HALF_DAY" ? 70 : 90)),
              capacity: s.capacity !== undefined && s.capacity !== null && s.capacity !== "" ? Number(s.capacity) : null,
              isAvailable: s.isAvailable !== false,
            });
          }
        }
      }
    }

    const updatedSessions = await CampSession.find({ event: eventId }).sort({ sessionDate: 1, sessionType: 1 });

    res.json({
      success: true,
      message: "Camp sessions updated successfully",
      data: updatedSessions,
    });
  } catch (error) {
    console.error("configureCampSessions error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Toggle date availability (enable/disable all sessions for that date)
 */
exports.toggleCampDateAvailability = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { date, isAvailable } = req.body;

    if (!date) {
      return res.status(400).json({ success: false, message: "Date is required" });
    }

    const targetDate = new Date(date);
    targetDate.setUTCHours(0, 0, 0, 0);

    const nextDate = new Date(targetDate);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);

    await CampSession.updateMany(
      {
        event: eventId,
        sessionDate: { $gte: targetDate, $lt: nextDate },
      },
      { isAvailable: Boolean(isAvailable) }
    );

    const updatedSessions = await CampSession.find({ event: eventId }).sort({ sessionDate: 1, sessionType: 1 });

    res.json({
      success: true,
      message: `Date ${targetDate.toISOString().split("T")[0]} set to ${isAvailable ? "available" : "unavailable"}`,
      data: updatedSessions,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get full attendance grid for an event (matching the screenshot)
 * Columns: Configured camp dates & sessions
 * Rows: Registered players
 * Attendance states: PRESENT, ABSENT, NOT_MARKED (with visual indication of Full Day vs Half Day)
 */
exports.getEventAttendanceGrid = async (req, res) => {
  try {
    const { eventId } = req.params;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }

    // 1. Fetch all configured camp sessions
    const sessions = await CampSession.find({ event: eventId }).sort({ sessionDate: 1, sessionType: 1 });

    // 2. Fetch all registered players for this event
    const registrations = await EventRegistration.find({
      event: eventId,
      status: "REGISTERED",
    })
      .populate({
        path: "user",
        select: "fullName email phone dob profileImage category skillLevel prefferedFoot contactName",
      })
      .populate("invoice")
      .sort({ createdAt: 1 });

    // 3. Fetch attendance records for this event
    const attendanceRecords = await Attendance.find({
      event: eventId,
    }).select("sessionDate campSession records");

    // Build fast lookup for attendance: key = `${sessionDateISO}_${campSessionId || 'all'}_${playerId}`
    const attendanceMap = {};
    attendanceRecords.forEach((att) => {
      const dateStr = new Date(att.sessionDate).toISOString().split("T")[0];
      const campSessId = att.campSession ? att.campSession.toString() : "all";

      att.records.forEach((rec) => {
        const pId = rec.player.toString();
        const recObj = {
          status: rec.status,
          reason: rec.reason || rec.remarks || "",
          comment: rec.comment || "",
          markedByParent: rec.markedByParent || false,
        };
        attendanceMap[`${dateStr}_${campSessId}_${pId}`] = recObj;
        attendanceMap[`${dateStr}_any_${pId}`] = recObj;
      });
    });

    // 4. Map each player with their registration sessions and attendance status
    const players = registrations.map((reg, index) => {
      const player = reg.user;
      if (!player) return null;

      const playerSelectedSessions = reg.selectedSessions || [];
      const sessionSelectionMap = {}; // key = dateStr => session info

      playerSelectedSessions.forEach((s) => {
        if (s.sessionDate) {
          const dStr = new Date(s.sessionDate).toISOString().split("T")[0];
          sessionSelectionMap[dStr] = {
            sessionId: s.session ? s.session.toString() : null,
            sessionType: s.sessionType,
            fee: s.fee,
            startTime: s.startTime,
            endTime: s.endTime,
          };
        }
      });

      // Attendance map for this player across all sessions/dates
      const attendance = {};
      sessions.forEach((sess) => {
        const dStr = new Date(sess.sessionDate).toISOString().split("T")[0];
        const isRegisteredForSession = playerSelectedSessions.some(
          (pss) => pss.session && pss.session.toString() === sess._id.toString()
        ) || (playerSelectedSessions.length === 0); // If no session array, registered for event

        const sessId = sess._id.toString();
        const recData = attendanceMap[`${dStr}_${sessId}_${player._id}`] ||
                        attendanceMap[`${dStr}_any_${player._id}`];
        const status = recData ? recData.status : (isRegisteredForSession ? "NOT_MARKED" : "NOT_REGISTERED");
        const reason = recData ? recData.reason : "";
        const markedByParent = recData ? recData.markedByParent : false;

        attendance[sessId] = {
          date: dStr,
          sessionId: sessId,
          sessionType: sess.sessionType,
          isRegistered: isRegisteredForSession,
          status,
          reason,
          markedByParent,
        };
      });

      return {
        rowNumber: index + 1,
        registrationId: reg._id,
        playerId: player._id,
        name: player.fullName,
        email: player.email,
        phone: player.phone,
        dob: player.dob,
        profileImage: player.profileImage,
        contactName: player.contactName,
        paymentStatus: reg.paymentStatus || (reg.invoice ? reg.invoice.paymentStatus : "UNPAID"),
        totalAmount: reg.totalAmount || 0,
        registeredSessionsCount: playerSelectedSessions.length,
        selectedSessions: playerSelectedSessions,
        attendance,
      };
    }).filter(Boolean);

    // Summary counts per date/session
    const sessionSummaries = sessions.map((sess) => {
      const sessId = sess._id.toString();
      const dStr = new Date(sess.sessionDate).toISOString().split("T")[0];

      let registeredCount = 0;
      let presentCount = 0;
      let absentCount = 0;

      players.forEach((p) => {
        const att = p.attendance[sessId];
        if (att && att.isRegistered) {
          registeredCount++;
          if (att.status === "PRESENT" || att.status === "LATE") presentCount++;
          if (att.status === "ABSENT") absentCount++;
        }
      });

      return {
        sessionId: sessId,
        date: dStr,
        dayOfWeek: new Date(sess.sessionDate).toLocaleDateString("en-US", { weekday: "short" }),
        sessionType: sess.sessionType,
        sessionLabel: sess.sessionLabel || (sess.sessionType === "HALF_DAY" ? "Half Day" : "Full Day"),
        startTime: sess.startTime,
        endTime: sess.endTime,
        fee: sess.fee,
        isAvailable: sess.isAvailable,
        registeredCount,
        presentCount,
        absentCount,
      };
    });

    res.json({
      success: true,
      data: {
        event: {
          _id: event._id,
          title: event.title,
          category: event.category,
          eventType: event.eventType,
          startDate: event.startDate,
          endDate: event.endDate,
          venueName: event.venueName,
          address: event.address,
          status: event.status,
          totalRegistered: registrations.length,
        },
        sessions,
        sessionSummaries,
        players,
      },
    });
  } catch (error) {
    console.error("getEventAttendanceGrid error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Mark single attendance for a player in a camp session or event date
 * Matches regular class markSingleAttendance architecture
 */
exports.markEventSingleAttendance = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { sessionDate, campSessionId, playerId, status, reason, remarks, comment } = req.body;

    if (!sessionDate || !playerId || !status) {
      return res.status(400).json({
        success: false,
        message: "sessionDate, playerId and status are required",
      });
    }

    const date = new Date(sessionDate);
    date.setUTCHours(0, 0, 0, 0);

    const query = {
      event: eventId,
      sessionDate: date,
    };
    if (campSessionId && mongoose.Types.ObjectId.isValid(campSessionId)) {
      query.campSession = campSessionId;
    }

    let attendance = await Attendance.findOne(query);

    if (!attendance) {
      attendance = await Attendance.create({
        event: eventId,
        campSession: campSessionId && mongoose.Types.ObjectId.isValid(campSessionId) ? campSessionId : undefined,
        sessionDate: date,
        records: [],
        markedBy: req.user?._id || req.admin?._id,
      });
    }

    const existingRecord = attendance.records.find(
      (r) => r.player.toString() === playerId
    );

    const trimmedReason = reason !== undefined ? String(reason).trim() : (remarks !== undefined ? String(remarks).trim() : undefined);

    if (existingRecord) {
      existingRecord.status = status;
      if (trimmedReason !== undefined) {
        existingRecord.reason = trimmedReason;
        existingRecord.remarks = trimmedReason;
      }
      if (comment !== undefined) existingRecord.comment = comment;
      if (status === "LATE") existingRecord.lateArrival = true;
    } else {
      attendance.records.push({
        player: playerId,
        status,
        reason: trimmedReason || "",
        remarks: trimmedReason || "",
        comment: comment || "",
        lateArrival: status === "LATE",
        attendanceType: "REGULAR",
      });
    }

    attendance.markedBy = req.user?._id || req.admin?._id;
    await attendance.save();

    res.json({
      success: true,
      message: "Attendance updated successfully",
      data: {
        eventId,
        campSessionId,
        sessionDate: date,
        playerId,
        status,
        reason: trimmedReason,
      },
    });
  } catch (error) {
    console.error("markEventSingleAttendance error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Bulk mark attendance for an entire session
 */
exports.markEventBulkAttendance = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { sessionDate, campSessionId, records } = req.body;

    if (!sessionDate || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({
        success: false,
        message: "sessionDate and records are required",
      });
    }

    const date = new Date(sessionDate);
    date.setUTCHours(0, 0, 0, 0);

    const query = {
      event: eventId,
      sessionDate: date,
    };
    if (campSessionId && mongoose.Types.ObjectId.isValid(campSessionId)) {
      query.campSession = campSessionId;
    }

    let attendance = await Attendance.findOne(query);

    if (attendance) {
      attendance.records = records.map((r) => ({
        player: r.player || r.playerId,
        status: r.status,
        attendanceType: r.attendanceType || "REGULAR",
      }));
      attendance.markedBy = req.user?._id || req.admin?._id;
      await attendance.save();
    } else {
      attendance = await Attendance.create({
        event: eventId,
        campSession: campSessionId && mongoose.Types.ObjectId.isValid(campSessionId) ? campSessionId : undefined,
        sessionDate: date,
        records: records.map((r) => ({
          player: r.player || r.playerId,
          status: r.status,
          attendanceType: r.attendanceType || "REGULAR",
        })),
        markedBy: req.user?._id || req.admin?._id,
      });
    }

    res.json({
      success: true,
      message: "Bulk attendance marked successfully",
      data: attendance,
    });
  } catch (error) {
    console.error("markEventBulkAttendance error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get registration details for a specific player registration
 */
exports.getEventRegistrationDetails = async (req, res) => {
  try {
    const { registrationId } = req.params;

    const registration = await EventRegistration.findById(registrationId)
      .populate("user")
      .populate("event")
      .populate("invoice")
      .populate("selectedSessions.session");

    if (!registration) {
      return res.status(404).json({ success: false, message: "Registration not found" });
    }

    // Also get player attendance history for this event
    const attendanceRecords = await Attendance.find({
      event: registration.event?._id,
      "records.player": registration.user?._id,
    });

    const attendanceHistory = attendanceRecords.map((att) => {
      const rec = att.records.find((r) => r.player.toString() === registration.user?._id.toString());
      return {
        sessionDate: att.sessionDate,
        campSession: att.campSession,
        status: rec ? rec.status : "NOT_MARKED",
      };
    });

    res.json({
      success: true,
      data: {
        registration,
        attendanceHistory,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateEventRegistrationPaymentStatus = async (req, res) => {
  try {
    const { registrationId } = req.params;
    const { paymentStatus, eventId, playerId } = req.body;

    if (!paymentStatus) {
      return res.status(400).json({ success: false, message: "paymentStatus is required" });
    }

    let registration;
    if (registrationId && registrationId !== "undefined" && mongoose.Types.ObjectId.isValid(registrationId)) {
      registration = await EventRegistration.findById(registrationId);
    }
    if (!registration && eventId && playerId) {
      registration = await EventRegistration.findOne({ event: eventId, user: playerId });
    }

    if (!registration) {
      return res.status(404).json({ success: false, message: "Registration not found" });
    }

    registration.paymentStatus = paymentStatus;
    await registration.save();

    if (registration.invoice) {
      const invoiceStatus = paymentStatus === "PAID" ? "PAID" : "UNPAID";
      await Invoice.findByIdAndUpdate(registration.invoice, {
        paymentStatus: invoiceStatus,
      });
    }

    res.json({
      success: true,
      message: `Camp payment status updated to ${paymentStatus}`,
      data: registration,
    });
  } catch (error) {
    console.error("updateEventRegistrationPaymentStatus error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};