const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const User = require("../models/User");
const Category = require("../models/Category");
const RegistrationRequest = require("../models/RegistrationRequest");
const CampSession = require("../models/CampSession");
const Attendance = require("../models/Attendance");
const Invoice = require("../models/Invoice");
const Parent = require("../models/Parent");
const Term = require("../models/Term");
const { generateInvoiceNumber } = require("./invoiceController");
const { activateAssignedPlayers } = require("../services/activateAssignedPlayers");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const {
  DEFAULT_TIMEZONE,
  dateOnly,
  isDateOnly,
  dateOnlyToUtc,
  dateOnlyStartUtc,
  dateOnlyEndUtc,
  addDateOnlyDays,
  formatDateOnly,
  formatTimestamp,
  weekdayShort,
  serializeCampSession,
  serializeSelectedSession,
  serializeEvent,
  serializeRegistration,
} = require("../utils/dateTime");
const {
  normalizePaymentStatus,
  paymentStatusRankExpression,
} = require("../utils/paymentStatus");

/**
 * Resolve which players are allowed to receive attendance for a particular
 * event calendar date/session. Holiday Camp registrations may contain a
 * selectedSessions array; a player is eligible only when that array contains
 * the requested session (or date), while legacy/non-camp registrations with
 * no selected sessions remain eligible for the event date.
 */
async function resolveEventAttendanceScope({ eventId, dateKey, campSessionId }) {
  const event = await Event.findById(eventId).select("_id");
  if (!event) {
    const error = new Error("Event not found");
    error.statusCode = 404;
    throw error;
  }

  let session = null;
  if (campSessionId) {
    if (!mongoose.Types.ObjectId.isValid(campSessionId)) {
      const error = new Error("Invalid camp session ID");
      error.statusCode = 400;
      throw error;
    }
    session = await CampSession.findOne({ _id: campSessionId, event: eventId });
    if (!session) {
      const error = new Error("Camp session not found for this event");
      error.statusCode = 404;
      throw error;
    }
    if (dateOnly(session.sessionDate, "campSession.sessionDate") !== dateKey) {
      const error = new Error("Camp session does not match the requested date");
      error.statusCode = 400;
      throw error;
    }
  }

  const registrations = await EventRegistration.find({
    event: eventId,
    status: "REGISTERED",
  }).select("user selectedSessions");

  const eligiblePlayerIds = new Set();
  registrations.forEach((registration) => {
    const selected = Array.isArray(registration.selectedSessions)
      ? registration.selectedSessions
      : [];

    // Empty selectedSessions is the legacy regular-event shape: the player
    // is registered for the event as a whole.
    const eligible = selected.length === 0
      ? true
      : selected.some((item) => {
        if (campSessionId && item.session && item.session.toString() === campSessionId.toString()) {
          return true;
        }
        if (!campSessionId && item.sessionDate) {
          try {
            return dateOnly(item.sessionDate, "selectedSession.sessionDate") === dateKey;
          } catch {
            return false;
          }
        }
        return false;
      });

    if (eligible && registration.user) {
      eligiblePlayerIds.add(registration.user.toString());
    }
  });

  return { session, registrations, eligiblePlayerIds };
}

function eventErrorStatus(error) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : 500;
}

async function resolveEventTermId({ requestedTermId, startDate, endDate, eventType }) {
  if (requestedTermId) {
    if (!mongoose.Types.ObjectId.isValid(requestedTermId)) {
      const error = new Error("termId must be a valid term id");
      error.statusCode = 400;
      throw error;
    }
    return requestedTermId;
  }
  if (!startDate || !endDate) return null;
  const start = dateOnlyStartUtc(startDate, "startDate");
  const end = dateOnlyEndUtc(endDate, "endDate");
  const isCamp = ["CAMP", "HOLIDAY CAMP"].includes(String(eventType || "").toUpperCase());
  const matchingTerm = await Term.findOne({
    startDate: { $lte: start },
    endDate: { $gte: end },
    ...(isCamp ? { isEvent: true } : {}),
  }).sort({ startDate: -1 }).select("_id").lean();
  return matchingTerm?._id || null;
}

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

    // Event ranges and camp sessions are calendar dates. Normalize them to a
    // deterministic UTC value; responses expose YYYY-MM-DD via serializeEvent.
    if (bodyData.startDate) bodyData.startDate = dateOnlyToUtc(bodyData.startDate, "startDate");
    if (bodyData.endDate) bodyData.endDate = dateOnlyToUtc(bodyData.endDate, "endDate");
    if (isDateOnly(bodyData.registrationDeadline)) {
      bodyData.registrationDeadline = dateOnlyToUtc(bodyData.registrationDeadline, "registrationDeadline");
    }
    if (bodyData.termId === "") delete bodyData.termId;
    bodyData.termId = await resolveEventTermId({
      requestedTermId: bodyData.termId,
      startDate: bodyData.startDate,
      endDate: bodyData.endDate,
      eventType: bodyData.eventType,
    });

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
        sessionDate: dateOnlyToUtc(s.sessionDate, "sessionDate"),
        sessionType: s.sessionType || "FULL_DAY",
        sessionLabel: s.sessionLabel || (s.sessionType === "HALF_DAY" ? "Half Day" : "Full Day"),
        dayNote: s.dayNote !== undefined ? String(s.dayNote).trim() : "",
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
      data: serializeEvent(event),
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
    const todayParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: DEFAULT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const today = `${todayParts.find((part) => part.type === "year")?.value}-${todayParts.find((part) => part.type === "month")?.value}-${todayParts.find((part) => part.type === "day")?.value}`;

    // Keep persisted statuses aligned with the event's Australia calendar dates.
    await Event.updateMany(
      { isArchived: { $ne: true }, endDate: { $lt: dateOnlyStartUtc(today) }, status: { $ne: "COMPLETED" } },
      { $set: { status: "COMPLETED", isRegistrationOpen: false } }
    );
    await Event.updateMany(
      {
        isArchived: { $ne: true },
        status: "UPCOMING",
        startDate: { $lte: dateOnlyEndUtc(today) },
        endDate: { $gte: dateOnlyStartUtc(today) },
      },
      { $set: { status: "ONGOING" } }
    );

    const events = await Event.find({ isArchived: { $ne: true } })
      .sort({ createdAt: -1 })
      .populate("createdBy", "name email")
      .populate("termId", "name year startDate endDate status isEvent");

    const updatedEvents = events.map((event) => {
      const totalSlots = event.maxParticipants || 0;
      const registered = event.totalRegistered || 0;
      const availableSlots = totalSlots - registered;

      return {
        ...serializeEvent(event),
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

/** Archive an event while preserving its registrations, attendance, invoices, and chat history. */
exports.deleteEvent = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "A valid event ID is required" });
    }

    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ success: false, message: "Event not found" });
    if (event.isArchived) return res.json({ success: true, message: "Event is already archived" });

    await EventRegistration.updateMany(
      { event: id, status: { $in: ["REGISTERED", "PENDING"] } },
      { $set: { status: "CANCELLED" } }
    );
    await CampSession.updateMany(
      { event: id },
      { $set: { registeredCount: 0, isAvailable: false } }
    );
    // Keep paid transactions as historical records; cancel unpaid invoices so
    // removing an event does not leave new payment obligations behind.
    await Invoice.updateMany(
      { event: id, paymentStatus: { $in: ["UNPAID", "PAYMENT_PENDING"] } },
      { $set: { status: "CANCELLED", paymentStatus: "CANCELLED" } }
    );

    event.isArchived = true;
    event.isRegistrationOpen = false;
    event.status = "COMPLETED";
    event.totalRegistered = 0;
    await event.save();

    return res.json({
      success: true,
      message: "Event archived. Active registrations were cancelled and payment, attendance, and chat history were preserved.",
      data: serializeEvent(event),
    });
  } catch (error) {
    console.error("deleteEvent error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** Remove one active registration from an event without deleting its audit history. */
exports.removeEventRegistration = async (req, res) => {
  try {
    const { registrationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(registrationId)) {
      return res.status(400).json({ success: false, message: "A valid registration ID is required" });
    }

    const registration = await EventRegistration.findById(registrationId).populate("invoice");
    if (!registration) return res.status(404).json({ success: false, message: "Registration not found" });
    if (registration.status !== "REGISTERED") {
      return res.status(409).json({ success: false, message: "This player is no longer registered for the event" });
    }

    registration.status = "CANCELLED";
    await registration.save();

    const activeCount = await EventRegistration.countDocuments({ event: registration.event, status: "REGISTERED" });
    await Event.updateOne({ _id: registration.event }, { $set: { totalRegistered: activeCount } });

    const sessionIds = [...new Set((registration.selectedSessions || [])
      .map((selected) => selected.session?.toString())
      .filter(Boolean))];
    for (const sessionId of sessionIds) {
      const registeredCount = await EventRegistration.countDocuments({
        event: registration.event,
        status: "REGISTERED",
        "selectedSessions.session": sessionId,
      });
      await CampSession.updateOne({ _id: sessionId }, { $set: { registeredCount } });
    }

    if (registration.invoice) {
      const invoiceUpdate = { status: "CANCELLED" };
      if (["UNPAID", "PAYMENT_PENDING"].includes(registration.invoice.paymentStatus)) {
        invoiceUpdate.paymentStatus = "CANCELLED";
      }
      await Invoice.updateOne({ _id: registration.invoice._id }, { $set: invoiceUpdate });
    }

    return res.json({
      success: true,
      message: "Player removed from this event. Attendance and payment history are retained.",
      data: { registrationId: registration._id, status: registration.status },
    });
  } catch (error) {
    console.error("removeEventRegistration error:", error);
    return res.status(500).json({ success: false, message: error.message });
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
    if (!event || event.isArchived) {
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
      data: serializeEvent(event),
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
    if (!event || event.isArchived) {
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

    if (updates.startDate) updates.startDate = dateOnlyToUtc(updates.startDate, "startDate");
    if (updates.endDate) updates.endDate = dateOnlyToUtc(updates.endDate, "endDate");
    if (isDateOnly(updates.registrationDeadline)) {
      updates.registrationDeadline = dateOnlyToUtc(updates.registrationDeadline, "registrationDeadline");
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
      if (dateOnly(updates.startDate, "startDate") > dateOnly(updates.endDate, "endDate")) {
        return res.status(400).json({
          success: false,
          message: "Start date cannot be after end date",
        });
      }
    }

    if (updates.registrationDeadline && updates.startDate) {
      const deadline = new Date(updates.registrationDeadline);
      const startDate = dateOnlyStartUtc(updates.startDate, "startDate");
      if (!Number.isNaN(deadline.getTime()) && deadline > startDate) {
        return res.status(400).json({
          success: false,
          message: "Registration deadline must be before event start date",
        });
      }
    }

    if (updates.termId === "") delete updates.termId;
    if (updates.termId !== undefined || updates.startDate || updates.endDate || updates.eventType) {
      updates.termId = await resolveEventTermId({
        requestedTermId: updates.termId !== undefined ? updates.termId : event.termId,
        startDate: updates.startDate || event.startDate,
        endDate: updates.endDate || event.endDate,
        eventType: updates.eventType || event.eventType,
      });
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
      data: serializeEvent(updatedEvent),
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
      isArchived: { $ne: true },
    }).sort({ startDate: 1 });

    const registrations = await EventRegistration.find({
      user: userId,
      status: "REGISTERED",
    }).select("event");

    const registeredEventIds = new Set(
      registrations.map((r) => r.event.toString())
    );

    const updatedEvents = events.map((event) => ({
      ...serializeEvent(event),
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

    const event = await Event.findById(eventId).populate("termId", "name year startDate endDate status isEvent");
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
      const eventStart = dateOnly(event.startDate, "event.startDate");
      const eventEnd = dateOnly(event.endDate, "event.endDate");

      for (const s of dbSessions) {
        const dateKey = dateOnly(s.sessionDate, "sessionDate");
        if (dateKey < eventStart || dateKey > eventEnd) {
          return res.status(400).json({
            success: false,
            message: `Session date ${formatDateOnly(dateKey)} is outside the configured camp range`,
          });
        }

        if (dateMap.has(dateKey)) {
          return res.status(400).json({
            success: false,
            message: `Conflicting sessions selected for date ${formatDateOnly(dateKey)}. You can select at most one session per date.`,
          });
        }
        dateMap.set(dateKey, true);

        // Capacity check
        if (s.capacity !== null && s.capacity !== undefined) {
          if (s.registeredCount >= s.capacity) {
            return res.status(400).json({
              success: false,
              message: `Session on ${formatDateOnly(dateKey)} (${s.sessionLabel || s.sessionType}) is fully booked`,
            });
          }
        }

        calculatedTotal += Number(s.fee || 0);

        validatedSessions.push({
          session: s._id,
          sessionDate: dateOnlyToUtc(dateKey, "sessionDate"),
          sessionType: s.sessionType,
          fee: Number(s.fee || 0),
          startTime: s.startTime,
          endTime: s.endTime,
        });

        const formattedDateStr = formatDateOnly(dateKey);

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
        await activateAssignedPlayers([player._id]);
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
        registration: serializeRegistration(registration),
        invoice: invoiceDoc,
        totalAmount: calculatedTotal,
        selectedSessions: validatedSessions.map(serializeSelectedSession),
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
      data: events.map(serializeRegistration),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getEventDetails = async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user?._id;

    const event = await Event.findById(eventId)
      .populate("termId", "name year startDate endDate status isEvent");

    if (!event || event.isArchived) {
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
        ...serializeEvent(event),

        stats: {
          totalSlots,
          registered,
          availableSlots,
        },

        userRegistrationStatus,
        userRegistration,
        campSessions: campSessions.map(serializeCampSession),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getEventDetailsAdmin = async (req, res) => {
  try {
    const { eventId } = req.params;

    const event = await Event.findById(eventId)
      .populate("createdBy", "fullName email")
      .populate("termId", "name year startDate endDate status isEvent");

    if (!event || event.isArchived) {
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
        ...serializeEvent(event),

        stats: {
          totalSlots,
          registered: totalRegistered,
          cancelled: totalCancelled,
          totalParticipants,
          availableSlots,
        },
        campSessions: campSessions.map(serializeCampSession),
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

    if (!event || event.isArchived) {
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

    pipeline.push({
      $addFields: {
        _paymentStatusNormalized: {
          $toUpper: {
            $trim: { input: { $ifNull: ["$paymentStatus", "UNPAID"] } },
          },
        },
      },
    });
    pipeline.push({
      $addFields: {
        _paymentStatusRank: paymentStatusRankExpression("$_paymentStatusNormalized"),
      },
    });
    pipeline.push({
      $sort: {
        _paymentStatusRank: 1,
        "user.fullName": 1,
        "user.firstName": 1,
        createdAt: -1,
        _id: 1,
      },
    });
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNumber });

    const participants = await EventRegistration.aggregate(pipeline);
    participants.forEach((participant) => {
      participant.paymentStatus = normalizePaymentStatus(participant.paymentStatus);
      delete participant._paymentStatusNormalized;
      delete participant._paymentStatusRank;
    });

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
        ? dateOnly(event.startDate, "event.startDate")
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
        ? formatDateOnly(d.user.dob)
        : "",
      ContactName: d.user.contactName || "",
      MedicalCondition: d.user.isMedicalCondition
        ? (d.user.medicalConditionDetails || "Yes")
        : "",
      IsMedicalCondition: Boolean(d.user.isMedicalCondition),
      MedicalConditionDetails: d.user.medicalConditionDetails || "",
      Comments: d.user.comments || "",

      RegistrationStatus: d.status,
      RegisteredAt: formatTimestamp(d.createdAt),
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
    if (!event || event.isArchived) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }

    if (campConfig) {
      event.campConfig = { ...event.campConfig, ...campConfig };
      await event.save();
    }

    const hasSessionsPayload = Object.prototype.hasOwnProperty.call(req.body || {}, "sessions");
    if (hasSessionsPayload && !Array.isArray(sessions)) {
      return res.status(400).json({ success: false, message: "sessions must be an array" });
    }

    if (hasSessionsPayload) {
      // Reconcile the complete submitted configuration. Registered sessions
      // are never deleted or moved: a missing registered row is disabled so
      // existing registrations and attendance remain addressable.
      const registrations = await EventRegistration.find({
        event: eventId,
        status: "REGISTERED",
      }).select("selectedSessions.session");
      const registeredSessionIds = new Set();
      registrations.forEach((reg) => {
        (reg.selectedSessions || []).forEach((selected) => {
          if (selected.session) registeredSessionIds.add(selected.session.toString());
        });
      });

      const existingSessions = await CampSession.find({ event: eventId });
      const existingById = new Map(existingSessions.map((item) => [item._id.toString(), item]));
      const existingByKey = new Map(
        existingSessions.map((item) => [
          `${dateOnly(item.sessionDate, "sessionDate")}:${item.sessionType}`,
          item,
        ])
      );
      const seenKeys = new Set();
      const touchedIds = new Set();
      const dayNotes = new Map();
      const supportedTypes = new Set(["FULL_DAY", "HALF_DAY", "CUSTOM"]);

      for (const input of sessions) {
        if (!input || !input.sessionDate || !input.sessionType) {
          return res.status(400).json({
            success: false,
            message: "Every camp session requires sessionDate and sessionType",
          });
        }

        const sessionType = String(input.sessionType).toUpperCase();
        if (!supportedTypes.has(sessionType)) {
          return res.status(400).json({
            success: false,
            message: `Invalid camp session type: ${input.sessionType}`,
          });
        }

        const dateKey = dateOnly(input.sessionDate, "sessionDate");
        const key = `${dateKey}:${sessionType}`;
        if (seenKeys.has(key)) {
          return res.status(409).json({
            success: false,
            message: `Duplicate camp session submitted for ${formatDateOnly(dateKey)} (${sessionType})`,
          });
        }
        seenKeys.add(key);

        let existingSession = null;
        if (input._id !== undefined && input._id !== null && input._id !== "") {
          if (!mongoose.Types.ObjectId.isValid(input._id)) {
            return res.status(400).json({ success: false, message: "Invalid camp session ID" });
          }
          existingSession = existingById.get(input._id.toString());
          if (!existingSession) {
            return res.status(404).json({
              success: false,
              message: "Camp session does not belong to this event",
            });
          }
        } else {
          existingSession = existingByKey.get(key) || null;
        }

        const keyOwner = existingByKey.get(key);
        if (existingSession && keyOwner && keyOwner._id.toString() !== existingSession._id.toString()) {
          return res.status(409).json({
            success: false,
            message: `A ${sessionType} session already exists for ${formatDateOnly(dateKey)}`,
          });
        }

        const isRegistered = existingSession && registeredSessionIds.has(existingSession._id.toString());
        if (existingSession && isRegistered) {
          const originalDate = dateOnly(existingSession.sessionDate, "sessionDate");
          if (originalDate !== dateKey || existingSession.sessionType !== sessionType) {
            return res.status(409).json({
              success: false,
              message: `Registered session ${formatDateOnly(originalDate)} (${existingSession.sessionType}) cannot be moved or changed`,
            });
          }
        }

        const defaultStart = sessionType === "HALF_DAY" ? "08:00 AM" : "08:00 AM";
        const defaultEnd = sessionType === "HALF_DAY" ? "02:00 PM" : "04:00 PM";
        const defaultFee = sessionType === "HALF_DAY" ? 70 : 90;
        const parsedCapacity = input.capacity !== undefined && input.capacity !== null && input.capacity !== ""
          ? Number(input.capacity)
          : (existingSession ? existingSession.capacity : null);

        if (parsedCapacity !== null && (!Number.isFinite(parsedCapacity) || parsedCapacity < 0)) {
          return res.status(400).json({ success: false, message: `Invalid capacity for ${formatDateOnly(dateKey)}` });
        }

        if (!existingSession) {
          existingSession = new CampSession({
            event: eventId,
            sessionDate: dateOnlyToUtc(dateKey, "sessionDate"),
            sessionType,
            sessionLabel: input.sessionLabel || (sessionType === "HALF_DAY" ? "Half Day" : "Full Day"),
            startTime: input.startTime || defaultStart,
            endTime: input.endTime || defaultEnd,
            fee: Number(input.fee !== undefined ? input.fee : defaultFee),
            capacity: parsedCapacity,
            isAvailable: input.isAvailable !== false,
            dayNote: input.dayNote !== undefined ? String(input.dayNote).trim() : "",
          });
        } else {
          if (!isRegistered) existingSession.sessionDate = dateOnlyToUtc(dateKey, "sessionDate");
          existingSession.sessionType = isRegistered ? existingSession.sessionType : sessionType;
          existingSession.sessionLabel = input.sessionLabel || existingSession.sessionLabel || (sessionType === "HALF_DAY" ? "Half Day" : "Full Day");
          existingSession.startTime = input.startTime || existingSession.startTime || defaultStart;
          existingSession.endTime = input.endTime || existingSession.endTime || defaultEnd;
          existingSession.fee = Number(input.fee !== undefined ? input.fee : existingSession.fee ?? defaultFee);
          existingSession.capacity = parsedCapacity;
          existingSession.isAvailable = input.isAvailable !== false;
          if (input.dayNote !== undefined) existingSession.dayNote = String(input.dayNote).trim();
        }

        await existingSession.save();
        touchedIds.add(existingSession._id.toString());
        if (input.dayNote !== undefined) dayNotes.set(dateKey, String(input.dayNote).trim());
      }

      // Keep a single note for a calendar date across FULL_DAY/HALF_DAY rows.
      for (const [dateKey, note] of dayNotes.entries()) {
        await CampSession.updateMany(
          {
            event: eventId,
            sessionDate: { $gte: dateOnlyStartUtc(dateKey), $lte: dateOnlyEndUtc(dateKey) },
          },
          { $set: { dayNote: note } }
        );
      }

      for (const existingSession of existingSessions) {
        const id = existingSession._id.toString();
        if (touchedIds.has(id)) continue;

        if (registeredSessionIds.has(id)) {
          // A registered date cannot disappear as a side effect of editing the
          // form; make it unavailable for new bookings instead.
          await CampSession.updateOne({ _id: existingSession._id }, { $set: { isAvailable: false } });
        } else {
          await CampSession.deleteOne({ _id: existingSession._id });
        }
      }
    }

    const updatedSessions = await CampSession.find({ event: eventId }).sort({ sessionDate: 1, sessionType: 1 });

    res.json({
      success: true,
      message: "Camp sessions updated successfully",
      data: updatedSessions.map(serializeCampSession),
    });
  } catch (error) {
    console.error("configureCampSessions error:", error);
    res.status(eventErrorStatus(error)).json({ success: false, message: error.message });
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

    const dateKey = dateOnly(date, "date");
    const targetDate = dateOnlyStartUtc(dateKey, "date");
    const nextDate = dateOnlyStartUtc(addDateOnlyDays(dateKey, 1, "date"), "date");

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
      message: `Date ${formatDateOnly(dateKey)} set to ${isAvailable ? "available" : "unavailable"}`,
      data: updatedSessions.map(serializeCampSession),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/** Update the shared note shown for every session on a camp calendar date. */
exports.updateCampDayNote = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { date, note = "" } = req.body || {};

    if (!date) {
      return res.status(400).json({ success: false, message: "Date is required" });
    }
    if (typeof note !== "string") {
      return res.status(400).json({ success: false, message: "Note must be a string" });
    }
    if (note.length > 2000) {
      return res.status(400).json({ success: false, message: "Note cannot exceed 2000 characters" });
    }

    const event = await Event.findById(eventId).select("_id");
    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }

    const dateKey = dateOnly(date, "date");
    const result = await CampSession.updateMany(
      {
        event: eventId,
        sessionDate: { $gte: dateOnlyStartUtc(dateKey), $lte: dateOnlyEndUtc(dateKey) },
      },
      { $set: { dayNote: note.trim() } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ success: false, message: "No camp sessions found for this date" });
    }

    const sessions = await CampSession.find({ event: eventId }).sort({ sessionDate: 1, sessionType: 1 });
    res.json({
      success: true,
      message: note.trim() ? `Note saved for ${dateKey}` : `Note cleared for ${dateKey}`,
      data: sessions.map(serializeCampSession),
    });
  } catch (error) {
    console.error("updateCampDayNote error:", error);
    res.status(eventErrorStatus(error)).json({ success: false, message: error.message });
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
    if (!event || event.isArchived) {
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
        select: "fullName email phone dob profileImage category skillLevel prefferedFoot contactName isMedicalCondition medicalConditionDetails",
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
      const dateStr = dateOnly(att.sessionDate, "attendance.sessionDate");
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
          const dStr = dateOnly(s.sessionDate, "selectedSession.sessionDate");
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
        const dStr = dateOnly(sess.sessionDate, "sessionDate");
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
        isMedicalCondition: Boolean(player.isMedicalCondition),
        medicalConditionDetails: player.medicalConditionDetails || "",
        paymentStatus: normalizePaymentStatus(
          reg.paymentStatus || (reg.invoice ? reg.invoice.paymentStatus : "UNPAID")
        ),
        totalAmount: reg.totalAmount || 0,
        registeredSessionsCount: playerSelectedSessions.length,
        selectedSessions: playerSelectedSessions.map(serializeSelectedSession),
        attendance,
      };
    }).filter(Boolean);

    // Summary counts per date/session
    const sessionSummaries = sessions.map((sess) => {
      const sessId = sess._id.toString();
      const dStr = dateOnly(sess.sessionDate, "sessionDate");

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
        dayOfWeek: weekdayShort(dStr),
        sessionType: sess.sessionType,
        sessionLabel: sess.sessionLabel || (sess.sessionType === "HALF_DAY" ? "Half Day" : "Full Day"),
        dayNote: sess.dayNote || "",
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
          startDate: dateOnly(event.startDate, "event.startDate"),
          endDate: dateOnly(event.endDate, "event.endDate"),
          venueName: event.venueName,
          address: event.address,
          status: event.status,
          totalRegistered: registrations.length,
        },
        sessions: sessions.map(serializeCampSession),
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

    const dateKey = dateOnly(sessionDate, "sessionDate");
    const date = dateOnlyToUtc(dateKey, "sessionDate");

    const allowedStatuses = new Set(["PRESENT", "ABSENT", "LATE", "NOT_MARKED"]);
    if (!allowedStatuses.has(String(status).toUpperCase())) {
      return res.status(400).json({ success: false, message: "Invalid attendance status" });
    }
    if (!mongoose.Types.ObjectId.isValid(playerId)) {
      return res.status(400).json({ success: false, message: "Invalid player ID" });
    }

    const { eligiblePlayerIds } = await resolveEventAttendanceScope({
      eventId,
      dateKey,
      campSessionId,
    });
    if (!eligiblePlayerIds.has(playerId.toString())) {
      return res.status(400).json({
        success: false,
        message: "Player is not registered for this event day/session",
      });
    }

    const query = {
      event: eventId,
      sessionDate: {
        $gte: dateOnlyStartUtc(dateKey, "sessionDate"),
        $lte: dateOnlyEndUtc(dateKey, "sessionDate"),
      },
    };
    if (campSessionId) {
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
    res.status(eventErrorStatus(error)).json({ success: false, message: error.message });
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

    const dateKey = dateOnly(sessionDate, "sessionDate");
    const date = dateOnlyToUtc(dateKey, "sessionDate");

    const { eligiblePlayerIds } = await resolveEventAttendanceScope({
      eventId,
      dateKey,
      campSessionId,
    });
    const allowedStatuses = new Set(["PRESENT", "ABSENT", "LATE", "NOT_MARKED"]);
    const normalizedRecords = [];
    const submittedPlayerIds = new Set();

    for (const rawRecord of records) {
      const player = rawRecord?.player || rawRecord?.playerId;
      const normalizedStatus = String(rawRecord?.status || "").toUpperCase();

      if (!player || !mongoose.Types.ObjectId.isValid(player)) {
        return res.status(400).json({ success: false, message: "Each attendance record requires a valid player ID" });
      }
      if (!allowedStatuses.has(normalizedStatus)) {
        return res.status(400).json({ success: false, message: `Invalid attendance status for player ${player}` });
      }
      if (!eligiblePlayerIds.has(player.toString())) {
        return res.status(400).json({
          success: false,
          message: `Player ${player} is not registered for this event day/session`,
        });
      }
      if (submittedPlayerIds.has(player.toString())) {
        return res.status(400).json({ success: false, message: `Duplicate attendance record for player ${player}` });
      }

      submittedPlayerIds.add(player.toString());
      normalizedRecords.push({
        player,
        status: normalizedStatus,
        attendanceType: rawRecord.attendanceType || "REGULAR",
        ...(rawRecord.reason !== undefined ? { reason: String(rawRecord.reason).trim() } : {}),
        ...(rawRecord.remarks !== undefined ? { remarks: String(rawRecord.remarks).trim() } : {}),
        ...(rawRecord.comment !== undefined ? { comment: String(rawRecord.comment) } : {}),
      });
    }

    const query = {
      event: eventId,
      sessionDate: {
        $gte: dateOnlyStartUtc(dateKey, "sessionDate"),
        $lte: dateOnlyEndUtc(dateKey, "sessionDate"),
      },
    };
    if (campSessionId) {
      query.campSession = campSessionId;
    }

    let attendance = await Attendance.findOne(query);

    if (attendance) {
      // Merge the supplied players into this date/session document. Replacing
      // the whole array used to erase existing records when a caller sent a
      // partial list; records for other sessions remain separate documents.
      const existingByPlayer = new Map(
        attendance.records.map((record) => [record.player.toString(), record])
      );
      normalizedRecords.forEach((record) => {
        const existingRecord = existingByPlayer.get(record.player.toString());
        if (existingRecord) {
          existingRecord.status = record.status;
          existingRecord.attendanceType = record.attendanceType;
          if (record.reason !== undefined) existingRecord.reason = record.reason;
          if (record.remarks !== undefined) existingRecord.remarks = record.remarks;
          if (record.comment !== undefined) existingRecord.comment = record.comment;
          existingRecord.lateArrival = record.status === "LATE";
        } else {
          attendance.records.push({
            ...record,
            lateArrival: record.status === "LATE",
          });
        }
      });
      attendance.markedBy = req.user?._id || req.admin?._id;
      await attendance.save();
    } else {
      attendance = await Attendance.create({
        event: eventId,
        campSession: campSessionId || undefined,
        sessionDate: date,
        records: normalizedRecords.map((record) => ({
          ...record,
          lateArrival: record.status === "LATE",
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
    res.status(eventErrorStatus(error)).json({ success: false, message: error.message });
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
        sessionDate: dateOnly(att.sessionDate, "attendance.sessionDate"),
        campSession: att.campSession,
        status: rec ? rec.status : "NOT_MARKED",
      };
    });

    res.json({
      success: true,
      data: {
        registration: serializeRegistration(registration),
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
    let { paymentStatus, eventId, playerId } = req.body;

    if (!paymentStatus) {
      return res.status(400).json({ success: false, message: "paymentStatus is required" });
    }

    paymentStatus = normalizePaymentStatus(paymentStatus, String(paymentStatus).toUpperCase());

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
