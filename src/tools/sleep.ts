import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { filters, type GoogleHealthClient, type SampleTime } from "../api.js";
import { addDays, fetchSleep, localDateTime, mainSleep, round, summarizeSleep, textResult, utcTomorrow } from "../health.js";
import { dateParam, dateRange, dateRangeParams } from "./params.js";

const HOUR = 3_600_000;
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

export function registerSleepTools(server: McpServer, client: GoogleHealthClient) {
  server.registerTool(
    "get_sleep",
    {
      title: "Sleep sessions",
      description:
        "Sleep sessions recorded by the user's Fitbit or Pixel Watch, listed by the date the user woke up: " +
        "bedtime, wake time, time in bed, time asleep and awake, sleep efficiency, time to fall asleep, " +
        "number of awakenings, and minutes (and % of sleep) in deep, light and REM sleep. " +
        "Naps are included and flagged; main_sleep marks the night's sleep. " +
        "Set include_stages for the stage-by-stage timeline.",
      inputSchema: {
        ...dateRangeParams,
        include_stages: z
          .boolean()
          .default(false)
          .describe("Include each session's timeline of sleep stages (start time and minutes of each stage)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ start_date, end_date, include_stages }) => {
      const { start, last, end } = dateRange(start_date, end_date);
      const sessions = await fetchSleep(client, start, end);
      if (sessions.length === 0) return textResult({ sleep: [], note: `No sleep recorded that ended between ${start} and ${last}.` });
      return textResult({ sleep: sessions.map((s) => summarizeSleep(s, { includeStages: include_stages })) });
    }
  );

  server.registerTool(
    "get_night_detail",
    {
      title: "Overnight detail",
      description:
        "Minute-level detail of one night's main sleep: sleep stages, heart rate, HRV (RMSSD) and SpO2 in " +
        "time buckets across the night, with the night's average and lowest heart rate (lowest bucket " +
        "average), average HRV, SpO2 average and minimum, and breathing rate per sleep stage. " +
        "Use it to look into a single night; use get_recovery_metrics for trends.",
      inputSchema: {
        date: dateParam("The date the user woke up (YYYY-MM-DD). Defaults to the most recent night.").optional(),
        resolution_minutes: z.number().int().min(1).max(30).default(5).describe("Bucket size in minutes"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ date, resolution_minutes }) => {
      const { start, end } = date ? dateRange(date, date) : { start: addDays(utcTomorrow(), -7), end: addDays(utcTomorrow(), 1) };
      const sessions = await fetchSleep(client, start, end);
      // The last night's sessions, when no date was given
      const wakeDate = date ?? (sessions.length > 0 ? summarizeSleep(sessions.at(-1)!).date : undefined);
      const night = mainSleep(sessions.filter((s) => summarizeSleep(s).date === wakeDate));
      if (!night) {
        return textResult({ note: date ? `No sleep recorded that ended on ${date}.` : "No sleep recorded in the past week." });
      }

      const { startTime, endTime, startUtcOffset } = night.interval;
      const sessionStart = Date.parse(startTime);
      const bucketMs = resolution_minutes * 60_000;
      // Each stream is optional: one failing (or missing for this device) leaves the others
      const unavailable: Record<string, string> = {};
      const settle = async <T>(name: string, request: Promise<T[]>): Promise<T[]> => {
        try {
          return await request;
        } catch (error) {
          unavailable[name] = error instanceof Error ? error.message : String(error);
          return [];
        }
      };
      const [heartRate, hrv, spo2, breathing] = await Promise.all([
        settle("heart_rate", client.heartRateRollUp(startTime, endTime, resolution_minutes * 60)),
        settle("hrv", client.reconcile("heart-rate-variability", filters.sampleTime("heart-rate-variability", startTime, endTime))),
        settle("spo2", client.reconcile("oxygen-saturation", filters.sampleTime("oxygen-saturation", startTime, endTime))),
        // One summary per sleep session, timed at an unspecified moment around it
        settle(
          "breathing_rate",
          client.reconcile(
            "respiratory-rate-sleep-summary",
            filters.sampleTime(
              "respiratory-rate-sleep-summary",
              new Date(sessionStart - 2 * HOUR).toISOString(),
              new Date(Date.parse(endTime) + 2 * HOUR).toISOString()
            )
          )
        ),
      ]);

      type Bucket = { time: string; stage?: string; hr?: number; hr_min?: number; hrv_ms?: number; spo2_pct?: number };
      const buckets: Bucket[] = [];
      const bucketCount = Math.ceil((Date.parse(endTime) - sessionStart) / bucketMs);
      for (let i = 0; i < bucketCount; i++) {
        buckets.push({ time: localDateTime(new Date(sessionStart + i * bucketMs).toISOString(), startUtcOffset).slice(11) });
      }
      const bucketAt = (timestamp: string) => buckets[Math.floor((Date.parse(timestamp) - sessionStart) / bucketMs)];

      // Stage at the middle of each bucket (the last bucket can end after the session does)
      const stages = (night.stages ?? []).map((s) => ({ type: s.type, from: Date.parse(s.startTime), to: Date.parse(s.endTime) }));
      buckets.forEach((bucket, i) => {
        const middle = Math.min(sessionStart + (i + 0.5) * bucketMs, Date.parse(endTime) - 1);
        bucket.stage = stages.find((s) => s.from <= middle && middle < s.to)?.type.toLowerCase();
      });

      for (const window of heartRate) {
        const bucket = bucketAt(window.startTime);
        if (!bucket || window.heartRate?.beatsPerMinuteAvg === undefined) continue;
        bucket.hr = round(window.heartRate.beatsPerMinuteAvg);
        bucket.hr_min = round(window.heartRate.beatsPerMinuteMin);
      }
      const averageInto = <T extends { sampleTime: SampleTime }>(
        samples: T[],
        value: (sample: T) => number | undefined,
        field: "hrv_ms" | "spo2_pct"
      ) => {
        const sums = new Map<Bucket, number[]>();
        for (const sample of samples) {
          const bucket = bucketAt(sample.sampleTime.physicalTime);
          const v = value(sample);
          if (bucket && v !== undefined) sums.set(bucket, [...(sums.get(bucket) ?? []), v]);
        }
        for (const [bucket, values] of sums) bucket[field] = round(mean(values), 1);
      };
      averageInto(hrv, (s) => s.rootMeanSquareOfSuccessiveDifferencesMilliseconds, "hrv_ms");
      averageInto(spo2, (s) => s.percentage, "spo2_pct");

      const hrBuckets = buckets.filter((b) => b.hr !== undefined);
      const lowest = hrBuckets.toSorted((a, b) => a.hr! - b.hr!)[0];
      const hrvValues = hrv.flatMap((s) => s.rootMeanSquareOfSuccessiveDifferencesMilliseconds ?? []);
      const spo2Values = spo2.map((s) => s.percentage);
      const nightMiddle = (sessionStart + Date.parse(endTime)) / 2;
      const breathingSummary = breathing.toSorted(
        (a, b) =>
          Math.abs(Date.parse(a.sampleTime.physicalTime) - nightMiddle) - Math.abs(Date.parse(b.sampleTime.physicalTime) - nightMiddle)
      )[0];

      return textResult({
        night: summarizeSleep(night),
        heart_rate:
          hrBuckets.length > 0
            ? {
                average_bpm: round(mean(hrBuckets.map((b) => b.hr!))),
                [`lowest_${resolution_minutes}min_average_bpm`]: lowest?.hr,
                lowest_at: lowest?.time,
                minimum_bpm: round(Math.min(...hrBuckets.map((b) => b.hr_min ?? b.hr!))),
              }
            : undefined,
        hrv: hrvValues.length > 0 ? { average_rmssd_ms: round(mean(hrvValues), 1), samples: hrvValues.length } : undefined,
        spo2:
          spo2Values.length > 0
            ? {
                average_pct: round(mean(spo2Values), 1),
                minimum_pct: round(Math.min(...spo2Values), 1),
                pct_of_samples_below_90: Math.round((spo2Values.filter((v) => v < 90).length / spo2Values.length) * 100),
              }
            : undefined,
        // Google reports 0 for a stage it couldn't compute a rate for
        breathing_rate_bpm: breathingSummary
          ? {
              full_night: round(breathingSummary.fullSleepStats?.breathsPerMinute || undefined, 1),
              deep: round(breathingSummary.deepSleepStats?.breathsPerMinute || undefined, 1),
              light: round(breathingSummary.lightSleepStats?.breathsPerMinute || undefined, 1),
              rem: round(breathingSummary.remSleepStats?.breathsPerMinute || undefined, 1),
            }
          : undefined,
        unavailable: Object.keys(unavailable).length > 0 ? unavailable : undefined,
        timeline: buckets,
      });
    }
  );
}
