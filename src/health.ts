import { filters, type CivilDate, type GoogleHealthClient, type Sleep, type SleepStageType } from "./api.js";

// Shapes Google Health data for the tools: one summary per sleep session, and one row of
// recovery metrics per day. Dates are the user's local calendar dates; nightly metrics belong to
// the date the user woke up, as in the Fitbit app.

// --- Dates -----------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDate = (d: CivilDate) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;

export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// The server runs in UTC, so this is a day ahead of the user's date in the evening in the
// Americas. Used as a default end date, where a day too many only means no data for it yet.
export const utcTomorrow = () => addDays(new Date().toISOString().slice(0, 10), 1);

// Wall-clock time where the user was, from a timestamp and the offset Google reports with it
// ("-25200s"): "2026-09-27 06:48"
export function localDateTime(timestamp: string, utcOffset: string): string {
  const ms = Date.parse(timestamp) + parseFloat(utcOffset) * 1000;
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

export const round = (value: number | undefined, digits = 0) =>
  value === undefined || Number.isNaN(value) ? undefined : Math.round(value * 10 ** digits) / 10 ** digits;

const toNumber = (value: string | number | undefined) => (value === undefined ? undefined : Number(value));

// --- Sleep -----------------------------------------------------------------------------------

export type SleepSummary = {
  date: string;
  bedtime: string;
  wake_time: string;
  main_sleep?: boolean;
  nap?: boolean;
  type?: string;
  time_in_bed_min: number;
  asleep_min?: number;
  awake_min?: number;
  efficiency_pct?: number;
  fall_asleep_min?: number;
  awake_after_wakeup_min?: number;
  stages_min?: Record<string, number>;
  stages_pct_of_sleep?: Record<string, number>;
  awakenings?: number;
  note?: string;
  stages?: { stage: string; start: string; min: number }[];
};

const stageName = (type: SleepStageType) => type.toLowerCase();
const SLEEP_STAGES = new Set<SleepStageType>(["LIGHT", "DEEP", "REM", "ASLEEP"]);

export function summarizeSleep(sleep: Sleep, { includeStages = false } = {}): SleepSummary {
  const { interval, summary, metadata } = sleep;
  const wakeTime = localDateTime(interval.endTime, interval.endUtcOffset);
  const timeInBed =
    toNumber(summary?.minutesInSleepPeriod) ?? Math.round((Date.parse(interval.endTime) - Date.parse(interval.startTime)) / 60_000);
  const asleep = toNumber(summary?.minutesAsleep);

  const stagesMin: Record<string, number> = {};
  const stagesPct: Record<string, number> = {};
  let awakenings: number | undefined;
  for (const stage of summary?.stagesSummary ?? []) {
    if (stage.type === "SLEEP_STAGE_TYPE_UNSPECIFIED") continue;
    const minutes = toNumber(stage.minutes) ?? 0;
    stagesMin[stageName(stage.type)] = minutes;
    if (asleep && SLEEP_STAGES.has(stage.type)) stagesPct[stageName(stage.type)] = Math.round((minutes / asleep) * 100);
    if (stage.type === "AWAKE") awakenings = toNumber(stage.count);
  }

  const notes: string[] = [];
  if (metadata?.processed === false) notes.push("still being processed; figures may change");
  if (sleep.type !== "STAGES" && metadata?.stagesStatus && metadata.stagesStatus !== "SUCCEEDED") {
    notes.push(`no sleep stages (${metadata.stagesStatus})`);
  }
  if (metadata?.manuallyEdited) notes.push("edited by the user");

  return {
    date: wakeTime.slice(0, 10),
    bedtime: localDateTime(interval.startTime, interval.startUtcOffset),
    wake_time: wakeTime,
    main_sleep: metadata?.mainSleep,
    nap: metadata?.nap || undefined,
    type: sleep.type === "SLEEP_TYPE_UNSPECIFIED" ? undefined : sleep.type?.toLowerCase(),
    time_in_bed_min: timeInBed,
    asleep_min: asleep,
    awake_min: toNumber(summary?.minutesAwake),
    efficiency_pct: asleep !== undefined && timeInBed > 0 ? Math.round((asleep / timeInBed) * 100) : undefined,
    // Always 0 for sleep the watch detected (it starts when you fall asleep), so only shown otherwise
    fall_asleep_min: toNumber(summary?.minutesToFallAsleep) || undefined,
    awake_after_wakeup_min: toNumber(summary?.minutesAfterWakeUp) || undefined,
    stages_min: Object.keys(stagesMin).length > 0 ? stagesMin : undefined,
    stages_pct_of_sleep: Object.keys(stagesPct).length > 0 ? stagesPct : undefined,
    awakenings,
    note: notes.length > 0 ? notes.join("; ") : undefined,
    stages: includeStages
      ? (sleep.stages ?? [])
          .toSorted((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
          .map((stage) => ({
            stage: stageName(stage.type),
            start: localDateTime(stage.startTime, stage.startUtcOffset).slice(11),
            min: Math.round((Date.parse(stage.endTime) - Date.parse(stage.startTime)) / 60_000),
          }))
      : undefined,
  };
}

// Sleep sessions that ended on the dates start..end (end exclusive), oldest first
export async function fetchSleep(client: GoogleHealthClient, start: string, end: string): Promise<Sleep[]> {
  const sessions = await client.reconcile("sleep", filters.sleepEnd(start, end));
  return sessions.toSorted((a, b) => Date.parse(a.interval.startTime) - Date.parse(b.interval.startTime));
}

// The night's sleep among sessions that ended on the same date: the one Google marks as main
// sleep, else the longest
export function mainSleep(sessions: Sleep[]): Sleep | undefined {
  const minutes = (s: Sleep) => toNumber(s.summary?.minutesAsleep) ?? 0;
  return sessions.find((s) => s.metadata?.mainSleep) ?? sessions.toSorted((a, b) => minutes(b) - minutes(a))[0];
}

// --- Daily recovery metrics ------------------------------------------------------------------

export type DailyMetrics = {
  date: string;
  hrv_ms?: number;
  hrv_deep_sleep_ms?: number;
  sleeping_hr_bpm?: number;
  resting_hr_bpm?: number;
  spo2_pct?: number;
  spo2_low_pct?: number;
  spo2_high_pct?: number;
  breathing_rate_bpm?: number;
  skin_temp_c?: number;
  skin_temp_deviation_c?: number;
  sleep_min?: number;
};

export type MetricKey = Exclude<keyof DailyMetrics, "date">;

// Rows for the dates start..end (end exclusive) that have any data, oldest first, plus the
// sleep sessions they were computed from
export async function fetchDailyMetrics(
  client: GoogleHealthClient,
  start: string,
  end: string
): Promise<{ days: DailyMetrics[]; sleep: Sleep[] }> {
  const [hrv, restingHr, spo2, breathing, temperature, sleep] = await Promise.all([
    client.reconcile("daily-heart-rate-variability", filters.dailyDate("daily-heart-rate-variability", start, end)),
    client.reconcile("daily-resting-heart-rate", filters.dailyDate("daily-resting-heart-rate", start, end)),
    client.reconcile("daily-oxygen-saturation", filters.dailyDate("daily-oxygen-saturation", start, end)),
    client.reconcile("daily-respiratory-rate", filters.dailyDate("daily-respiratory-rate", start, end)),
    client.reconcile("daily-sleep-temperature-derivations", filters.dailyDate("daily-sleep-temperature-derivations", start, end)),
    fetchSleep(client, start, end),
  ]);

  const days = new Map<string, DailyMetrics>();
  const day = (date: CivilDate | string) => {
    const iso = typeof date === "string" ? date : isoDate(date);
    let row = days.get(iso);
    if (!row) days.set(iso, (row = { date: iso }));
    return row;
  };

  for (const point of hrv) {
    Object.assign(day(point.date), {
      hrv_ms: round(point.averageHeartRateVariabilityMilliseconds, 1),
      hrv_deep_sleep_ms: round(point.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds, 1),
      sleeping_hr_bpm: toNumber(point.nonRemHeartRateBeatsPerMinute),
    });
  }
  for (const point of restingHr) day(point.date).resting_hr_bpm = toNumber(point.beatsPerMinute);
  for (const point of spo2) {
    Object.assign(day(point.date), {
      spo2_pct: round(point.averagePercentage, 1),
      spo2_low_pct: round(point.lowerBoundPercentage, 1),
      spo2_high_pct: round(point.upperBoundPercentage, 1),
    });
  }
  for (const point of breathing) day(point.date).breathing_rate_bpm = round(point.breathsPerMinute, 1);
  for (const point of temperature) {
    Object.assign(day(point.date), {
      skin_temp_c: round(point.nightlyTemperatureCelsius, 2),
      skin_temp_deviation_c:
        point.baselineTemperatureCelsius === undefined
          ? undefined
          : round(point.nightlyTemperatureCelsius - point.baselineTemperatureCelsius, 2),
    });
  }

  const sessionsByDate = new Map<string, Sleep[]>();
  for (const session of sleep) {
    const date = localDateTime(session.interval.endTime, session.interval.endUtcOffset).slice(0, 10);
    sessionsByDate.set(date, [...(sessionsByDate.get(date) ?? []), session]);
  }
  for (const [date, sessions] of sessionsByDate) {
    const minutes = toNumber(mainSleep(sessions)?.summary?.minutesAsleep);
    if (minutes !== undefined) day(date).sleep_min = minutes;
  }

  const rows = [...days.values()]
    .filter((row) => row.date >= start && row.date < end)
    .toSorted((a, b) => a.date.localeCompare(b.date));
  return { days: rows, sleep };
}

// --- Output ----------------------------------------------------------------------------------

// JSON with one array element per line: readable, without spending tokens on indentation
export function toJson(value: unknown, indent = ""): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== "object")) return JSON.stringify(value);
    return `[\n${value.map((item) => inner + JSON.stringify(item)).join(",\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${toJson(v, inner)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

export const textResult = (value: unknown) => ({ content: [{ type: "text" as const, text: toJson(value) }] });
