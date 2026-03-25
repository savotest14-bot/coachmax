const isAdmin = (req, res, next) => {
  if (!req.admin || !["ADMIN", "SUPER_ADMIN"].includes(req.admin.role)) {
    return res.status(403).json({ message: "Admin only" });
  }
  next();
};

module.exports = isAdmin;