# Find Me — resolution engine

The first buildable piece of the Find Me master document (kept private): the
part that turns *"the guest house behind the mosque on Buhari Street, Wuse"* into a
coordinate, and knows how sure it is.

Everything else in the product — navigation, sharing, safety, the marketplace — is
downstream of this working. Part VIII sets an explicit gate:

> **V0.1 exit test:** Resolve 20 real, awkwardly-described Jos addresses.
> Under 70% correct → fix the engine, build nothing else.

This repo exists to answer that question as cheaply as possible.

---

## Run it

```bash
npm install
npm run dev              # the app at localhost:3000
npm run harness          # the exit test, on fixtures
npm run harness:models   # compare parse models against the free baseline
```

**No API keys required to run.** The map, geocoding, place search and routing
all use OpenStreetMap — free, no billing account, no key. Only the AI assistant
needs `ANTHROPIC_API_KEY`; without it everything else still works and the chat
endpoint returns a clear message saying why.

| Route | What it is |
|---|---|
| `/` | The app — map, assistant, voice |
| `/inspector` | Resolution debugger: every candidate, every signal |
| `/api/resolve` | The engine as an endpoint |
| `/api/chat` | The assistant, streamed as SSE |

```bash
npm run harness -- --verbose                         # per-signal scores
npm run harness -- --json=harness-results/base.json  # baseline to diff against
```

The harness exits non-zero when the gate fails, so it can hold the line in CI.

## Choosing a model

Defaults are `claude-haiku-4-5` for both the parse step and the chat agent —
small and cheap. Whether that is good enough is a measurable question, not an
argument, so:

```bash
npm run harness:models
```

runs the same corpus once per model with places and geocoding pinned to
fixtures, so the parser is the only variable, and reports accuracy against
measured cost. **The rule-based parser is in the table as the baseline**, and it
currently scores 88% for free at 0 ms. A model that cannot beat that is not
earning its latency or its money.

Two things worth knowing before you tune:

- **Caching is the bigger lever.** The system prompt and tool definitions are
  byte-identical on every request and every loop iteration, so they carry a
  cache breakpoint. A cache read costs about a tenth of a fresh read. The
  assistant prints its own token counts and estimated cost under the composer —
  if `cached` never appears there, the prefix is too short to cache on that
  model and you are paying full price every turn.
- **`output_config.effort` is rejected by Haiku 4.5.** It is sent only to models
  that accept it (`supportsEffort` in `providers/anthropic/llm.ts`). Watch for
  this if you add another model.

## Traffic

OpenStreetMap and OSRM have **no traffic data at all**. OSRM travel times are
free-flow estimates computed from speed limits — the same number at 3am on an
empty road and 5pm on a Friday.

This matters more here than it would elsewhere. "There is moderate traffic" is
exactly the kind of plausible sentence a language model will produce unprompted,
and it sounds identical whether it was measured or invented. So:

- `NoTrafficProvider` is the default and reports `available: false`.
- The tool result carries that flag, and the system prompt requires the
  assistant to say it has no live traffic rather than characterise conditions.
- Set `TOMTOM_API_KEY` (free tier ~2,500 req/day, covers Nigerian cities) and
  the same tool starts returning real readings, sampled at five points along the
  route.

Alternative routes come free from OSRM, but note two limits: it ranks them by
*free-flow* time, so ordering says nothing about congestion, and the public demo
server often returns no alternative at all for short urban trips. Only the
primary route is sampled for traffic — each sample is an API call, so checking
every alternative would multiply the cost for a comparison the user has not
asked for yet. The assistant offers to check one instead of claiming it is
clearer.

## Why OpenStreetMap, and what it costs you

| Need | Service | Cost | Limit |
|---|---|---|---|
| Geocoding | Nominatim | free | ~1 req/sec, User-Agent required |
| Place / category search | Overpass | free | be polite |
| Routing + ETA | OSRM demo | free | no SLA — self-host before shipping |
| Tiles | OSM | free | fine for dev |

All of it is throttled and cached per host in `lib/net/throttle.ts`, because the
rate limits are licence conditions rather than performance advice.

Two things running against live OSM taught us, both of which cost nothing with
Google and everything here:

1. **The category word poisons a Nominatim query.** It matches *names*, so
   `"mosque Wuse 2 Abuja"` returns zero results while `"Wuse 2, Abuja"` returns
   several. Categories go to Overpass; text search never sees them.
2. **Long queries return nothing rather than degrading.** Google quietly relaxes
   terms until something matches. Nominatim does not, so `candidates.ts` relaxes
   them itself and stops at the first rung that returns anything.

Coverage in Nigeria is real but uneven — Abuja POIs are good, Jos is thin, and
`"Buhari Street Wuse"` is simply not in OSM. That gap is uncomfortably close to
the gap the product exists to fill, which is the argument for capturing
corrections from day one.

---

## What's here

```
src/lib/resolution/     the pipeline — parse, candidates, score, band, disambiguate, reverse
src/lib/providers/      Places / Geocoding / LLM behind interfaces, with mocks and real impls
src/lib/corpus/         40 test phrases across Jos and Abuja
src/lib/store/          the resolutions record — the address graph
src/harness/            the exit test
supabase/migrations/    0001_resolutions.sql
src/app/                Next.js: the /api/resolve endpoint and an inspector UI
```

## The pipeline

```
phrase
  │
  ├─ parse ──────────── LLM extracts structure. Returns a query, never a coordinate.
  │                     ParsedPlace has no lat/lng field — the rule is enforced by
  │                     the type, not by the prompt.
  │
  ├─ candidates ─────── independent sources in parallel:
  │                       text search · geocoder · saved · history · contacts · graph
  │                     plus the anchor hop, which is sequential by necessity:
  │                       geocode "Buhari Street, Wuse" → area centre
  │                       nearby "mosque" around it     → the anchor's real point
  │                       nearby "guest house" near that → candidates
  │
  ├─ score ──────────── 7 weighted signals. Signals that don't apply return null
  │                     and leave the denominator, so a phrase with no landmark
  │                     isn't capped into the low band.
  │
  ├─ band ───────────── score AND margin. Three Buhari Streets each score well;
  │                     the margin is what catches that as ambiguity.
  │
  ├─ disambiguate ───── one specific question, never "can you be more specific?"
  │                     Discriminators tried cheapest-first: address segment,
  │                     then name, then a landmark lookup that costs Places calls.
  │
  └─ reverse ────────── landmarks, bearings, and a sentence you can read to a
                        driver. The seed of Tell My Driver.
```

## Where it stands

Against fixtures, 40 cases across both cities:

```
pass  35    88%   right place, appropriate confidence
soft   4    98%   right place, but asked instead of committing
fail   1          "JUTH" — acronym with no alias
```

**This is not the exit test, and the harness now refuses to pretend otherwise.**

Every expectation in the corpus names a fixture place at an invented
coordinate — "Bluewiz Lodge" at 9.8493, 8.8766 exists nowhere but
`fixtures.ts`. So this measures the pipeline against data the scorer was tuned
on. It says the machinery works. It says nothing about whether the product does.

Run against live OpenStreetMap once, it scored **5%** and printed
`GATE FAILED` in exactly the same authoritative format as a real result — not
because the engine is broken, but because reality does not contain the test
data. `npm run harness` now pins the mock providers, and running `run.ts`
directly with live providers refuses outright rather than emitting a number that
looks meaningful and is not.

**The real exit test still does not exist.** It needs a corpus of ~20 addresses
collected from people in Jos, each with a human-verified coordinate. Building
that is the actual next step in Part VIII, and no amount of fixture tuning
substitutes for it.

The one failure is honest: `"JUTH"` is the local name for Jos University
Teaching Hospital and no amount of string similarity recovers it, because a
4-character acronym shares no tokens with its expansion. That is what
`place_aliases` in migration 0001 exists to fix, and until it is populated the
case stays red on purpose.

Four bugs the harness caught that reasoning had missed:

| symptom | cause |
|---|---|
| `"Jos Main Market"` margin 0.01 | a category match ("market") scored equal to a proper-name match, so every market in the city tied |
| `"the junction at Bukuru express"` scored 0.00 | `"junction"` was in the stopword list as a street-type suffix, stripping the only identifying word |
| `"somewhere in Jos"` returned a shopping mall | with nothing to search on, prominence and proximity alone still produced a confident answer |
| `"Green Palace Hotel opposite the filling station"` searched for a filling station | the parser read the *anchor's* category as the target's |

The third is the one worth dwelling on. No threshold fixes it, because the score
wasn't wrong — those really were the best candidates available. The premise was
wrong, so the engine now declines before searching when nothing identifying was
said. A city is not an identifier.

## Grading

Three outcomes, because "correct" isn't one thing:

| | meaning |
|---|---|
| **pass** | right place, and appropriately confident about it |
| **soft** | right place on top, but it asked instead of committing — one extra tap |
| **fail** | wrong place, confidently wrong, or refused something it should have resolved |

The headline is the strict pass rate. But 60% pass / 30% soft is a completely
different engine from 60% pass / 30% fail, and one number would hide that.

The corpus deliberately includes phrases that **should not** resolve —
`"somewhere in Jos"` must be declined, and `"Buhari Street, Jos"` must produce a
question rather than a confident guess. Grading only the successes would reward
an engine that guesses, which is the most damaging failure mode a product people
use to find each other can have.

---

## Swapping in real providers

Copy `.env.example` to `.env` and fill in what you have. Anything missing stays
on its mock and the harness says so in its header.

```bash
PLACES_PROVIDER=google        # needs GOOGLE_MAPS_API_KEY
GEOCODING_PROVIDER=google     # needs GOOGLE_MAPS_API_KEY
LLM_PROVIDER=anthropic        # needs ANTHROPIC_API_KEY
```

Two things to know before you do:

**The mock numbers are not the exit test.** Fixtures prove the pipeline runs.
The gate needs real Places data and real phrases from real users. Treat any
score against mocks as a smoke test.

**The rule-based parser is the baseline, not a placeholder.** If swapping in
Claude doesn't measurably beat `mock-rules` on the harness, the model isn't
earning its latency or its cost. That's a measurable question — run both.

All Places and Geocoding traffic goes through the backend (Part V, decision 1).
No provider key ever reaches a client.

---

## Tuning

`DEFAULT_WEIGHTS` in [`src/lib/resolution/score.ts`](src/lib/resolution/score.ts)
and `DEFAULT_THRESHOLDS` in [`src/lib/resolution/band.ts`](src/lib/resolution/band.ts)
are the knobs. They were set by reasoning about the domain, not by measurement —
only the harness against real addresses can say whether they're right.

Save a baseline before you touch them:

```bash
npm run harness -- --json=harness-results/before.json
# change weights
npm run harness -- --json=harness-results/after.json
```

Two weights carry the argument:

- `anchorProximity` is the heaviest at 1.2. When someone gives a landmark, it's
  usually more reliable than the street name they also gave.
- `prominence` is deliberately low at 0.3. Prominence is exactly the signal that
  buries the small guest house you're trying to find under the big hotel nearby.

---

## What this is not

Not navigation, not the map, not auth, not sharing, not SOS. Those are real and
they're in the master document — they are just downstream of a number this repo
exists to produce.

`supabase/migrations/0001_resolutions.sql` is the one piece of scope reaching
past the engine, and only because Part III, 3.3 is explicit that retrofitting it
loses every early user's corrections.
