/**
 * GET /api/traffic — is live traffic available?
 *
 * The map asks once, so the traffic button and legend can say plainly "no
 * traffic source" instead of drawing an empty layer that looks like clear
 * roads everywhere.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const available = Boolean(process.env.TOMTOM_API_KEY?.trim());

  return Response.json(
    {
      available,
      source: available ? "tomtom" : null,
      note: available
        ? null
        : "No TOMTOM_API_KEY is configured, so there is no live traffic. Roads are not coloured.",
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
