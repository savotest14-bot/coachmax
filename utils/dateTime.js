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
  if (typeof value !== "string" || !DATE_ONLY_PATTERN.test(value.trim())) return false;
  try { return dateOnly(value) !== null; } catch { return false; }
}

function dateOnly(value, fieldName = "date") {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "string" && /^\d{2}\/\d{2}\/\d{4}$/.test(value.trim())) {
    const [day, month, year] = value.trim().split("/");
    return dateOnly(`${year}-${month}-${day}`, fieldName);
  }

  if (typeof value === "string" && /^(\d{4}-\d{2}-\d{2})(?:$|T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$)/.test(value.trim())) {
    const raw = value.trim();
    if (raw.includes("T")) {
      if (Number.isNaN(Date.parse(raw))) {
        throw new TypeError(`${fieldName} contains an invalid ISO timestamp`);
      }
      if (!raw.endsWith("T00:00:00.000Z") && !raw.endsWith("T00:00:00Z")) {
        const parsed = new Date(raw);
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: DEFAULT_TIMEZONE,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(parsed);
        const part = (type) => parts.find((item) => item.type === type)?.value || "";
        return `${part("year")}-${part("month")}-${part("day")}`;
      }
    }
    const candidate = raw.slice(0, 10);
    const [, year, month, day] = candidate.match(DATE_ONLY_PATTERN);
    const check = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    if (
      check.getUTCFullYear() !== Number(year) ||
      check.getUTCMonth() !== Number(month) - 1 ||
      check.getUTCDate() !== Number(day)
    ) {
      throw new TypeError(`${fieldName} must be a valid calendar date (YYYY-MM-DD)`);
    }
    return candidate;
  }

  if (value instanceof Date || typeof value === "number") {
    const parsed = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      if (parsed.getUTCHours() === 0 && parsed.getUTCMinutes() === 0 && parsed.getUTCSeconds() === 0) {
        return parsed.toISOString().slice(0, 10);
      }
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: DEFAULT_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(parsed);
      const part = (type) => parts.find((item) => item.type === type)?.value || "";
      return `${part("year")}-${part("month")}-${part("day")}`;
    }
  }

  throw new TypeError(`${fieldName} must be a valid calendar date (YYYY-MM-DD or DD/MM/YYYY)`);
}

/** Legacy Mongo Date adapter. Always serialize with dateOnly, never local time.
 * A calendar date is not an instant; UTC midnight is only its storage encoding. */
function dateOnlyToUtc(value, fieldName = "date") {
  const normalized = dateOnly(value, fieldName);
  if (!normalized) return null;
  return new Date(`${normalized}T00:00:00.000Z`);
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

function todayDateOnly(timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Inclusive calendar range for querying real timestamps in organisation time. */
function calendarTimestampRange(start, end, timeZone = DEFAULT_TIMEZONE) {
  const first = dateOnly(start, "Start date");
  const last = dateOnly(end, "End date");
  if (!first || !last || first > last) throw new TypeError("A valid ordered date range is required");
  return { $gte: zonedDateTimeToUtc(first, 0, 0, timeZone), $lt: zonedDateTimeToUtc(addDateOnlyDays(last, 1), 0, 0, timeZone) };
}

/** Convert a wall-clock time in the organisation timezone into a UTC instant. */
function zonedDateTimeToUtc(value, hour = 0, minute = 0, timeZone = DEFAULT_TIMEZONE) {
  const normalized = dateOnly(value, "date");
  if (!normalized) return null;
  if (!Number.isInteger(Number(hour)) || Number(hour) < 0 || Number(hour) > 23 ||
      !Number.isInteger(Number(minute)) || Number(minute) < 0 || Number(minute) > 59) {
    throw new TypeError("Time must contain an hour from 00 to 23 and minute from 00 to 59");
  }
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

  const resolved = new Date(guess);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(resolved);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  if (`${part("year")}-${part("month")}-${part("day")}` !== normalized || Number(part("hour")) !== Number(hour) || Number(part("minute")) !== Number(minute)) {
    throw new TypeError("The selected local time does not exist in this timezone");
  }
  return resolved;
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
  if (!Number.isInteger(Number(days))) throw new TypeError("Days must be a whole number");
  const parsed = new Date(`${normalized}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return parsed.toISOString().slice(0, 10);
}

function formatDateOnly(value, options = {}) {
  const normalized = dateOnly(value);
  if (!normalized) return "";
  const [year, month, day] = normalized.split("-");
  const date = `${day}/${month}/${year}`;
  const weekday = options.weekday ? dateOnlyToUtc(normalized).toLocaleDateString(options.locale || "en-GB", { timeZone: "UTC", weekday: options.weekday }) : "";
  if (weekday && !options.day && !options.month && !options.year) return weekday;
  return weekday ? `${weekday} ${date}` : date;
}

function weekdayShort(value, options = {}) {
  const normalized = dateOnly(value);
  if (!normalized) return "";
  return dateOnlyToUtc(normalized).toLocaleDateString(options.locale || "en-AU", {
    timeZone: "UTC",
    weekday: "short",
  });
}

function formatTimestamp(value, options = {}) {
  if (!value) return "";
  if (typeof value === "string" && (DATE_ONLY_PATTERN.test(value.trim()) || /^\d{2}\/\d{2}\/\d{4}$/.test(value.trim()))) return formatDateOnly(value, options);
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  if (!options.dateStyle && !options.timeStyle) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: options.timeZone || DEFAULT_TIMEZONE,
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(parsed);
    const part = (type) => parts.find((item) => item.type === type)?.value || "";
    return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
  }
  return parsed.toLocaleString(options.locale || "en-AU", {
    timeZone: options.timeZone || DEFAULT_TIMEZONE,
    dateStyle: options.dateStyle || "short",
    timeStyle: options.timeStyle || "short",
  });
}

function serializeDateOnly(value) {
  return value ? dateOnly(value) : null;
}

function ageGroupContextYear(termYear) {
  if (termYear !== undefined && termYear !== null && termYear !== "") {
    const year = Number(termYear);
    if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new TypeError("Age group year must be a valid four-digit year");
    return year;
  }
  return Number(new Intl.DateTimeFormat("en", { timeZone: DEFAULT_TIMEZONE, year: "numeric" }).format(new Date()));
}

function ageGroupForYear(dob, contextYear) {
  if (!dob) return null;
  const born = dateOnly(dob, "Date of birth");
  const age = ageGroupContextYear(contextYear) - Number(born.slice(0, 4));
  return age >= 0 ? age : null;
}

function ageGroupDobRange(minAge, maxAge = minAge, contextYear) {
  const year = ageGroupContextYear(contextYear);
  if (![minAge, maxAge].every((age) => Number.isInteger(age) && age >= 0 && age <= 150) || minAge > maxAge) {
    throw new TypeError("Invalid age group range");
  }
  return { $gte: dateOnlyStartUtc(`${year - maxAge}-01-01`), $lt: dateOnlyStartUtc(`${year - minAge + 1}-01-01`) };
}

function parseAgeGroupRange(value) {
  const text = String(value || "").trim();
  const match = text.match(/^U?(\d{1,3})(?:\s*[-–]\s*U?(\d{1,3})|\s*\+)?$/i);
  if (!match) return null;
  const minAge = Number(match[1]);
  const maxAge = text.endsWith("+") ? 150 : Number(match[2] || match[1]);
  if (minAge > maxAge || maxAge > 150) throw new TypeError("Invalid age group range");
  return { minAge, maxAge };
}

function serializeTerm(term) {
  if (!term) return null;
  const raw = typeof term.toObject === "function" ? term.toObject() : { ...term };
  for (const field of ["startDate", "endDate", "registrationStart", "registrationEnd"]) {
    if (raw[field]) raw[field] = serializeDateOnly(raw[field]);
  }
  return raw;
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
  todayDateOnly,
  calendarTimestampRange,
  zonedDateTimeToUtc,
  dateOnlyQuery,
  addDateOnlyDays,
  formatDateOnly,
  weekdayShort,
  formatTimestamp,
  serializeDateOnly,
  serializeTerm,
  ageGroupContextYear,
  ageGroupForYear,
  ageGroupDobRange,
  parseAgeGroupRange,
  serializeCampSession,
  serializeSelectedSession,
  serializeEvent,
  serializeRegistration,
};
