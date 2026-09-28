import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GoogleHealthClient } from "../api.js";
import {
  addDays,
  fetchDailyMetrics,
  localDateTime,
  mainSleep,
  round,
  summarizeSleep,
  textResult,
  utcTomorrow,
  type DailyMetrics,
  type MetricKey,
} from "../health.js";
import { dateParam, dateRange, dateRangeParams } from "./params.js";

// Metrics compared with their baseline, and which direction is good for recovery
const METRICS: { key: MetricKey; label: string; unit: string; digits: number; better?: "higher" | "lower" }[] = [
  { key: "hrv_ms", label: "HRV", unit: " ms", digits: 1, better: "higher" },
  { key: "resting_hr_bpm", label: "Resting heart rate", unit: " bpm", digits: 1, better: "lower" },
  { key: "sleeping_hr_bpm", label: "Sleeping heart rate", unit: " bpm", digits: 1, better: "lower" },
  { key: "spo2_pct", label: "SpO2", unit: "%", digits: 1, better: "higher" },
  { key: "breathing_rate_bpm", label: "Breathing rate", unit: " breaths/min", digits: 1 },
  { key: "skin_temp_deviation_c", label: "Skin temperature deviation", unit: " °C", digits: 2 },
  { key: "sleep_min", label: "Sleep", unit: " min", digits: 0, better: "higher" },
];
// Deviations smaller than this many standard deviations aren't flagged
const FLAG_Z = 1;
// Fewer baseline days than this give no z-score
const MIN_BASELINE_DAYS = 5;

export function registerRecoveryTools(server: McpServer, client: GoogleHealthClient) {
  server.registerTool(
    "get_recovery_metrics",
    {
      title: "Daily recovery metrics",
      description:
        "One row per day of the user's overnight recovery metrics from Fitbit or Pixel Watch, by the date " +
        "the user woke up: HRV (average RMSSD during sleep, and during deep sleep), sleeping heart rate " +
        "(average during non-REM sleep), resting heart rate, SpO2 (average and range), breathing rate, " +
        "skin temperature and its deviation from the user's baseline, and minutes asleep. " +
        "Use it for trends over days or weeks. Days without data are left out.",
      inputSchema: dateRangeParams,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ start_date, end_date }) => {
      const { start, last, end } = dateRange(start_date, end_date);
      const { days } = await fetchDailyMetrics(client, start, end);
      if (days.length === 0) return textResult({ days: [], note: `No recovery data between ${start} and ${last}.` });
      return textResult({ days });
    }
  );

  server.registerTool(
    "get_recovery_status",
    {
      title: "Recovery status",
      description:
        "How recovered the user is on a given morning: each overnight metric (HRV, resting and sleeping " +
        "heart rate, SpO2, breathing rate, skin temperature deviation, sleep) compared with the user's own " +
        "baseline over the preceding days (mean, standard deviation, z-score, 7-day average), flags for " +
        "notable deviations, and last night's sleep. " +
        "Start here when judging readiness to train.",
      inputSchema: {
        date: dateParam("The morning to assess (YYYY-MM-DD, the date the user woke up). Defaults to the latest date with data.").optional(),
        baseline_days: z.number().int().min(7).max(90).default(30).describe("How many days before date make up the baseline"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ date, baseline_days }) => {
      const last = date ?? utcTomorrow();
      // A few extra days, so the baseline is complete when the latest data is from a day or two ago
      const { days, sleep } = await fetchDailyMetrics(client, addDays(last, -baseline_days - 3), addDays(last, 1));
      const today = date ? days.find((d) => d.date === date) : days.at(-1);
      if (!today) {
        return textResult({ note: date ? `No recovery data for ${date}.` : `No recovery data in the past ${baseline_days} days.` });
      }

      const baselineStart = addDays(today.date, -baseline_days);
      const baseline = days.filter((d) => d.date >= baselineStart && d.date < today.date);
      const lastWeek = days.filter((d) => d.date > addDays(today.date, -7) && d.date <= today.date);

      const flags: string[] = [];
      const metrics: Record<string, unknown> = {};
      for (const { key, label, unit, digits, better } of METRICS) {
        const value = today[key];
        const history = values(baseline, key);
        if (value === undefined && history.length === 0) continue;

        const baselineMean = history.length > 0 ? mean(history) : undefined;
        const sd = history.length > 1 ? standardDeviation(history) : undefined;
        const z =
          value !== undefined && baselineMean !== undefined && sd && history.length >= MIN_BASELINE_DAYS
            ? (value - baselineMean) / sd
            : undefined;
        metrics[key] = {
          value,
          baseline_mean: round(baselineMean, digits),
          baseline_sd: round(sd, digits + 1),
          deviation: value !== undefined && baselineMean !== undefined ? round(value - baselineMean, digits) : undefined,
          z_score: round(z, 1),
          avg_7d: round(lastWeek.length > 0 ? mean(values(lastWeek, key)) : undefined, digits),
          baseline_days_with_data: history.length,
        };

        if (z !== undefined && Math.abs(z) >= FLAG_Z) {
          const direction = z > 0 ? "above" : "below";
          const reading = !better ? "unusual" : (z > 0) === (better === "higher") ? "favourable" : "unfavourable";
          flags.push(
            `${label} ${value}${unit} is ${round(Math.abs(z), 1)} SD ${direction} its ${history.length}-day baseline of ` +
              `${round(baselineMean, digits)}${unit} (${reading})`
          );
        }
      }

      const lastNight = mainSleep(sleep.filter((s) => localDateTime(s.interval.endTime, s.interval.endUtcOffset).startsWith(today.date)));
      return textResult({
        date: today.date,
        baseline: { from: baselineStart, to: addDays(today.date, -1) },
        flags,
        metrics,
        last_night: lastNight ? summarizeSleep(lastNight) : undefined,
      });
    }
  );
}

const values = (rows: DailyMetrics[], key: MetricKey) => rows.flatMap((row) => row[key] ?? []);
const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
function standardDeviation(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1));
}
