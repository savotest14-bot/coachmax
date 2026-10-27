const { dateOnly, dateOnlyToUtc, ageGroupContextYear } = require("./dateTime");

/** Validate the merged document, including partial date updates. */
function validatedTermData(input, current = {}) {
  const data = {};
  const merged = { ...current, ...input };
  if (typeof merged.name !== "string" || !merged.name.trim()) throw new TypeError("Term name is required");
  data.name = merged.name.trim();
  if (merged.year === null || merged.year === undefined || merged.year === "") throw new TypeError("Term year is required");
  data.year = ageGroupContextYear(merged.year);
  const start = dateOnly(merged.startDate, "Start date");
  const end = dateOnly(merged.endDate, "End date");
  if (!start || !end) throw new TypeError("Start date and end date are required");
  if (start > end) throw new TypeError("Start date cannot be after end date");
  data.startDate = dateOnlyToUtc(start);
  data.endDate = dateOnlyToUtc(end);
  for (const key of ["isEvent"]) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new TypeError(`${key} must be true or false`);
      data[key] = input[key];
    }
  }
  return data;
}

module.exports = { validatedTermData };
