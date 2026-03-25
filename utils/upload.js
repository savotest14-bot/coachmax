const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const BASE_UPLOAD_PATH = path.join(process.cwd(), "uploads");

const UPLOAD_PATHS = Object.freeze({
  profile: "profile",
  bannerImg:"bannerImg",
  eventImg:"eventImg"
});

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const baseField = file.fieldname.replace(/\[\d+\]$/, "");
    const folder = UPLOAD_PATHS[baseField];

    if (!folder) {
      return cb(new Error("Invalid upload field"));
    }

    const fullPath = path.join(BASE_UPLOAD_PATH, folder);
    ensureDir(fullPath);

    cb(null, fullPath);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `${crypto.randomUUID()}${ext}`;
    cb(null, filename);
  },
});

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-ms-wmv",
  "video/mpeg",
  "application/pdf",
]);

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(new Error("Unsupported file type"), false);
  }
  cb(null, true);
};

const uploads = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});



module.exports = { uploads };
