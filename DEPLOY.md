# Deploying Find Me to Vercel

Everything below assumes you are deploying for **testing on real phones on real
networks**, which is the point — the parts of this product most likely to break
(geolocation accuracy, microphone permissions, provider latency from a cloud
IP) cannot be tested on localhost.

---

## 1. Deploy

You need to authorise Vercel yourself; it opens a browser, which I cannot drive.

```bash
npx vercel login          # once
npx vercel                # preview deploy
npx vercel --prod         # production deploy
```

Accept the defaults when it asks — it detects Next.js and `vercel.json` already
sets the region, function timeouts and the permissions policy.

**Alternative, and better long-term:** push to GitHub and import the repo at
vercel.com/new. Then every push deploys, and you get a preview URL per branch.
There is no remote configured yet:

```bash
gh repo create find-me --private --source=. --push
```

## 2. Environment variables

**All of them are optional.** The map, search, routing and weather work on an
empty environment — that is deliberate. The exception is the safety block: SOS
without Supabase runs in memory, and on serverless an alert can vanish when an
instance recycles. Do not show SOS to anyone outside the team before it is set.

Set these in Vercel → Project → Settings → Environment Variables:

| Variable | Needed for | If unset |
|---|---|---|
| `OSM_USER_AGENT` | **Set this one.** Nominatim policy | Falls back to a generic string; see the warning below |
| `ANTHROPIC_API_KEY` | The real assistant | Falls back to keyword matching, announced in-app |
| `TOMTOM_API_KEY` | Live traffic: the coloured traffic layer, traffic on named roads, traffic on every planned trip | Traffic is reported as unknown everywhere and the layer stays off |
| `FAST_REPLIES` | `off` makes the model phrase every answer | Recognised requests are answered from their results in ~1s |
| `WEB_PLACE_SEARCH` | `off` disables the web fallback for places the map does not know | On whenever a Gemini key exists |
| `GEMINI_THINKING_LEVEL` | Gemini reasoning depth | `LOW` |
| `ANTHROPIC_CHAT_MODEL` | Model choice | `claude-haiku-4-5` |
| `OSRM_BASE_URL` | Own routing server | Public OSRM demo (no SLA) |
| `NEXT_PUBLIC_SUPABASE_URL` | Durable SOS alerts and incident reports | Safety data lives in memory; `/api/health` says so |
| `SUPABASE_SERVICE_ROLE_KEY` | Same. Server only — never give it a `NEXT_PUBLIC_` name | Same |
| `SAFETY_SALT` | Hashing reporter identity for incident confirmations | A fixed fallback salt |

Before setting the Supabase pair, apply the migrations: `npx supabase db push`.
Setting the keys against an empty database gives you a store that fails every
write, which `/api/health` reports as a failing `safety:store` check.

`OSM_USER_AGENT` should carry a real contact, e.g.:

```
FindMe/0.1 (https://findme.vercel.app; you@example.com)
```

That is not cosmetic. It is how OpenStreetMap contacts you about a problem
instead of silently blocking the IP.

## 3. First thing after deploying

```
https://<your-deployment>/api/health
```

It calls every provider from the server and reports what answered and how
fast. Hit it before anything else — it turns "the app seems broken" into
"Nominatim is returning nothing from this IP".

Local baseline for comparison:

```
nominatim:search      1378ms   1 results, top: Transcorp Hilton Abuja
nominatim:reverse      616ms   Eagle Square Bus Stop, Ahmadu Bello Way...
overpass:nearby        971ms   1 results
osrm:route            1884ms   5.2km
open-meteo:weather    1006ms   26C Overcast
```

---

## Two risks specific to serverless

These are real, and neither shows up on localhost.

### Nominatim may block the deployment's IP

Nominatim's usage policy blocks clients by IP, and cloud provider ranges are
heavily abused by other people's apps. A fresh Vercel deployment can be
throttled or blocked **on arrival, through no fault of yours**.

If `/api/health` shows `nominatim:*` failing while `open-meteo` succeeds, that
is what happened. Options, cheapest first:

1. Set a real `OSM_USER_AGENT` and retry — some blocks are behaviour-based.
2. Self-host Nominatim (heavy: needs a planet extract and real disk).
3. Move geocoding to a paid provider. `GEOCODING_PROVIDER=google` with a key is
   already wired and needs no code change.

### The rate limiter does not work across instances

`lib/net/throttle.ts` keeps its queue and cache **in process memory**. On
serverless, every concurrent invocation is a separate process with an empty
cache and its own idea of when it last called Nominatim.

So the one-request-per-second limit is enforced *per instance*, not globally.
With one or two testers that is fine. With real traffic it will breach the
policy and get the IP blocked.

The fix, when it matters, is shared state — Upstash Redis has a free tier and
`throttledFetchJson` is the single place that would change. **Do not open this
to a wide audience before then.**

---

## What to actually test on a phone

The point of deploying. In rough order of what is most likely to be wrong:

- [ ] **Geolocation accuracy.** Tap the crosshair. Compare the pin to where you
      actually are. On iOS this goes through Core Location, so it should be
      GPS-accurate outdoors and poor indoors.
- [ ] **Live movement.** Walk a block. The marker should glide rather than
      jump, the cone should point where you are going, and turning the phone
      while standing still should turn the cone (iOS asks for motion access the
      first time you tap a mode button). In a car it should become a car that
      turns with the road; if it does not, tap the car button on the left.
- [ ] **Navigation.** Ask for somewhere, say "take me there". The green banner
      should show the next turn and count down to it, speak it, and — if you
      deliberately take a different street — say "Rerouting" within about
      twenty seconds.
- [ ] **Traffic layer.** Tap the traffic-cone button. With `TOMTOM_API_KEY`
      set, main roads turn green, yellow and red; without it the legend says
      traffic is not connected.
- [ ] **Satellite.** Tap the layers button (right side) and switch between
      Map, Satellite and Hybrid. Imagery is Esri's, free with attribution, and
      is the one way to see buildings where the street map is empty.
- [ ] **Place labels.** At street zoom the map should name the shops, schools
      and clinics around you. There will be far fewer than Google shows —
      OpenStreetMap had five named places in a 2 km box around Dutse — so
      judge this against what is actually mapped, not against Google.
- [ ] **The screen at a glance.** Search bar on top, chips under it, layers and
      the button column down the right, travel modes down the left, and the
      panel's first line clear of the tab bar. Nothing should overlap.
- [ ] **Microphone permission.** Tap the centre voice button. HTTPS is required
      and Vercel provides it, but iOS Safari does not support the speech
      recognition API at all — expect the overlay to say so and the text input
      to still work.
- [ ] **The voice loop.** In Chrome on Android: speak, get an answer read back,
      confirm it starts listening again without a tap.
- [ ] **Bottom sheet drag.** Peek → half → full. A flick should carry it a
      detent; a slow drag should settle on the nearest.
- [ ] **Provider latency on mobile data**, not wifi. Compare against the health
      numbers above.
- [ ] **Real Abuja addresses.** The actual test. Describe places the way you
      would out loud and see what comes back.
- [ ] **Dark mode**, and both light and dark against a bright window.
- [ ] **Safe areas** on a notched phone — the nav bar should clear the home
      indicator.

That last address item is still the thing that decides whether this product
works. Everything else is plumbing.
