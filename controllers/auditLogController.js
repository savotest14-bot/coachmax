const AuditLog = require("../models/AuditLog");

exports.getAuditLogs = async (req, res) => {
  try {
    let {
      page = 1,
      limit = 50,
      action,
      entityType,
      userId,
      startDate,
      endDate,
    } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = {};

    if (action) query.action = action;
    if (entityType) query.entityType = entityType;
    if (userId) query.user = userId;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const total = await AuditLog.countDocuments(query);

    const logs = await AuditLog.find(query)
      .populate("user", "name email role")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: logs,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getEntityAuditLogs = async (req, res) => {
  try {
    const { entityType, entityId } = req.params;

    const logs = await AuditLog.find({ entityType, entityId })
      .populate("user", "name email role")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      total: logs.length,
      data: logs,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
