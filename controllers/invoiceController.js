const Invoice = require("../models/Invoice");
const Parent = require("../models/Parent");
const User = require("../models/User");
const BankDetails = require("../models/BankDetails");
const Notification = require("../models/Notification");
const { sendNotification } = require("../services/notificationService");

// Helper to generate sequential invoice number e.g. INV-2026-000001
const generateInvoiceNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;

  const lastInvoice = await Invoice.findOne({
    invoiceNumber: new RegExp(`^${prefix}`),
  })
    .sort({ createdAt: -1 })
    .select("invoiceNumber");

  let sequence = 1;
  if (lastInvoice && lastInvoice.invoiceNumber) {
    const parts = lastInvoice.invoiceNumber.split("-");
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastNum)) {
      sequence = lastNum + 1;
    }
  }

  const paddedSequence = String(sequence).padStart(6, "0");
  return `${prefix}${paddedSequence}`;
};

// ✅ Create Invoice (Admin only)
exports.createInvoice = async (req, res) => {
  try {
    const {
      parentId,
      players = [],
      items = [],
      dueDate,
      description = "",
      notes = "",
      discount = 0,
      type = "CUSTOM",
      totalAmount: customTotalAmount,
    } = req.body;

    if (!parentId || !dueDate) {
      return res.status(400).json({
        success: false,
        message: "parentId and dueDate are required",
      });
    }

    const parent = await Parent.findById(parentId);
    if (!parent) {
      return res.status(404).json({
        success: false,
        message: "Parent not found",
      });
    }

    // Validate players if provided
    if (Array.isArray(players) && players.length > 0) {
      const dbPlayers = await User.find({ _id: { $in: players } });
      if (dbPlayers.length !== players.length) {
        return res.status(400).json({
          success: false,
          message: "One or more player IDs are invalid",
        });
      }
      for (const p of dbPlayers) {
        if (p.parentId && p.parentId.toString() !== parentId.toString()) {
          return res.status(400).json({
            success: false,
            message: `Player '${p.fullName || p.firstName}' does not belong to the selected parent`,
          });
        }
      }
    }

    // Process items & subtotal
    const processedItems = (Array.isArray(items) ? items : []).map((item) => ({
      title: item.title || item.description || "Invoice Item",
      description: item.description || "",
      amount: Number(item.amount || 0),
    }));

    const calculatedSubtotal = processedItems.reduce((acc, item) => acc + item.amount, 0);
    const numDiscount = Number(discount || 0);

    let finalTotal = customTotalAmount !== undefined && customTotalAmount !== null
      ? Number(customTotalAmount)
      : Math.max(0, calculatedSubtotal - numDiscount);

    if (finalTotal === 0 && calculatedSubtotal === 0 && req.body.amount) {
      finalTotal = Number(req.body.amount);
    }

    const invoiceNumber = await generateInvoiceNumber();

    const invoice = await Invoice.create({
      invoiceNumber,
      parent: parentId,
      players: Array.isArray(players) ? players : [],
      items: processedItems,
      subtotal: calculatedSubtotal,
      discount: numDiscount,
      totalAmount: finalTotal,
      amount: finalTotal,
      dueDate: new Date(dueDate),
      type: type || "CUSTOM",
      description,
      notes,
      paymentStatus: "UNPAID",
      status: "ACTIVE",
    });

    // Create Notification for Parent
    try {
      await sendNotification({
        recipientType: "PARENT",
        parentId: parentId,
        title: "New Invoice Issued 📄",
        message: `An invoice #${invoiceNumber} for amount ${finalTotal} has been issued. Due date: ${new Date(dueDate).toLocaleDateString()}.`,
        type: "INVOICE_CREATED",
        data: {
          parentId: String(parentId),
          invoiceId: String(invoice._id),
          invoiceNumber: String(invoiceNumber),
          totalAmount: String(finalTotal),
          dueDate: new Date(dueDate).toISOString(),
        },
      });
    } catch (notifErr) {
      console.error("Notification creation failed:", notifErr.message);
    }

    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate("parent", "fullName email phone")
      .populate("players", "firstName lastName fullName gender category");

    return res.status(201).json({
      success: true,
      message: "Invoice created successfully",
      data: populatedInvoice,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Get All Invoices (Admin only with search & filters)
exports.getAdminInvoices = async (req, res) => {
  try {
    const {
      search = "",
      status,
      paymentStatus,
      type,
      parent,
      startDate,
      endDate,
      page = 1,
      limit = 10,
    } = req.query;

    const query = {};

    if (status) query.status = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;
    if (type) query.type = type;
    if (parent) query.parent = parent;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    let searchParentIds = [];
    let searchPlayerIds = [];

    if (search) {
      const searchRegex = new RegExp(search, "i");

      const [matchingParents, matchingPlayers] = await Promise.all([
        Parent.find({
          $or: [{ fullName: searchRegex }, { email: searchRegex }, { phone: searchRegex }],
        }).select("_id"),
        User.find({
          $or: [{ fullName: searchRegex }, { firstName: searchRegex }, { lastName: searchRegex }],
        }).select("_id"),
      ]);

      searchParentIds = matchingParents.map((p) => p._id);
      searchPlayerIds = matchingPlayers.map((p) => p._id);

      query.$or = [
        { invoiceNumber: searchRegex },
        { description: searchRegex },
        { parent: { $in: searchParentIds } },
        { players: { $in: searchPlayerIds } },
      ];
    }

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (currentPage - 1) * pageLimit;

    const [invoices, total] = await Promise.all([
      Invoice.find(query)
        .populate("parent", "fullName email phone emergencyContact")
        .populate("players", "firstName lastName fullName category")
        .populate("verifiedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit),
      Invoice.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      count: invoices.length,
      pagination: {
        page: currentPage,
        limit: pageLimit,
        total,
        pages: Math.ceil(total / pageLimit),
      },
      data: invoices,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Get Admin Invoice By ID
exports.getAdminInvoiceById = async (req, res) => {
  try {
    const { id } = req.params;

    const invoice = await Invoice.findById(id)
      .populate("parent", "fullName email phone emergencyContact relationship")
      .populate("players", "firstName lastName fullName gender category assignedClasses")
      .populate("verifiedBy", "name email");

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: invoice,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Update Invoice (Admin only)
exports.updateInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      players,
      items,
      dueDate,
      description,
      notes,
      discount,
      status,
      type,
      totalAmount,
    } = req.body;

    const invoice = await Invoice.findById(id);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    if (invoice.paymentStatus === "PAID") {
      return res.status(400).json({
        success: false,
        message: "Cannot modify a paid invoice",
      });
    }

    if (players && Array.isArray(players)) {
      invoice.players = players;
    }

    if (items && Array.isArray(items)) {
      invoice.items = items.map((item) => ({
        title: item.title || item.description || "Invoice Item",
        description: item.description || "",
        amount: Number(item.amount || 0),
      }));
      invoice.subtotal = invoice.items.reduce((acc, i) => acc + i.amount, 0);
    }

    if (discount !== undefined) invoice.discount = Number(discount);
    if (dueDate) invoice.dueDate = new Date(dueDate);
    if (description !== undefined) invoice.description = description;
    if (notes !== undefined) invoice.notes = notes;
    if (status) invoice.status = status;
    if (type) invoice.type = type;

    if (totalAmount !== undefined) {
      invoice.totalAmount = Number(totalAmount);
      invoice.amount = Number(totalAmount);
    } else if (items || discount !== undefined) {
      invoice.totalAmount = Math.max(0, invoice.subtotal - invoice.discount);
      invoice.amount = invoice.totalAmount;
    }

    await invoice.save();

    const updatedInvoice = await Invoice.findById(id)
      .populate("parent", "fullName email phone")
      .populate("players", "firstName lastName fullName");

    return res.status(200).json({
      success: true,
      message: "Invoice updated successfully",
      data: updatedInvoice,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Delete / Cancel Invoice (Admin only)
exports.deleteInvoice = async (req, res) => {
  try {
    const { id } = req.params;

    const invoice = await Invoice.findById(id);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    if (invoice.paymentStatus === "PAID") {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel a paid invoice",
      });
    }

    invoice.status = "CANCELLED";
    invoice.paymentStatus = "CANCELLED";
    await invoice.save();

    return res.status(200).json({
      success: true,
      message: "Invoice cancelled successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Get Parent's Invoices (Parent only)
exports.getParentInvoices = async (req, res) => {
  try {
    const parentId = req.parent._id;
    const { status, paymentStatus, page = 1, limit = 10 } = req.query;

    const query = { parent: parentId };
    if (status) query.status = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (currentPage - 1) * pageLimit;

    const [invoices, total, activeBankDetails] = await Promise.all([
      Invoice.find(query)
        .populate("players", "firstName lastName fullName category assignedClasses")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit),
      Invoice.countDocuments(query),
      BankDetails.findOne({ isActive: true }).sort({ updatedAt: -1 }),
    ]);

    return res.status(200).json({
      success: true,
      count: invoices.length,
      pagination: {
        page: currentPage,
        limit: pageLimit,
        total,
        pages: Math.ceil(total / pageLimit),
      },
      data: invoices,
      bankDetails: activeBankDetails || null,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Get Parent Single Invoice Details
exports.getParentInvoiceById = async (req, res) => {
  try {
    const parentId = req.parent._id;
    const { id } = req.params;

    const invoice = await Invoice.findOne({ _id: id, parent: parentId })
      .populate("players", "firstName lastName fullName category assignedClasses");

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found or unauthorized",
      });
    }

    const activeBankDetails = await BankDetails.findOne({ isActive: true }).sort({ updatedAt: -1 });

    return res.status(200).json({
      success: true,
      data: invoice,
      bankDetails: activeBankDetails || null,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
