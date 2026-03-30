const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

exports.createEvent = async (req, res) => {
  try {
    let bannerImage = null;

    if (req.file) {
      bannerImage = `uploads/eventImg/${req.file.filename}`;
    }

    const event = await Event.create({
      ...req.body,
      bannerImage,
      createdBy: req.admin._id,
    });

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

    // -----------------------
    // 🔹 Manual Validation
    // -----------------------
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

    // -----------------------
    // 🔹 Handle banner image replacement
    // -----------------------
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

    // -----------------------
    // 🔹 Update event
    // -----------------------
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

    // ✅ get all events
    const events = await Event.find({
      status: "UPCOMING",
      isRegistrationOpen: true,
    }).sort({ startDate: 1 });

    // ✅ get user's registrations
    const registrations = await EventRegistration.find({
      user: userId,
      status: "REGISTERED",
    }).select("event");

    // convert to set for fast lookup
    const registeredEventIds = new Set(
      registrations.map((r) => r.event.toString())
    );

    // ✅ attach flag
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
    const userId = req.user._id;
    const { eventId } = req.body;

    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    if (event.status !== "UPCOMING") {
      return res.status(400).json({
        message: "Event is not open for registration",
      });
    }

    if (!event.isRegistrationOpen) {
      return res.status(400).json({
        message: "Registration is closed",
      });
    }

    if (
      event.registrationDeadline &&
      new Date() > new Date(event.registrationDeadline)
    ) {
      return res.status(400).json({
        message: "Registration deadline passed",
      });
    }

    // 🔥 check existing registration
    let existing = await EventRegistration.findOne({
      user: userId,
      event: eventId,
    });

    // ❌ already registered
    if (existing && existing.status === "REGISTERED") {
      return res.status(400).json({
        message: "Already registered",
      });
    }

    // ❌ check capacity
    if (event.totalRegistered >= event.maxParticipants) {
      return res.status(400).json({
        message: "Event is full",
      });
    }

    // ✅ re-register (if previously cancelled)
    if (existing && existing.status === "CANCELLED") {
      existing.status = "REGISTERED";
      await existing.save();

      await Event.findByIdAndUpdate(eventId, {
        $inc: { totalRegistered: 1 },
      });

      return res.json({
        success: true,
        message: "Re-registered successfully",
        data: existing,
      });
    }

    // ✅ first-time registration
    const registration = await EventRegistration.create({
      user: userId,
      event: eventId,
    });

    await Event.findByIdAndUpdate(eventId, {
      $inc: { totalRegistered: 1 },
    });

    res.json({
      success: true,
      message: "Registered successfully",
      data: registration,
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
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

    // ✅ update status
    registration.status = "CANCELLED";
    await registration.save();

    // ✅ decrement count safely
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

    // ✅ get event
    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    // 📊 stats
    const totalSlots = event.maxParticipants || 0;
    const registered = event.totalRegistered || 0;
    const availableSlots = totalSlots - registered;

    // 👤 user registration status
    let userRegistrationStatus = "NOT_REGISTERED";

    if (userId) {
      const registration = await EventRegistration.findOne({
        user: userId,
        event: eventId,
      });

      if (registration) {
        userRegistrationStatus = registration.status; // REGISTERED / CANCELLED
      }
    }

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
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getEventDetailsAdmin = async (req, res) => {
  try {
    const { eventId } = req.params;

    // ✅ get event
    const event = await Event.findById(eventId).populate(
      "createdBy",
      "fullName email"
    );

    if (!event) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    // 📊 stats
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

    // ✅ get event details (for stats)
    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    // 🔥 aggregation (BEST)
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

    // 🔍 search filter
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

    // 📊 total count (after search)
    const totalData = await EventRegistration.aggregate([
      ...pipeline,
      { $count: "total" },
    ]);

    const total = totalData[0]?.total || 0;

    // 📥 CSV EXPORT (no pagination)
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

    // 📄 pagination
    pipeline.push({ $sort: { createdAt: -1 } });
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNumber });

    const participants = await EventRegistration.aggregate(pipeline);

    // 📊 stats
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

    // ✅ validate event
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    // -----------------------
    // 🔥 GET FULL DATA
    // -----------------------
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

    // -----------------------
    // 🧾 FORMAT DATA (FULL)
    // -----------------------
    const formatted = data.map((d) => ({
      // 🔹 Event Info
      EventTitle: event.title,
      EventCategory: event.category,
      EventStartDate: event.startDate
        ? new Date(event.startDate).toLocaleDateString()
        : "",
      EventVenue: event.venueName || "",

      // 🔹 User Info
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

      // 🔹 Registration Info
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