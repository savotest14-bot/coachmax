/**
 * Date/time helpers shared by the API.
 *
 * Timestamps are stored as native Mongo dates (UTC) and should be rendered by
 * clients in the viewer's timezone. Calendar dates (event/camp dates) are a
 * different value: they are represented by YYYY-MM-DD and must never be parsed
 * through the JavaScript date-only parser, which interprets them as UTC
 * midnight and can move them to the previous day in a user's timezone.
 */

const DEFAULT_TIMEZONE = process.env.APP_DEFAULT_TIMEZONE || "Australia/Sydney";
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDateOnly(value) {
  return typeof value === "string" && DATE_ONLY_PATTERN.test(value.trim());
}

function dateOnly(value, fieldName = "date") {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "string" && /^(\d{4}-\d{2}-\d{2})(?:$|T|\s)/.test(value.trim())) {
    // For calendar-date fields, preserve the date prefix even if a client
    // sends an ISO timestamp with an offset. Converting that timestamp first
    // would make an Australian date appear as the previous UTC day.
    const candidate = value.trim().slice(0, 10);
    const [, year, month, day] = candidate.match(DATE_ONLY_PATTERN);
    const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
    if (
      check.getUTCFullYear() !== Number(year) ||
      check.getUTCMonth() !== Number(month) - 1 ||
      check.getUTCDate() !== Number(day)
    ) {
      throw new TypeError(`${fieldName} must be a valid calendar date (YYYY-MM-DD)`);
    }
    return candidate;
  }

  if (value instanceof Date || typeof value === "string" || typeof value === "number") {
    const parsed = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }

  throw new TypeError(`${fieldName} must be a valid date or YYYY-MM-DD`);
}

/** Store a calendar date at UTC noon so legacy local formatting is less likely
 * to cross a date boundary. API responses still expose YYYY-MM-DD. */
function dateOnlyToUtc(value, fieldName = "date") {
  const normalized = dateOnly(value, fieldName);
  if (!normalized) return null;
  return new Date(`${normalized}T12:00:00.000Z`);
}

function dateOnlyStartUtc(value, fieldName = "date") {
  const normalized = dateOnly(value, fieldName);
  if (!normalized) return null;
  return new Date(`${normalized}T00:00:00.000Z`);
}

function dateOnlyEndUtc(value, fieldName = "date") {
  const normalized = dateOnly(value, fieldName);
  if (!normalized) return null;
  return new Date(`${normalized}T23:59:59.999Z`);
}

/** Convert a wall-clock time in the organisation timezone into a UTC instant. */
function zonedDateTimeToUtc(value, hour = 0, minute = 0, timeZone = DEFAULT_TIMEZONE) {
  const normalized = dateOnly(value, "date");
  if (!normalized) return null;
  const [, year, month, day] = normalized.match(DATE_ONLY_PATTERN);
  const wallClockAsUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0, 0);
  let guess = wallClockAsUtc;

  for (let i = 0; i < 4; i += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const getPart = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    const representedAsUtc = Date.UTC(
      getPart("year"),
      getPart("month") - 1,
      getPart("day"),
      getPart("hour"),
      getPart("minute")
    );
    guess += wallClockAsUtc - representedAsUtc;
  }

  return new Date(guess);
}

function dateOnlyQuery(value, fieldName = "date") {
  const normalized = dateOnly(value, fieldName);
  return {
    $gte: dateOnlyStartUtc(normalized, fieldName),
    $lte: dateOnlyEndUtc(normalized, fieldName),
  };
}

function addDateOnlyDays(value, days, fieldName = "date") {
  const normalized = dateOnly(value, fieldName);
  if (!normalized) return null;
  const parsed = new Date(`${normalized}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return parsed.toISOString().slice(0, 10);
}

function formatDateOnly(value, options = {}) {
  const normalized = dateOnly(value);
  if (!normalized) return "";
  const parsed = dateOnlyToUtc(normalized);
  return parsed.toLocaleDateString(options.locale || "en-AU", {
    timeZone: options.timeZone || DEFAULT_TIMEZONE,
    ...(options.weekday ? { weekday: options.weekday } : {}),
    day: options.day || "numeric",
    month: options.month || "short",
    year: options.year || "numeric",
  });
}

function weekdayShort(value, options = {}) {
  const normalized = dateOnly(value);
  if (!normalized) return "";
  return dateOnlyToUtc(normalized).toLocaleDateString(options.locale || "en-AU", {
    timeZone: options.timeZone || DEFAULT_TIMEZONE,
    weekday: "short",
  });
}

function formatTimestamp(value, options = {}) {
  if (!value) return "";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString(options.locale || "en-AU", {
    timeZone: options.timeZone || DEFAULT_TIMEZONE,
    dateStyle: options.dateStyle || "short",
    timeStyle: options.timeStyle || "short",
  });
}

function serializeDateOnly(value) {
  return value ? dateOnly(value) : null;
}

function serializeCampSession(session) {
  const raw = typeof session?.toObject === "function" ? session.toObject() : { ...session };
  if (raw.sessionDate) raw.sessionDate = serializeDateOnly(raw.sessionDate);
  return raw;
}

function serializeSelectedSession(session) {
  const raw = typeof session?.toObject === "function" ? session.toObject() : { ...session };
  if (raw.sessionDate) raw.sessionDate = serializeDateOnly(raw.sessionDate);
  return raw;
}

function serializeEvent(event) {
  const raw = typeof event?.toObject === "function" ? event.toObject() : { ...event };
  if (raw.startDate) raw.startDate = serializeDateOnly(raw.startDate);
  if (raw.endDate) raw.endDate = serializeDateOnly(raw.endDate);
  return raw;
}

function serializeRegistration(registration) {
  const raw = typeof registration?.toObject === "function" ? registration.toObject() : { ...registration };
  if (Array.isArray(raw.selectedSessions)) {
    raw.selectedSessions = raw.selectedSessions.map(serializeSelectedSession);
  }
  if (raw.event && typeof raw.event === "object" && !(raw.event instanceof Date)) {
    raw.event = serializeEvent(raw.event);
  }
  return raw;
}

module.exports = {
  DEFAULT_TIMEZONE,
  isDateOnly,
  dateOnly,
  dateOnlyToUtc,
  dateOnlyStartUtc,
  dateOnlyEndUtc,
  zonedDateTimeToUtc,
  dateOnlyQuery,
  addDateOnlyDays,
  formatDateOnly,
  weekdayShort,
  formatTimestamp,
  serializeDateOnly,
  serializeCampSession,
  serializeSelectedSession,
  serializeEvent,
  serializeRegistration,
};
