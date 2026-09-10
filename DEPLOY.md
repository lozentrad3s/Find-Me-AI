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
empty environment — that is deliberate.

Set these in Vercel → Project → Settings → Environment Variables:

| Variable | Needed for | If unset |
|---|---|---|
| `OSM_USER_AGENT` | **Set this one.** Nominatim policy | Falls back to a generic string; see the warning below |
| `ANTHROPIC_API_KEY` | The real assistant | Falls back to keyword matching, announced in-app |
| `TOMTOM_API_KEY` | Live traffic | `check_route_conditions` reports traffic as unknown |
| `ANTHROPIC_CHAT_MODEL` | Model choice | `claude-haiku-4-5` |
| `OSRM_BASE_URL` | Own routing server | Public OSRM demo (no SLA) |

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
