/**
 * POST /api/incidents/[id]/confirm — "I saw this too."
 *
 * Confirmation is what turns one anonymous claim into something a person
 * should act on, so it is the number most worth protecting. Two rules, both
 * enforced below the API: one confirmation per device, and never your own
 * report.
 */

import { safetyStore } from "@/lib/safety/store";
import { reporterHash } from "@/lib/safety/reporter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    deviceId?: unknown;
  };

  const report = await safetyStore()
    .confirmIncident(id, reporterHash(request, body.deviceId))
    .catch(() => null);

  if (!report) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const { reporterHash: _hidden, ...rest } = report;
  return Response.json({ incident: rest });
}
