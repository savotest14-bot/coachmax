const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || path.join(__dirname, "..", "uploads"));
const MB = 1024 * 1024;
const raster = ["image/jpeg", "image/png", "image/webp"];
const policies = {
  profile: { folder: "profiles", max: 5 * MB, types: raster }, profiles: { folder: "profiles", max: 5 * MB, types: raster }, profileImage: { folder: "profiles", max: 5 * MB, types: raster }, profileImages: { folder: "profiles", max: 5 * MB, types: raster }, image: { folder: "profiles", max: 5 * MB, types: raster },
  teamLogo: { folder: "teamlogos", max: 2 * MB, types: raster }, leagueLogo: { folder: "leaguelogos", max: 2 * MB, types: raster },
  bannerImg: { folder: "bannerImg", max: 5 * MB, types: raster }, eventImg: { folder: "eventImg", max: 8 * MB, types: raster }, images: { folder: "images", max: 8 * MB, types: raster }, qrCodeImage: { folder: "bank-details", max: 2 * MB, types: raster },
  document: { folder: "documents", max: 10 * MB, types: [...raster, "application/pdf"] }, paymentScreenshot: { folder: "payment-screenshots", max: 10 * MB, types: [...raster, "application/pdf"] }, receipt: { folder: "payment-screenshots", max: 10 * MB, types: [...raster, "application/pdf"] },
  attachments: { folder: "training", max: 50 * MB, types: [...raster, "application/pdf", "video/mp4", "video/webm"] },
  file: { folder: "chat", max: 50 * MB, types: [...raster, "image/gif", "video/mp4", "video/webm", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "application/pdf"] },
};
const uploadError = (message, status = 415) => Object.assign(new Error(message), { status });
function policyFor(field) { const policy = policies[String(field).replace(/\[\d+\]$/, "")]; if (!policy) throw uploadError("Unexpected upload field", 400); return policy; }
function signatureType(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([255,216,255]))) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (/^GIF8[79]a/.test(buffer.toString("ascii", 0, 6))) return "image/gif";
  if (buffer.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  if (buffer.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) return "video/webm";
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12);
    if (["M4A ", "M4B "].includes(brand)) return "audio/mp4";
    if (["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "qt  "].includes(brand)) return "video/mp4";
  }
  if (buffer.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  if (buffer.toString("ascii", 0, 3) === "ID3" || (buffer[0] === 255 && (buffer[1] & 224) === 224)) return "audio/mpeg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  return null;
}
async function validateContent(buffer, mime, field) {
  const policy = policyFor(field);
  const max = mime.startsWith("image/") && policy.folder === "chat" ? 10 * MB : mime.startsWith("audio/") || mime === "application/pdf" ? Math.min(policy.max, 20 * MB) : policy.max;
  if (!buffer.length || buffer.length > max) throw uploadError(`File must be smaller than ${max / MB} MB`, 413);
  if (!policy.types.includes(mime) || signatureType(buffer) !== mime) throw uploadError("File content does not match a supported file type");
  if (mime.startsWith("image/")) {
    try {
      const image = sharp(buffer, { limitInputPixels: 16 * 1024 * 1024, failOn: "error", animated: false });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096) throw new Error("dimensions");
      const output = await image.rotate().webp({ quality: 85 }).toBuffer();
      if (output.length > max) throw uploadError("Processed image is too large", 413);
      return { buffer: output, mimetype: "image/webp", extension: ".webp" };
    } catch (error) { if (error.status) throw error; throw uploadError("Image is corrupt or exceeds the supported dimensions", 422); }
  }
  const extension = { "application/pdf": ".pdf", "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/ogg": ".ogg", "audio/wav": ".wav" }[mime];
  return { buffer, mimetype: mime, extension };
}
async function saveValidatedBuffer(buffer, mime, field) {
  const content = await validateContent(buffer, mime, field);
  const destination = path.join(UPLOAD_ROOT, policyFor(field).folder);
  await fs.promises.mkdir(destination, { recursive: true });
  const filename = `${crypto.randomUUID()}${content.extension}`;
  const filePath = path.join(destination, filename);
  await fs.promises.writeFile(filePath, content.buffer, { flag: "wx", mode: 0o640 });
  return { destination, filename, path: filePath, size: content.buffer.length, mimetype: content.mimetype };
}
const storage = {
  _handleFile(req, file, callback) {
    let size = 0; const chunks = []; let finished = false;
    const finish = (error, output) => { if (finished) return; finished = true; callback(error, output); };
    const policy = policyFor(file.fieldname);
    file.stream.on("limit", () => finish(uploadError("Upload exceeds maximum size", 413)));
    file.stream.on("error", finish);
    file.stream.on("data", (chunk) => { size += chunk.length; if (size > policy.max) { finish(uploadError(`File must be smaller than ${policy.max / MB} MB`, 413)); file.stream.resume(); } else if (!finished) chunks.push(chunk); });
    file.stream.on("end", async () => {
      if (finished) return;
      try { finish(null, await saveValidatedBuffer(Buffer.concat(chunks), file.mimetype, file.fieldname)); } catch (error) { finish(error); }
    });
  },
  _removeFile(req, file, callback) {
    const target = path.resolve(file.path || "");
    if (!target.startsWith(UPLOAD_ROOT + path.sep)) return callback(uploadError("Invalid stored upload path", 400));
    fs.unlink(target, (error) => callback(error?.code === "ENOENT" ? null : error));
  },
};
const uploads = multer({ storage, limits: { fileSize: 50 * MB, files: 20, fields: 100, fieldSize: MB }, fileFilter(req, file, callback) {
  try { const policy = policyFor(file.fieldname); if (!policy.types.includes(file.mimetype)) throw uploadError("Unsupported file type. Convert HEIC/HEIF to JPEG, PNG or WebP before uploading."); callback(null, true); } catch (error) { callback(error); }
} });
function resolveStoredUploadPath(value) {
  if (typeof value !== "string") return null;
  const matched = value.split(/[?#]/)[0].match(/^\/?uploads\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9._-]+)$/);
  if (!matched || matched[2].includes("..") || !Object.values(policies).some((policy) => policy.folder === matched[1])) return null;
  const target = path.resolve(UPLOAD_ROOT, matched[1], matched[2]);
  return target.startsWith(`${UPLOAD_ROOT}${path.sep}`) ? target : null;
}
async function removeStoredUpload(value) {
  const target = resolveStoredUploadPath(value);
  if (!target) return;
  try { await fs.promises.unlink(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
module.exports = { uploads, UPLOAD_ROOT, policyFor, signatureType, validateContent, saveValidatedBuffer, resolveStoredUploadPath, removeStoredUpload };
