import React, { ChangeEvent, useEffect, useMemo, useState } from "react";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
} from "chart.js";
import { Bar, Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

export interface LabOption {
  id: string;
  label: string;
}

interface ScoreBucket {
  bucket: string;
  count: number;
}

interface TimelinePoint {
  date: string;
  submissions: number;
}

interface PassRateRow {
  task: string;
  avg_score: number;
  attempts: number;
}

interface DashboardProps {
  labs: readonly LabOption[];
  initialLabId?: string;
}

interface ApiErrorPayload {
  detail?: string;
}

async function fetchJson<T>(path: string, token: string): Promise<T> {
  const response = await fetch(path, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;

    try {
      const payload = (await response.json()) as ApiErrorPayload;
      if (typeof payload.detail === "string" && payload.detail.length > 0) {
        message = payload.detail;
      }
    } catch {
      // Ignore JSON parsing errors and keep the default message.
    }

    throw new Error(message);
  }

  return (await response.json()) as T;
}

function formatScore(value: number): string {
  return value.toFixed(2);
}

export default function Dashboard({
  labs,
  initialLabId,
}: DashboardProps): JSX.Element {
  const [selectedLabId, setSelectedLabId] = useState<string>(
    initialLabId ?? labs[0]?.id ?? "",
  );
  const [scores, setScores] = useState<ScoreBucket[]>([]);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [passRates, setPassRates] = useState<PassRateRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (labs.length === 0) {
      setSelectedLabId("");
      return;
    }

    const stillValid = labs.some((lab) => lab.id === selectedLabId);
    if (!stillValid) {
      setSelectedLabId(initialLabId ?? labs[0].id);
    }
  }, [initialLabId, labs, selectedLabId]);

  useEffect(() => {
    if (!selectedLabId) {
      setScores([]);
      setTimeline([]);
      setPassRates([]);
      return;
    }

    const tokenValue = localStorage.getItem("api_key");
    if (tokenValue === null) {
      setError("Missing API token in localStorage (api_key).");
      setScores([]);
      setTimeline([]);
      setPassRates([]);
      return;
    }

    const token: string = tokenValue;
    let cancelled = false;

    async function load(): Promise<void> {
      setLoading(true);
      setError(null);

      try {
        const encodedLab = encodeURIComponent(selectedLabId);
        const [scoresData, timelineData, passRatesData] = await Promise.all([
          fetchJson<ScoreBucket[]>(`/analytics/scores?lab=${encodedLab}`, token),
          fetchJson<TimelinePoint[]>(
            `/analytics/timeline?lab=${encodedLab}`,
            token,
          ),
          fetchJson<PassRateRow[]>(
            `/analytics/pass-rates?lab=${encodedLab}`,
            token,
          ),
        ]);

        if (cancelled) {
          return;
        }

        setScores(scoresData);
        setTimeline(timelineData);
        setPassRates(passRatesData);
      } catch (err: unknown) {
        if (cancelled) {
          return;
        }

        const message =
          err instanceof Error ? err.message : "Failed to load analytics.";
        setError(message);
        setScores([]);
        setTimeline([]);
        setPassRates([]);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [selectedLabId]);

  const scoreChartData = useMemo(() => {
    return {
      labels: scores.map((item) => item.bucket),
      datasets: [
        {
          label: "Students",
          data: scores.map((item) => item.count),
        },
      ],
    };
  }, [scores]);

  const timelineChartData = useMemo(() => {
    return {
      labels: timeline.map((item) => item.date),
      datasets: [
        {
          label: "Submissions",
          data: timeline.map((item) => item.submissions),
          fill: false,
          tension: 0.2,
        },
      ],
    };
  }, [timeline]);

  const handleLabChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    setSelectedLabId(event.target.value);
  };

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <label htmlFor="lab-select">Lab</label>
        <select
          id="lab-select"
          value={selectedLabId}
          onChange={handleLabChange}
          disabled={labs.length === 0 || loading}
        >
          {labs.map((lab) => (
            <option key={lab.id} value={lab.id}>
              {lab.label}
            </option>
          ))}
        </select>
      </div>

      {error ? <div role="alert">{error}</div> : null}
      {loading ? <div>Loading analytics…</div> : null}

      <section>
        <h2>Score buckets</h2>
        <Bar
          data={scoreChartData}
          options={{
            responsive: true,
            plugins: {
              legend: {
                display: true,
              },
              title: {
                display: false,
              },
            },
          }}
        />
      </section>

      <section>
        <h2>Submissions over time</h2>
        <Line
          data={timelineChartData}
          options={{
            responsive: true,
            plugins: {
              legend: {
                display: true,
              },
            },
          }}
        />
      </section>

      <section>
        <h2>Pass rates by task</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Task</th>
              <th style={{ textAlign: "right" }}>Average score</th>
              <th style={{ textAlign: "right" }}>Attempts</th>
            </tr>
          </thead>
          <tbody>
            {passRates.map((row) => (
              <tr key={row.task}>
                <td>{row.task}</td>
                <td style={{ textAlign: "right" }}>
                  {formatScore(row.avg_score)}
                </td>
                <td style={{ textAlign: "right" }}>{row.attempts}</td>
              </tr>
            ))}
            {passRates.length === 0 ? (
              <tr>
                <td colSpan={3}>No pass-rate data available.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
