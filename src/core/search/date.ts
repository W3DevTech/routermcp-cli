// Generated from https://github.com/W3DevTech/routermcp.git@fef976aebacb05d5a2f4cfeac602fea7e89c4d8a:packages/search/src/date.ts. Do not edit.
import { type SearchDateBound, SearchError, type SourceSpan } from "./types";

/** Validate a date-only or offset-bearing ISO timestamp and return its canonical UTC value. */
export function parseDateBound(value: string, span?: SourceSpan): SearchDateBound {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (dateMatch) {
    const [, yearText, monthText, dayText] = dateMatch;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = makeUtcDate(year, month, day, 0, 0, 0);
    if (year === 0 || !sameDate(date, year, month, day)) throw invalidDate(value, span);
    return {
      input: value,
      value: `${yearText}-${monthText}-${dayText}T00:00:00Z`,
      kind: "date",
      epochSeconds: date.getTime() / 1_000,
      nanosecond: 0,
    };
  }

  const timestampMatch =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/iu.exec(
      value,
    );
  if (!timestampMatch) throw invalidDate(value, span);

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction = "",
    offsetText,
  ] = timestampMatch;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const base = makeUtcDate(year, month, day, hour, minute, second);
  if (year === 0 || !sameDate(base, year, month, day)) throw invalidDate(value, span);

  const offsetMinutes = parseOffset(offsetText ?? "Z", span, value);
  base.setTime(base.getTime() - offsetMinutes * 60_000);
  const epochSeconds = Math.floor(base.getTime() / 1_000);
  const nanosecond = Number(fraction.padEnd(9, "0"));
  const utc = base.toISOString().replace(/\.\d{3}Z$/u, "");
  const canonicalFraction = fraction.replace(/0+$/u, "");
  return {
    input: value,
    value: `${utc}${canonicalFraction ? `.${canonicalFraction}` : ""}Z`,
    kind: "timestamp",
    epochSeconds,
    nanosecond,
  };
}

export function compareDateBounds(left: SearchDateBound, right: SearchDateBound): number {
  if (left.epochSeconds !== right.epochSeconds)
    return left.epochSeconds < right.epochSeconds ? -1 : 1;
  if (left.nanosecond === right.nanosecond) return 0;
  return left.nanosecond < right.nanosecond ? -1 : 1;
}

function parseOffset(offset: string, span: SourceSpan | undefined, value: string): number {
  if (offset.toUpperCase() === "Z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(offset);
  if (!match) throw invalidDate(value, span);
  const [, sign, hourText, minuteText] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (minute > 59 || hour > 14 || (hour === 14 && minute !== 0)) throw invalidDate(value, span);
  const minutes = hour * 60 + minute;
  return sign === "+" ? minutes : -minutes;
}

function makeUtcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}

function sameDate(date: Date, year: number, month: number, day: number): boolean {
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
  );
}

function invalidDate(value: string, span?: SourceSpan): SearchError {
  return new SearchError(
    "INVALID_DATE",
    `Invalid date bound ${JSON.stringify(value)}; use YYYY-MM-DD or an ISO timestamp with an explicit offset.`,
    span,
  );
}
