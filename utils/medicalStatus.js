const NEGATIVE_MEDICAL_VALUES = new Set(["", "no", "none", "nil", "n/a", "na", "not applicable", "no medical conditions", "no medical condition", "no known medical conditions", "no allergies", "no known allergies"]);

const medicalText = (value) => {
  const text = String(value == null ? "" : value).trim();
  return NEGATIVE_MEDICAL_VALUES.has(text.toLowerCase().replace(/[.!]+$/, "")) ? "" : text;
};
const medicalList = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]).map(medicalText).filter(Boolean);

function normalizeMedicalStatus(input = {}, { requireExplicit = false } = {}) {
  const rawDetails = input.medicalConditionDetails ?? input.medicalConditions;
  if ((rawDetails != null && (typeof rawDetails !== "string" || rawDetails.length > 5000)) ||
      (input.allergies != null && typeof input.allergies !== "string" && !Array.isArray(input.allergies)) ||
      (Array.isArray(input.allergies) && (input.allergies.length > 50 || input.allergies.some((value) => typeof value !== "string" || value.length > 500)))) {
    const error = new TypeError("Medical details must be text of at most 5000 characters; allergies must contain at most 50 text values");
    error.statusCode = 400;
    throw error;
  }
  const rawFlag = input.isMedicalCondition;
  let explicit;
  if ([true, "true", "YES", "yes"].includes(rawFlag)) explicit = true;
  else if ([false, "false", "NO", "no"].includes(rawFlag)) explicit = false;
  else if (rawFlag !== undefined || requireExplicit) {
    const error = new TypeError("Medical conditions must be YES or NO");
    error.statusCode = 400;
    throw error;
  }
  const conditions = medicalText(input.medicalConditionDetails ?? input.medicalConditions);
  const allergies = medicalList(input.allergies);
  const details = [conditions, allergies.length ? `Allergies: ${allergies.join(", ")}` : ""].filter(Boolean).join(" | ");
  if (explicit === false && allergies.length) {
    const error = new TypeError("Select YES and provide details when a player has allergies");
    error.statusCode = 400;
    throw error;
  }
  const isMedicalCondition = explicit ?? Boolean(details);
  if (isMedicalCondition && !details) {
    const error = new TypeError("Please provide details for medical conditions");
    error.statusCode = 400;
    throw error;
  }
  return { isMedicalCondition, medicalConditionDetails: isMedicalCondition ? details : "", medicalConditions: isMedicalCondition ? conditions : "", allergies: isMedicalCondition ? allergies : [] };
}

module.exports = { medicalText, medicalList, normalizeMedicalStatus };
