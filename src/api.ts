// Google Health API v4 client (the successor of the Fitbit Web API).
// Reference: https://developers.google.com/health/reference/rest
// Schemas: https://health.googleapis.com/$discovery/rest?version=v4
//
// Data type IDs in paths are kebab-case (daily-resting-heart-rate); the same names in filters are
// snake_case (daily_resting_heart_rate.date); response fields are camelCase (dailyRestingHeartRate).
// int64 fields arrive as strings.

const BASE_URL = "https://health.googleapis.com/v4/users/me/dataTypes";
// Sleep and exercise are limited to 25 per page; everything else to 10,000
const MAX_PAGE_SIZE = 10000;
const SESSION_PAGE_SIZE = 25;
const MAX_PAGES = 20;
const HEART_RATE_MAX_SPAN = 14 * 24 * 60 * 60;

export type CivilDate = { year: number; month: number; day: number };
export type TimeOfDay = { hours?: number; minutes?: number; seconds?: number };
export type CivilDateTime = { date: CivilDate; time?: TimeOfDay };
export type SampleTime = { physicalTime: string; utcOffset: string; civilTime?: CivilDateTime };

export type SleepStageType = "AWAKE" | "LIGHT" | "DEEP" | "REM" | "ASLEEP" | "RESTLESS" | "SLEEP_STAGE_TYPE_UNSPECIFIED";

export type Sleep = {
  interval: {
    startTime: string;
    startUtcOffset: string;
    endTime: string;
    endUtcOffset: string;
    civilStartTime?: CivilDateTime;
    civilEndTime?: CivilDateTime;
  };
  type?: "CLASSIC" | "STAGES" | "SLEEP_TYPE_UNSPECIFIED";
  stages?: { type: SleepStageType; startTime: string; startUtcOffset: string; endTime: string; endUtcOffset: string }[];
  metadata?: { processed?: boolean; mainSleep?: boolean; nap?: boolean; manuallyEdited?: boolean; stagesStatus?: string };
  summary?: {
    minutesInSleepPeriod?: string;
    minutesAsleep?: string;
    minutesAwake?: string;
    minutesToFallAsleep?: string;
    minutesAfterWakeUp?: string;
    stagesSummary?: { type: SleepStageType; minutes?: string; count?: string }[];
  };
};

export type DailyHeartRateVariability = {
  date: CivilDate;
  averageHeartRateVariabilityMilliseconds?: number;
  deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds?: number;
  nonRemHeartRateBeatsPerMinute?: string;
  entropy?: number;
};
export type DailyRestingHeartRate = {
  date: CivilDate;
  beatsPerMinute: string;
  dailyRestingHeartRateMetadata?: { calculationMethod?: "WITH_SLEEP" | "ONLY_WITH_AWAKE_DATA" | "CALCULATION_METHOD_UNSPECIFIED" };
};
export type DailyOxygenSaturation = {
  date: CivilDate;
  averagePercentage: number;
  lowerBoundPercentage?: number;
  upperBoundPercentage?: number;
};
export type DailyRespiratoryRate = { date: CivilDate; breathsPerMinute: number };
export type DailySleepTemperatureDerivations = {
  date: CivilDate;
  nightlyTemperatureCelsius: number;
  baselineTemperatureCelsius?: number;
  relativeNightlyStddev30dCelsius?: number;
};
export type HeartRateVariability = {
  sampleTime: SampleTime;
  rootMeanSquareOfSuccessiveDifferencesMilliseconds?: number;
};
export type OxygenSaturation = { sampleTime: SampleTime; percentage: number };
type BreathingStats = { breathsPerMinute: number; standardDeviation?: number; signalToNoise?: number };
export type RespiratoryRateSleepSummary = {
  sampleTime: SampleTime;
  fullSleepStats: BreathingStats;
  deepSleepStats?: BreathingStats;
  lightSleepStats?: BreathingStats;
  remSleepStats?: BreathingStats;
};

// A reconciled data point has one field named after its data type, e.g. { sleep: {...} }
export type DataPoints = {
  sleep: Sleep;
  "daily-heart-rate-variability": DailyHeartRateVariability;
  "daily-resting-heart-rate": DailyRestingHeartRate;
  "daily-oxygen-saturation": DailyOxygenSaturation;
  "daily-respiratory-rate": DailyRespiratoryRate;
  "daily-sleep-temperature-derivations": DailySleepTemperatureDerivations;
  "heart-rate-variability": HeartRateVariability;
  "oxygen-saturation": OxygenSaturation;
  "respiratory-rate-sleep-summary": RespiratoryRateSleepSummary;
};
export type DataType = keyof DataPoints;

export type HeartRateRollup = {
  startTime: string;
  endTime: string;
  heartRate?: { beatsPerMinuteAvg?: number; beatsPerMinuteMin?: number; beatsPerMinuteMax?: number };
};
type GoogleError = {
  message?: string;
  status?: string;
  details?: { reason?: string; fieldViolations?: { field?: string; description?: string }[] }[];
};

export class GoogleHealthApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string
  ) {
    super(message);
  }
}

const snake = (dataType: string) => dataType.replaceAll("-", "_");
const camel = (dataType: string) => dataType.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
// Whole-second UTC timestamps, like the examples in the filter documentation
const timestamp = (time: string) => new Date(time).toISOString().replace(/\.\d+Z$/, "Z");

// Filter expressions (https://google.aip.dev/160) for a closed-open range. Dates are the user's
// local calendar dates (YYYY-MM-DD); times are RFC 3339 timestamps.
export const filters = {
  dailyDate: (dataType: DataType, start: string, end: string) =>
    `${snake(dataType)}.date >= "${start}" AND ${snake(dataType)}.date < "${end}"`,
  // Sleep sessions by the local date and time they ended, i.e. the night before
  sleepEnd: (start: string, end: string) =>
    `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${end}"`,
  sampleTime: (dataType: DataType, start: string, end: string) =>
    `${snake(dataType)}.sample_time.physical_time >= "${timestamp(start)}" AND ` +
    `${snake(dataType)}.sample_time.physical_time < "${timestamp(end)}"`,
};

export class GoogleHealthClient {
  constructor(private accessToken: string) {}

  // Data points from all sources (Fitbit, Pixel Watch, Health Connect apps...) merged into one
  // stream, so the same night isn't reported once per source. Newest first.
  async reconcile<T extends DataType>(dataType: T, filter: string): Promise<DataPoints[T][]> {
    const field = camel(dataType);
    const points: DataPoints[T][] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string> = {
        filter,
        pageSize: String(dataType === "sleep" ? SESSION_PAGE_SIZE : MAX_PAGE_SIZE),
      };
      if (pageToken) query.pageToken = pageToken;
      const body = await this.request<{ dataPoints?: Record<string, unknown>[]; nextPageToken?: string }>(
        "GET",
        `${dataType}/dataPoints:reconcile`,
        { query }
      );
      for (const point of body.dataPoints ?? []) {
        if (point[field]) points.push(point[field] as DataPoints[T]);
      }
      pageToken = body.nextPageToken || undefined;
      if (!pageToken) return points;
    }
    throw new Error(`Too much ${dataType} data for one request; ask for a shorter date range`);
  }

  // Heart rate aggregated into windows over a physical time range of at most 14 days. For
  // heart-rate, window size × page size must not exceed 14 days either (INVALID_ROLLUP_QUERY_DURATION),
  // so the page is sized to the windows the range needs.
  async heartRateRollUp(startTime: string, endTime: string, windowSeconds: number): Promise<HeartRateRollup[]> {
    const windows = Math.ceil((Date.parse(endTime) - Date.parse(startTime)) / 1000 / windowSeconds);
    const pageSize = Math.max(1, Math.min(windows, Math.floor(HEART_RATE_MAX_SPAN / windowSeconds), MAX_PAGE_SIZE));
    const body = await this.request<{ rollupDataPoints?: HeartRateRollup[] }>("POST", "heart-rate/dataPoints:rollUp", {
      body: { range: { startTime: timestamp(startTime), endTime: timestamp(endTime) }, windowSize: `${windowSeconds}s`, pageSize },
    });
    return body.rollupDataPoints ?? [];
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    { query, body }: { query?: Record<string, string>; body?: unknown }
  ): Promise<T> {
    const url = new URL(`${BASE_URL}/${path}`);
    if (query) url.search = new URLSearchParams(query).toString();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return (await res.json()) as T;

    // Google APIs return { error: { code, message, status, details } }, where details can hold
    // field violations (google.rpc.BadRequest) and error reasons (google.rpc.ErrorInfo)
    const error = ((await res.json().catch(() => ({}))) as { error?: GoogleError }).error;
    console.error("Google Health API request failed:", JSON.stringify({ method, path, query, body, status: res.status, error }));
    const reason = error?.status ?? res.statusText;
    const specifics = [
      error?.message,
      ...(error?.details ?? []).flatMap((d) => [
        d.reason,
        ...(d.fieldViolations ?? []).map((v) => [v.field, v.description].filter(Boolean).join(": ")),
      ]),
    ].filter(Boolean);
    const detail = specifics.length > 0 ? `: ${specifics.join("; ")}` : "";
    const messages: Record<number, string> = {
      401: "Google no longer accepts this connection's access. Disconnect and reconnect the Google Health connector in Claude's settings.",
      403: `Google Health refused access (${reason}${detail}). If a permission is missing, disconnect and reconnect the connector, and allow all the requested data on Google's consent screen.`,
      429: "Google Health API rate limit reached. Try again in a minute.",
    };
    throw new GoogleHealthApiError(
      res.status,
      reason,
      messages[res.status] ?? `Google Health API error ${res.status} ${reason} for ${path}${detail}`
    );
  }
}
