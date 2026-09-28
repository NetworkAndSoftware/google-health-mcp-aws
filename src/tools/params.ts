import { z } from "zod";
import { addDays, daysBetween, utcTomorrow } from "../health.js";

export const MAX_RANGE_DAYS = 92;

export const dateParam = (description: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
    .describe(description);

export const dateRangeParams = {
  start_date: dateParam("First date to include (YYYY-MM-DD, the user's local date). Defaults to a week before end_date.").optional(),
  end_date: dateParam("Last date to include (YYYY-MM-DD, inclusive). Defaults to today.").optional(),
};

// A range of local dates, end exclusive, for the API's closed-open filters
export function dateRange(startDate: string | undefined, endDate: string | undefined, defaultDays = 7) {
  const last = endDate ?? utcTomorrow();
  const start = startDate ?? addDays(last, -defaultDays);
  const days = daysBetween(start, last) + 1;
  if (days < 1) throw new Error("start_date must not be after end_date");
  if (days > MAX_RANGE_DAYS) throw new Error(`The date range can span at most ${MAX_RANGE_DAYS} days`);
  return { start, last, end: addDays(last, 1) };
}
