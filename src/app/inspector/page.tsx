"use client";

/**
 * Resolution inspector — a development instrument, not the product.
 *
 * It shows the engine's working: parsed components, every candidate, every
 * signal. That exists because "it picked the wrong Buhari Street" is not
 * actionable, whereas "areaMatch scored 0.31 because the parser never
 * extracted the area" tells you exactly what to fix.
 *
 * The app itself is at /.
 */

import Link from "next/link";
import { useState } from "react";
import type { ResolutionResult } from "@/lib/resolution/types";

const EXAMPLES = [
  "the guest house behind the mosque on Buhari Street, Wuse",
  "Green Palace Hotel opposite the filling station, Farin Gada",
  "Buhari Street, Jos",
  "that place beside the bank in Rayfield",
  "somewhere in Jos",
];

const BAND_TOKEN = {
  high: "var(--band-high)",
  moderate: "var(--band-moderate)",
  low: "var(--band-low)",
} as const;

export default function InspectorPage() {
  const [phrase, setPhrase] = useState(EXAMPLES[0] ?? "");
  const [city, setCity] = useState<"jos" | "abuja">("abuja");
  const [result, setResult] = useState<ResolutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function resolve(nextPhrase: string) {
    if (!nextPhrase.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase: nextPhrase, city }),
      });

      const payload: unknown = await response.json();

      if (!response.ok) {
        const message =
          typeof payload === "object" && payload !== null && "error" in payload
            ? String((payload as { error: unknown }).error)
            : "Resolution failed.";
        setError(message);
        setResult(null);
        return;
      }

      setResult(payload as ResolutionResult);
    } catch {
      setError("Could not reach the resolver.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={s.main}>
      <header style={s.header}>
        <div>
          <h1 style={s.h1}>Resolution inspector</h1>
          <p style={s.sub}>
            Describe a place the way you would say it aloud. Every candidate and
            signal is shown.
          </p>
        </div>
        <Link href="/" style={s.back}>
          Open the app
        </Link>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void resolve(phrase);
        }}
        style={s.form}
      >
        <input
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
          style={s.input}
          aria-label="Place description"
        />
        <select
          value={city}
          onChange={(event) => setCity(event.target.value as "jos" | "abuja")}
          style={s.select}
          aria-label="City"
        >
          <option value="abuja">Abuja</option>
          <option value="jos">Jos</option>
        </select>
        <button type="submit" disabled={loading} style={s.button}>
          {loading ? "Resolving…" : "Resolve"}
        </button>
      </form>

      <div style={s.examples}>
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => {
              setPhrase(example);
              void resolve(example);
            }}
            style={s.chip}
          >
            {example}
          </button>
        ))}
      </div>

      {error && <p style={s.error}>{error}</p>}

      {result && (
        <section>
          <div style={{ ...s.bandBar, borderColor: BAND_TOKEN[result.band.band] }}>
            <strong style={{ color: BAND_TOKEN[result.band.band] }}>
              {result.band.band.toUpperCase()}
            </strong>
            <span style={s.dim}>{result.band.rationale}</span>
          </div>

          {result.best && (
            <div style={s.best}>
              <h2 style={s.h2}>{result.best.candidate.name}</h2>
              <p style={s.address}>{result.best.candidate.formattedAddress}</p>
              <p style={s.mono}>
                {result.best.candidate.point.lat.toFixed(6)},{" "}
                {result.best.candidate.point.lng.toFixed(6)}
                <span style={s.dim}>
                  {" · "}
                  {result.best.score.toFixed(2)} via {result.best.candidate.source}
                </span>
              </p>
              {result.best.reasons.length > 0 && (
                <p style={s.reasons}>{result.best.reasons.join(" · ")}</p>
              )}
            </div>
          )}

          {result.question && (
            <div style={s.question}>
              <p style={{ margin: "0 0 8px", fontWeight: 550 }}>
                {result.question.question}
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {result.question.options.map((option) => (
                  <li key={option.candidateId} style={{ fontSize: 14 }}>
                    <strong>{option.label}</strong>
                    <span style={s.dim}> — {option.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.reverse && (
            <div style={s.driver}>
              <h3 style={s.h3}>Tell the driver</h3>
              <p style={{ margin: 0 }}>
                &ldquo;{result.reverse.driverInstruction}&rdquo;
              </p>
            </div>
          )}

          <details style={s.details} open>
            <summary style={s.summary}>Parsed components</summary>
            <div style={s.pillRow}>
              {(
                [
                  ["name", result.parsed.placeName],
                  ["type", result.parsed.placeType],
                  ["street", result.parsed.street],
                  ["area", result.parsed.area],
                  ["city", result.parsed.city],
                  ["number", result.parsed.houseNumber],
                ] as const
              )
                .filter(([, value]) => value)
                .map(([key, value]) => (
                  <span key={key} style={s.pill}>
                    <span style={s.dim}>{key}</span> {value}
                  </span>
                ))}
            </div>

            {result.parsed.landmarkRelations.length > 0 && (
              <div style={s.pillRow}>
                {result.parsed.landmarkRelations.map((relation, index) => (
                  <span key={`${relation.type}-${index}`} style={s.relationPill}>
                    {relation.type.replace(/_/g, " ")}{" "}
                    <strong>{relation.anchor}</strong>
                  </span>
                ))}
              </div>
            )}

            {result.parsed.ambiguityNotes.map((note) => (
              <p key={note} style={s.note}>
                {note}
              </p>
            ))}
          </details>

          <details style={s.details}>
            <summary style={s.summary}>
              Candidates ({result.ranked.length})
            </summary>
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>Score</th>
                    <th style={s.th}>Place</th>
                    <th style={s.th}>Source</th>
                    <th style={s.th}>Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {result.ranked.map((entry) => (
                    <tr key={entry.candidate.id}>
                      <td style={s.td}>{entry.score.toFixed(2)}</td>
                      <td style={s.td}>
                        {entry.candidate.name}
                        <div style={s.dim}>
                          {entry.candidate.formattedAddress}
                        </div>
                      </td>
                      <td style={s.td}>{entry.candidate.source}</td>
                      <td style={s.td}>
                        {Object.entries(entry.signals)
                          .filter(([, value]) => value !== null)
                          .map(
                            ([key, value]) =>
                              `${key} ${(value as number).toFixed(2)}`,
                          )
                          .join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <p style={s.timings}>
            {Object.entries(result.timings)
              .map(([stage, ms]) => `${stage} ${ms.toFixed(0)}ms`)
              .join(" · ")}
            {" · "}
            {result.providers.places}/{result.providers.geocoding}/
            {result.providers.llm}
          </p>
        </section>
      )}
    </main>
  );
}

const s = {
  main: { maxWidth: 900, margin: "0 auto", padding: "40px 24px 80px" },
  header: {
    display: "flex",
    gap: 16,
    alignItems: "flex-start",
    marginBottom: 24,
    flexWrap: "wrap" as const,
  },
  h1: { fontSize: 24, fontWeight: 650, margin: "0 0 6px" },
  sub: { margin: 0, color: "var(--fg-muted)", maxWidth: 560 },
  back: {
    marginLeft: "auto",
    padding: "8px 14px",
    borderRadius: "var(--radius-md)",
    background: "var(--primary)",
    color: "var(--on-primary)",
    textDecoration: "none",
    fontSize: 14,
    fontWeight: 550,
    whiteSpace: "nowrap" as const,
  },
  form: { display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" as const },
  input: {
    flex: "1 1 320px",
    padding: "10px 12px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--surface)",
  },
  select: {
    padding: "10px 12px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--surface)",
  },
  button: {
    padding: "10px 18px",
    border: "none",
    borderRadius: "var(--radius-md)",
    background: "var(--primary)",
    color: "var(--on-primary)",
    fontWeight: 550,
  },
  examples: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap" as const,
    marginBottom: 24,
  },
  chip: {
    padding: "5px 10px",
    fontSize: 12.5,
    border: "1px solid var(--border-soft)",
    borderRadius: 999,
    background: "var(--surface)",
    color: "var(--fg-muted)",
  },
  error: { color: "var(--danger)", fontWeight: 500 },
  bandBar: {
    display: "flex",
    gap: 12,
    alignItems: "baseline",
    padding: "10px 14px",
    borderLeft: "4px solid",
    background: "var(--surface)",
    borderRadius: "0 var(--radius-md) var(--radius-md) 0",
    flexWrap: "wrap" as const,
  },
  best: { padding: "18px 0 6px" },
  h2: { fontSize: 20, fontWeight: 600, margin: "0 0 4px" },
  h3: { fontSize: 13, fontWeight: 600, margin: "0 0 6px", color: "var(--fg-muted)" },
  address: { margin: "0 0 4px", color: "var(--fg-muted)" },
  mono: { margin: 0, fontFamily: "ui-monospace, monospace", fontSize: 13 },
  reasons: { margin: "8px 0 0", color: "var(--band-high)", fontSize: 13.5 },
  dim: { color: "var(--fg-subtle)" },
  question: {
    margin: "16px 0",
    padding: 14,
    background: "var(--band-moderate-soft)",
    borderRadius: "var(--radius-md)",
  },
  driver: {
    margin: "16px 0",
    padding: 14,
    background: "var(--primary-soft)",
    borderRadius: "var(--radius-md)",
  },
  details: {
    marginTop: 16,
    borderTop: "1px solid var(--border-soft)",
    paddingTop: 12,
  },
  summary: { cursor: "pointer", fontWeight: 550, fontSize: 14 },
  pillRow: { display: "flex", gap: 6, flexWrap: "wrap" as const, marginTop: 10 },
  pill: {
    padding: "4px 9px",
    background: "var(--surface-sunken)",
    borderRadius: 6,
    fontSize: 13,
  },
  relationPill: {
    padding: "4px 9px",
    background: "var(--band-high-soft)",
    color: "var(--band-high)",
    borderRadius: 6,
    fontSize: 13,
  },
  note: { margin: "8px 0 0", fontSize: 13, color: "var(--band-moderate)" },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 },
  th: {
    textAlign: "left" as const,
    padding: "6px 8px",
    borderBottom: "1px solid var(--border)",
    color: "var(--fg-muted)",
    whiteSpace: "nowrap" as const,
  },
  td: {
    padding: 8,
    borderBottom: "1px solid var(--border-soft)",
    verticalAlign: "top" as const,
  },
  timings: {
    marginTop: 18,
    fontSize: 12,
    color: "var(--fg-subtle)",
    fontFamily: "ui-monospace, monospace",
  },
} as const;
