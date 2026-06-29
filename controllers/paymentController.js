const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const Parent = require("../models/Parent");

// ✅ Create Invoice (Admin only)
exports.createInvoice = async (req, res) => {
  try {
    const { parentId, amount, dueDate, type, description } = req.body;

    if (!parentId || !amount || !dueDate || !type) {
      return res.status(400).json({ success: false, message: "Required fields missing" });
    }

    const parent = await Parent.findById(parentId);
    if (!parent) {
      return res.status(404).json({ success: false, message: "Parent not found" });
    }

    const invoice = await Invoice.create({
      parent: parentId,
      amount,
      dueDate,
      type,
      description,
      status: "PENDING",
    });

    res.status(201).json({ success: true, message: "Invoice created successfully", data: invoice });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Fetch Parent's Invoices (Parent or Admin)
exports.getInvoices = async (req, res) => {
  try {
    const parentId = req.role === "PARENT" ? req.parent._id : req.query.parentId;

    if (!parentId) {
      return res.status(400).json({ success: false, message: "parentId is required" });
    }

    const invoices = await Invoice.find({ parent: parentId }).sort({ dueDate: -1 });
    res.json({ success: true, data: invoices });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Record Payment (Parent Checkout or Admin manual receipt)
exports.recordPayment = async (req, res) => {
  try {
    const { invoiceId, amountPaid, paymentMethod, transactionId } = req.body;

    if (!invoiceId || !amountPaid || !paymentMethod) {
      return res.status(400).json({ success: false, message: "Required fields missing" });
    }

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }

    const parentId = req.role === "PARENT" ? req.parent._id : invoice.parent;

    const payment = await Payment.create({
      invoice: invoiceId,
      parent: parentId,
      amountPaid,
      paymentMethod,
      transactionId,
      status: "COMPLETED",
    });

    // Update invoice status
    invoice.status = "PAID";
    await invoice.save();

    res.status(201).json({
      success: true,
      message: "Payment recorded successfully",
      data: payment,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Get Payment History for Parent
exports.getPaymentHistory = async (req, res) => {
  try {
    const parentId = req.role === "PARENT" ? req.parent._id : req.query.parentId;

    if (!parentId) {
      return res.status(400).json({ success: false, message: "parentId is required" });
    }

    const payments = await Payment.find({ parent: parentId })
      .populate("invoice", "type amount description")
      .sort({ paymentDate: -1 });

    res.json({ success: true, data: payments });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
