const isParent = (req, res, next) => {
  if (!req.parent || req.role !== "PARENT") {
    return res.status(403).json({ message: "Parent access only" });
  }
  next();
};

module.exports = isParent;
