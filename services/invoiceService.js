const Invoice = require("../models/Invoice");
const Class = require("../models/Class");
const User = require("../models/User");
const { sendNotification } = require("./notificationService");

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

/**
 * Automatically generate an invoice for a player assigned to a class.
 * Ensures duplicate invoices are NOT created if an active/non-cancelled invoice already exists
 * for the same player and class.
 *
 * @param {Object} params
 * @param {string} params.userId - Player's User ID
 * @param {string} params.classId - Assigned Class ID
 * @returns {Promise<{ invoice: Object, isDuplicate: boolean }>}
 */
const generateClassInvoice = async ({ userId, classId }) => {
  if (!userId || !classId) {
    return { invoice: null, isDuplicate: false, error: "userId and classId are required" };
  }

  // 1. Fetch Player
  const player = await User.findById(userId);
  if (!player) {
    return { invoice: null, isDuplicate: false, error: "Player not found" };
  }

  if (!player.parentId) {
    return { invoice: null, isDuplicate: false, error: "Player has no parent associated" };
  }

  // 2. Fetch Class
  const classDoc = await Class.findById(classId);
  if (!classDoc) {
    return { invoice: null, isDuplicate: false, error: "Class not found" };
  }

  // 3. Duplicate Invoice Check
  // Check if an active / non-cancelled invoice already exists for this player & class assignment
  const existingInvoice = await Invoice.findOne({
    parent: player.parentId,
    players: userId,
    class: classId,
    status: { $ne: "CANCELLED" },
  });

  if (existingInvoice) {
    console.log(`[InvoiceService] Duplicate invoice prevented for player ${userId} and class ${classId}. Existing invoice: ${existingInvoice.invoiceNumber}`);
    return { invoice: existingInvoice, isDuplicate: true };
  }

  // 4. Generate New Invoice
  const price = Number(classDoc.price || 0);
  const invoiceNumber = await generateInvoiceNumber();

  // Due date: 30 days from invoice generation
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  const invoice = await Invoice.create({
    invoiceNumber,
    parent: player.parentId,
    players: [userId],
    class: classId,
    items: [
      {
        title: classDoc.name,
        description: `Class fee for ${classDoc.name}`,
        amount: price,
      },
    ],
    subtotal: price,
    discount: 0,
    totalAmount: price,
    amount: price,
    dueDate,
    type: "CLASS_FEE",
    description: `Invoice for class enrollment: ${classDoc.name}`,
    notes: "",
    paymentStatus: "UNPAID",
    status: "ACTIVE",
  });

  // Update player classPaymentStatuses for this class to UNPAID
  player.classPaymentStatuses = player.classPaymentStatuses || [];
  const existingCPS = player.classPaymentStatuses.find(
    (cps) => cps.class && cps.class.toString() === classId.toString()
  );
  if (existingCPS) {
    existingCPS.paymentStatus = "UNPAID";
  } else {
    player.classPaymentStatuses.push({
      class: classId,
      paymentStatus: "UNPAID",
    });
  }
  await player.save();

  // 5. Send Notification to Parent
  try {
    await sendNotification({
      recipientType: "PARENT",
      parentId: player.parentId,
      title: "New Class Invoice Issued 📄",
      message: `An invoice #${invoiceNumber} for class "${classDoc.name}" ($${price}) has been generated.`,
      type: "INVOICE_CREATED",
      data: {
        parentId: String(player.parentId),
        invoiceId: String(invoice._id),
        invoiceNumber: String(invoiceNumber),
        classId: String(classId),
        totalAmount: String(price),
        dueDate: dueDate.toISOString(),
      },
    });
  } catch (notifErr) {
    console.error("[InvoiceService] Failed to send invoice notification:", notifErr.message);
  }

  return { invoice, isDuplicate: false };
};

/**
 * Automatically generate an invoice for the price difference when transferring a player from one class to another.
 * If new class price > old class price, an invoice for the difference is generated.
 * If new class price <= old class price, no invoice is generated.
 *
 * @param {Object} params
 * @param {string} params.userId - Player's User ID
 * @param {Object} params.fromClass - Previous Class document
 * @param {Object} params.toClass - New Class document
 * @returns {Promise<{ invoice: Object|null, priceDiff: number, invoiceGenerated: boolean }>}
 */
const generateTransferInvoice = async ({ userId, fromClass, toClass }) => {
  if (!userId || !fromClass || !toClass) {
    return { invoice: null, priceDiff: 0, invoiceGenerated: false, error: "userId, fromClass, and toClass are required" };
  }

  const fromPrice = Number(fromClass.price || 0);
  const toPrice = Number(toClass.price || 0);
  const priceDiff = toPrice - fromPrice;

  if (priceDiff <= 0) {
    console.log(`[InvoiceService] No invoice needed for class transfer (from ${fromPrice} to ${toPrice}, diff: ${priceDiff})`);
    return { invoice: null, priceDiff, invoiceGenerated: false };
  }

  const player = await User.findById(userId);
  if (!player || !player.parentId) {
    return { invoice: null, priceDiff, invoiceGenerated: false, error: "Player or parent not found" };
  }

  const invoiceNumber = await generateInvoiceNumber();

  // Due date: 30 days from transfer
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  const invoice = await Invoice.create({
    invoiceNumber,
    parent: player.parentId,
    players: [userId],
    class: toClass._id,
    items: [
      {
        title: `Class Transfer: ${toClass.name}`,
        description: `Price difference for transfer from ${fromClass.name} ($${fromPrice}) to ${toClass.name} ($${toPrice})`,
        amount: priceDiff,
      },
    ],
    subtotal: priceDiff,
    discount: 0,
    totalAmount: priceDiff,
    amount: priceDiff,
    dueDate,
    type: "CLASS_FEE",
    description: `Invoice for class transfer price difference`,
    notes: `Transferred from ${fromClass.name} to ${toClass.name}`,
    paymentStatus: "UNPAID",
    status: "ACTIVE",
  });

  try {
    await sendNotification({
      recipientType: "PARENT",
      parentId: player.parentId,
      title: "Class Transfer Invoice Issued 📄",
      message: `Your player ${player.fullName || player.firstName} was transferred from "${fromClass.name}" to "${toClass.name}". An invoice #${invoiceNumber} for the remaining price difference ($${priceDiff}) has been generated.`,
      type: "INVOICE_CREATED",
      data: {
        parentId: String(player.parentId),
        invoiceId: String(invoice._id),
        invoiceNumber: String(invoiceNumber),
        fromClassId: String(fromClass._id),
        toClassId: String(toClass._id),
        totalAmount: String(priceDiff),
        dueDate: dueDate.toISOString(),
      },
    });
  } catch (notifErr) {
    console.error("[InvoiceService] Failed to send transfer invoice notification:", notifErr.message);
  }

  return { invoice, priceDiff, invoiceGenerated: true };
};

/**
 * Automatically generate an invoice for a player assigned to a team.
 * Ensures duplicate invoices are NOT created if an active/non-cancelled invoice already exists
 * for the same player and team.
 *
 * @param {Object} params
 * @param {string} params.userId - Player's User ID
 * @param {string} params.teamId - Assigned Team ID
 * @returns {Promise<{ invoice: Object|null, isDuplicate: boolean, error?: string }>}
 */
const generateTeamInvoice = async ({ userId, teamId }) => {
  if (!userId || !teamId) {
    return { invoice: null, isDuplicate: false, error: "userId and teamId are required" };
  }

  // 1. Fetch Player
  const player = await User.findById(userId);
  if (!player) {
    return { invoice: null, isDuplicate: false, error: "Player not found" };
  }

  if (!player.parentId) {
    return { invoice: null, isDuplicate: false, error: "Player has no parent associated" };
  }

  // 2. Fetch Team
  const Team = require("../models/Team");
  const teamDoc = await Team.findById(teamId);
  if (!teamDoc) {
    return { invoice: null, isDuplicate: false, error: "Team not found" };
  }

  const teamFee = Number(teamDoc.teamFee || 0);
  if (teamFee <= 0) {
    // No fee configured for this team
    return { invoice: null, isDuplicate: false };
  }

  // 3. Duplicate Invoice Check
  const existingInvoice = await Invoice.findOne({
    parent: player.parentId,
    players: userId,
    team: teamId,
    type: "TEAM_FEE",
    status: { $ne: "CANCELLED" },
  });

  if (existingInvoice) {
    console.log(`[InvoiceService] Duplicate team invoice prevented for player ${userId} and team ${teamId}. Existing invoice: ${existingInvoice.invoiceNumber}`);
    return { invoice: existingInvoice, isDuplicate: true };
  }

  // 4. Generate New Invoice
  const invoiceNumber = await generateInvoiceNumber();

  // Due date: 30 days from invoice generation
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  const invoice = await Invoice.create({
    invoiceNumber,
    parent: player.parentId,
    players: [userId],
    team: teamId,
    items: [
      {
        title: teamDoc.teamName,
        description: `Team fee for ${teamDoc.teamName} (${teamDoc.teamType || "INTERNAL"})`,
        amount: teamFee,
      },
    ],
    subtotal: teamFee,
    discount: 0,
    totalAmount: teamFee,
    amount: teamFee,
    dueDate,
    type: "TEAM_FEE",
    description: `Invoice for team assignment: ${teamDoc.teamName}`,
    notes: "",
    paymentStatus: "UNPAID",
    status: "ACTIVE",
  });

  // Update player paymentStatus on Team schema as well
  if (teamDoc.players && Array.isArray(teamDoc.players)) {
    const pEntry = teamDoc.players.find((item) => {
      const pid = item.player ? item.player.toString() : item.toString();
      return pid === userId.toString();
    });
    if (pEntry) {
      pEntry.paymentStatus = "UNPAID";
      await teamDoc.save();
    }
  }

  // 5. Send Notification to Parent
  try {
    await sendNotification({
      recipientType: "PARENT",
      parentId: player.parentId,
      title: "New Team Fee Invoice Issued 📄",
      message: `An invoice #${invoiceNumber} for team "${teamDoc.teamName}" ($${teamFee}) has been generated.`,
      type: "INVOICE_CREATED",
      data: {
        parentId: String(player.parentId),
        invoiceId: String(invoice._id),
        invoiceNumber: String(invoiceNumber),
        teamId: String(teamId),
        totalAmount: String(teamFee),
        dueDate: dueDate.toISOString(),
      },
    });
  } catch (notifErr) {
    console.error("[InvoiceService] Failed to send team invoice notification:", notifErr.message);
  }

  return { invoice, isDuplicate: false };
};

module.exports = {
  generateInvoiceNumber,
  generateClassInvoice,
  generateTransferInvoice,
  generateTeamInvoice,
};
