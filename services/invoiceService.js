const mongoose = require("mongoose");
const Invoice = require("../models/Invoice");
const Counter = require("../models/Counter");
const Class = require("../models/Class");
const User = require("../models/User");
const Parent = require("../models/Parent");
const { queueNotification } = require("./deliveryService");
const { currencyAmount } = require("../utils/money");
const { todayDateOnly } = require("../utils/dateTime");
const withSession = (query, session) => session ? query.session(session) : query;

async function generateInvoiceNumber({ session } = {}) {
  const year = Number(todayDateOnly().slice(0, 4));
  const key = `invoice:${year}`;
  if (!await withSession(Counter.findById(key), session)) {
    // Numeric ordering matters when an old sequence grows beyond six digits.
    const last = await withSession(Invoice.aggregate([
      { $match: { invoiceNumber: new RegExp(`^INV-${year}-[0-9]+$`) } },
      { $project: { sequence: { $convert: { input: { $arrayElemAt: [{ $split: ["$invoiceNumber", "-"] }, 2] }, to: "long", onError: 0, onNull: 0 } } } },
      { $group: { _id: null, sequence: { $max: "$sequence" } } },
    ]), session);
    const initial = Number(last[0]?.sequence || 0);
    if (!Number.isSafeInteger(initial) || initial < 0) throw Object.assign(new Error("Invoice sequence requires administrator reconciliation"), { status: 422 });
    try { await Counter.updateOne({ _id: key }, { $max: { sequence: initial } }, { upsert: true, session }); }
    catch (error) { if (session || error.code !== 11000) throw error; /* Another standalone allocator initialized this counter. */ }
  }
  const counter = await Counter.findOneAndUpdate({ _id: key }, { $inc: { sequence: 1 } }, { upsert: true, returnDocument: "after", session });
  return `INV-${year}-${String(counter.sequence).padStart(6, "0")}`;
}

async function issueCharge({ userId, contextId, contextField, title, description, type, amount, session, idempotencyKey, extra = {} }) {
  const work = async (tx) => {
    const player = await withSession(User.findById(userId), tx);
    if (!player?.parentId || !await withSession(Parent.exists({ _id: player.parentId }), tx)) {
      throw Object.assign(new Error("Player must be linked to a valid parent before billing"), { status: 422 });
    }
    const key = idempotencyKey || `${contextField}:${userId}:${contextId}`;
    const keyedInvoice = await withSession(Invoice.findOne({ status: "ACTIVE", chargeKey: key }), tx);
    if (keyedInvoice && (String(keyedInvoice.parent) !== String(player.parentId) || !keyedInvoice.players.some((value) => String(value) === String(userId)) || String(keyedInvoice[contextField]) !== String(contextId) || keyedInvoice.type !== type)) {
      throw Object.assign(new Error("This charge key was already used for a different enrollment"), { status: 409 });
    }
    const legacyInvoice = !key.startsWith("transfer:") && !keyedInvoice
      ? await withSession(Invoice.findOne({ status: "ACTIVE", chargeKey: { $exists: false }, parent: player.parentId, players: userId, [contextField]: contextId, type }), tx)
      : null;
    const existing = keyedInvoice || legacyInvoice;
    if (existing) return { invoice: existing, isDuplicate: true };
    const price = currencyAmount(amount);
    const invoiceNumber = await generateInvoiceNumber({ session: tx });
    const dueDate = new Date(); dueDate.setUTCDate(dueDate.getUTCDate() + 30);
    const [invoice] = await Invoice.create([{ chargeKey: key, invoiceNumber, parent: player.parentId, players: [userId], [contextField]: contextId, ...extra,
      items: [{ title, description, amount: price }], subtotal: price, discount: 0, totalAmount: price, amount: price,
      dueDate, type, description, notes: "", paymentStatus: "UNPAID", status: "ACTIVE" }], { session: tx });
    await queueNotification(`invoice:${invoice._id}`, { recipientType: "PARENT", parentId: String(player.parentId), title: "New invoice issued", message: `Invoice ${invoiceNumber} for ${title} ($${price.toFixed(2)}) is ready.`, type: "INVOICE_CREATED", data: { invoiceId: String(invoice._id), parentId: String(player.parentId), invoiceNumber, totalAmount: String(price), dueDate: dueDate.toISOString() } }, tx);
    return { invoice, isDuplicate: false };
  };
  if (session) return work(session);
  const tx = await mongoose.startSession();
  try { let result; await tx.withTransaction(async () => { result = await work(tx); }); return result; }
  finally { await tx.endSession(); }
}

async function generateClassInvoice({ userId, classId, session, idempotencyKey }) {
  const cls = await withSession(Class.findById(classId), session);
  if (!cls) throw Object.assign(new Error("Class not found"), { status: 404 });
  return issueCharge({ userId, contextId: classId, contextField: "class", title: cls.name, description: `Class fee for ${cls.name}`, type: "CLASS_FEE", amount: cls.price || 0, session, idempotencyKey });
}
async function generateTransferInvoice({ userId, fromClass, toClass, session, idempotencyKey }) {
  if (!fromClass || !toClass) throw Object.assign(new Error("Both transfer classes are required"), { status: 400 });
  const priceDiff = currencyAmount(Math.max(0, Number(toClass.price || 0) - Number(fromClass.price || 0)));
  if (!priceDiff) return { invoice: null, priceDiff, invoiceGenerated: false };
  const result = await issueCharge({ userId, contextId: toClass._id, contextField: "class", title: `Transfer to ${toClass.name}`, description: `Price difference from ${fromClass.name} to ${toClass.name}`, type: "CLASS_FEE", amount: priceDiff, session, idempotencyKey: idempotencyKey || `transfer:${userId}:${fromClass._id}:${toClass._id}` });
  return { ...result, priceDiff, invoiceGenerated: !result.isDuplicate };
}
async function generateTeamInvoice({ userId, teamId, session, idempotencyKey }) {
  const team = await withSession(require("../models/Team").findById(teamId), session);
  if (!team) throw Object.assign(new Error("Team not found"), { status: 404 });
  if (!Number(team.teamFee)) return { invoice: null, isDuplicate: false };
  return issueCharge({ userId, contextId: teamId, contextField: "team", title: team.teamName, description: `Team fee for ${team.teamName}`, type: "TEAM_FEE", amount: team.teamFee, session, idempotencyKey });
}
async function generateLeagueInvoice({ userId, leagueId, teamId, amount, session, idempotencyKey }) {
  const league = await withSession(require("../models/League").findById(leagueId), session);
  if (!league) throw Object.assign(new Error("League not found"), { status: 404 });
  let fee = amount ?? league.fee ?? 0;
  if (teamId && amount == null) {
    const team = await withSession(require("../models/Team").findById(teamId), session);
    const entry = team?.leagues?.find((item) => String(item.league?._id || item.league) === String(leagueId));
    fee = entry?.teamFee ?? fee;
  }
  if (!Number(fee)) return { invoice: null, isDuplicate: false };
  return issueCharge({ userId, contextId: leagueId, contextField: "league", title: league.name, description: `League fee for ${league.name}`, type: "TOURNAMENT_FEE", amount: fee, extra: teamId ? { team: teamId } : {}, session, idempotencyKey });
}
async function processLeagueInvoicesForTeam({ leagueId, teamId, amount, session }) {
  const team = await withSession(require("../models/Team").findById(teamId), session);
  if (!team) throw Object.assign(new Error("Team not found"), { status: 404 });
  const entry = team.leagues?.find((item) => String(item.league?._id || item.league) === String(leagueId));
  const statuses = new Map();
  for (const item of [...(team.players || []), ...(entry?.players || [])]) {
    const pid = String(item.player?._id || item.player || "");
    if (pid) statuses.set(pid, String(item.paymentStatus || "UNPAID").toUpperCase());
  }
  const results = [];
  for (const [userId, status] of statuses) if (status === "UNPAID") results.push(await generateLeagueInvoice({ userId, leagueId, teamId, amount, session }));
  return results;
}
module.exports = { generateInvoiceNumber, generateClassInvoice, generateTransferInvoice, generateTeamInvoice, generateLeagueInvoice, processLeagueInvoicesForTeam };
