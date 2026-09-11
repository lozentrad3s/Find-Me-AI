/**
 * Traffic colours — one scale for the map, the legend and the chat cards.
 *
 * The conventional traffic palette: green flowing, yellow slowing, red
 * queuing. Red is otherwise reserved for SOS in this app; congestion is the
 * one exception, because a driver reads red roads as "jammed" in every map
 * they have ever used, and fighting that convention would make the map harder
 * to read at a glance, which is the only way anyone reads it while driving.
 */

import type { CongestionLevel } from "./types";

export const TRAFFIC_COLOUR: Record<CongestionLevel, string> = {
  free: "#16a34a",
  light: "#65a30d",
  moderate: "#eab308",
  heavy: "#dc2626",
  standstill: "#7f1d1d",
  unknown: "#94a3b8",
};

export const TRAFFIC_LABEL: Record<CongestionLevel, string> = {
  free: "Clear",
  light: "Light",
  moderate: "Moderate",
  heavy: "Heavy",
  standstill: "Standstill",
  unknown: "No live data",
};
