/**
 * /track/[id]?t=<token> — the live tracking page.
 *
 * This is the page someone's brother opens. It has no navigation, no account,
 * no app shell and no assistant: one map, one position, one honest status
 * line. Whoever opens this is worried, possibly driving, and needs to answer
 * one question — where are they, and are they still moving.
 *
 * Rendered as a normal page rather than inside the app so it loads fast on a
 * bad connection and works for someone who has never used Find Me.
 */

import type { Metadata } from "next";

import TrackView from "./TrackView";

/*
 * Never indexed.
 *
 * The token makes the URL unguessable, but a link pasted into a public group
 * chat can end up crawled. A live feed of where a person in danger is standing
 * must not appear in a search result.
 */
export const metadata: Metadata = {
  title: "Live location — Find Me",
  robots: { index: false, follow: false, nocache: true },
};

export default async function TrackPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const token = typeof query.t === "string" ? query.t : "";

  return <TrackView alertId={id} token={token} />;
}
