# Ghost Bus: audit, competitor comparison and roadmap

Written November 2026. This is an honest look at what the app does today, where it's weak, and what to build next.

## 1. What exists

| Part | Where | What it does |
|---|---|---|
| Collector | `ghostbus/collect.py`, `.github/workflows/collect.yml` | Polls the BODS GTFS-RT feed for the Sheffield area every 60 s, around the clock, using back-to-back GitHub Actions runs. Raw pings go to the `data` branch. |
| Timetable | `ghostbus/schedule.py` | Downloads the Yorkshire GTFS weekly, keeps stops inside the city, and lists each day's trips (calendar exceptions and after-midnight times handled). |
| Matching | `ghostbus/match.py` | Decides for every trip whether it ran, was a ghost, or can't be judged. It uses trip IDs where buses send them and position-and-order matching where they don't, with fairness rules so feed outages never count against an operator. |
| Live engine | `ghostbus/board.py` | Every 2 minutes it projects each bus onto its route, works out its delay and position, and infers the trip for buses that send no trip ID (self-check: about 86% right, 4% wrong). Writes `status.json` and `vehicles.json` to the `live` branch. |
| Model | `ghostbus/model.py`, `train.py`, `registry.py`, `drift.py` | Predicts the chance each departure runs. A new model only replaces the live one if it beats it on unseen days (champion/challenger), with drift monitoring. |
| Website | `docs/` (GitHub Pages) | A static app built with Leaflet and plain ES modules, with no framework and no build step. Live map, stops, routes, trips, network, reliability, planner, chat assistant, offline mode. |
| Assistant | `docs/js/assistant.js` | A rule-based assistant that runs in the browser. It answers from the same live data and never invents times. |
| Infra (optional) | `chart/`, `deploy/`, `terraform/`, `docker-compose.yml` | Helm chart, Argo CD, kind and Terraform for running the pipeline and an API on Kubernetes. Not needed for the public site. |

**Where the data comes from:** only the Department for Transport's Bus Open Data Service (timetables plus GTFS-RT vehicle positions), under the Open Government Licence. Map tiles come from OpenStreetMap.

**Are bus positions really live?** Yes, for buses that report: positions are the buses' own GPS, at most about 2 to 3 minutes old. Every time on the site says whether it comes from a tracked bus ("GPS · seen 2 min ago") or only the timetable.

## 2. What's already good

- **Real ghost-bus detection.** The site counts timetabled buses that never ran, with fairness rules. No mainstream app publishes this.
- **Honest labelling.** It shows GPS versus timetable on every time, plus "may not come" warnings with reasons and a backup bus.
- **Trip inference for buses with no trip ID.** Up to 20% of BODS positions arrive without one; most apps simply drop those buses.
- **A proper ML workflow.** Time-based train/test split, baselines, a champion/challenger gate and drift checks.
- **Running costs are zero.** GitHub Actions, Pages and git branches act as storage, with no servers to pay for.
- **Accessibility.** The Atkinson Hyperlegible font, easy view, read aloud, keyboard support and reduced motion.

## 3. What's missing or weak

| Problem | Impact | Fix |
|---|---|---|
| No user accounts or server | Saved journeys and alerts live in one browser only. Alerts only fire while a tab is open. | Small API plus database (see section 6). Web Push needs a server and VAPID keys. |
| Sheffield only | Can't grow without config work. | The bounding box and GTFS region are config. Generalise into "region" plugins (section 6). |
| Planner allows at most 1 change and only covers today | Misses 2-change journeys. Can't plan for tomorrow. | Move to RAPTOR on the server. Publish tomorrow's board. |
| No fares, no step-free data | Can't offer "cheapest" or "wheelchair accessible" honestly. | BODS fares data (NeTEx) for fares. Accessibility needs operator data. Until then the site says so plainly. |
| No crowding | Passengers ask for it. | Some SIRI-VM feeds carry occupancy; not parsed yet. Passenger reports would need accounts and moderation. |
| No disruption feed | Roadworks and diversions are only seen indirectly, as delays and ghosts. | BODS SIRI-SX disruptions feed. |
| Delay estimates for untracked buses are not yet measured | Estimates are labelled, but there's no accuracy figure. | Log estimate vs actual from the live loop and publish the error. |
| GitHub Actions as the collector | Works, but runs are capped and can queue. | Move the collector to a small always-on container when there's budget. |
| Front-end tests are local only | The regression scripts aren't in CI yet. | Add Playwright to `ci.yml`. |

## 4. How passengers compare it with other apps

These rows are based on public reviews and news reports about UK bus apps (app store reviews, AppleVis, local news about First and Stagecoach services, Reddit). They describe common complaints, not a full test of every product.

| Passenger need | Ghost Bus now | Typical operator app | Typical all-operator app |
|---|---|---|---|
| All operators in one place | ✓ (every BODS operator in Sheffield) | ✗ own buses only | ✓ |
| Says whether a time is GPS or timetable | ✓ on every time | Often unclear (common complaint) | Often unclear (common complaint) |
| Warns a bus may not come | ✓ with reasons | Rarely | Rarely |
| Shows buses that never came | ✓ | ✗ | ✗ |
| Backup bus when one fails | ✓ | ✗ | Partly |
| Journey options with reasons (fastest, most reliable, least walking, fewest changes) | ✓ | Varies | Planner usually optimises time only |
| Arrive-by planning | ✓ | Varies | ✓ |
| Natural-language questions | ✓ (runs in the browser, no AI cost) | ✗ | ✗ |
| Saved journeys with alerts | ✓ while open | ✓ some | ✓ some |
| Push alerts with the app closed | ✗ (needs a server) | ✓ | ✓ |
| Tickets | ✗ | ✓ | Some |
| Works offline | ✓ last data | Varies | Varies |
| Whole UK | ✗ Sheffield only | ✗ | ✓ |

**Where we can realistically win:** trust ("is it really coming?"), honest labels, reliability-aware planning, and accessibility.
**Where we can't compete yet:** tickets, whole-UK coverage and closed-app push alerts. These need accounts, partners or servers.

## 5. Built in this round

1. **Journey planner with options.** Fastest (or "leave latest" for arrive-by), most reliable, least walking and fewest changes, each with the reason it was picked. Times come from the timetable and the buses' GPS. The "likely to work out" figure is explained on the page:
   - 99% for a bus being tracked
   - otherwise the route's record over the days checked
   - lowered for recent trouble or a tight change
2. **Natural-language trip requests.** For example: "I need to get to the city centre by 9am", "fastest route to uni", "least walking", "find an alternative because my bus is delayed".
3. **Places that aren't stop names.** University of Sheffield, Sheffield Hallam City Campus, Collegiate, the Northern General and the city centre. Whole districts ("Crookes") use any nearby stop.
4. **Missed-connection warnings.** Tight changes are flagged, and so is "only N minutes to spare".
5. **Delay estimates for buses not tracked yet.** These come from the other buses on the same route and direction right now (median, needs at least 2), and are always labelled as estimates.
6. **Saved journeys on the home screen.** Live next bus, GPS state and warnings, plus alerts:
   - leave now
   - your bus is 5+ min late
   - your bus may not come, so switch
   - tight change

   You can set a usual time and how long it takes to reach the stop. Alerts are deduplicated. They fire while Ghost Bus is open, which the page says.

Checked: the 147-question assistant regression gives the same intents and no errors. Planner answers take about 70–150 ms in headless Chromium. Screenshots were checked at desktop and phone widths. The 33 Python tests pass.

## 6. Roadmap, in priority order

Ranked by passenger value, then feasibility, competitive edge, cost and commercial potential.

1. **Measure the delay estimates and the arrival accuracy.** Log predicted versus actual from the live loop and publish the error on the reliability page. *Cheap, and builds trust.*
2. **SIRI-SX disruptions.** Show diversions and closures next to the ghost warnings. *Cheap; BODS already offers it.*
3. **A small API and accounts.** FastAPI (already in `serve.py`) plus Postgres: saved journeys across devices, Web Push alerts with the app closed, and rate limiting. *Medium cost; unlocks premium.*
4. **A RAPTOR planner on the server.** Two or more changes, tomorrow's journeys, and walking from a real location. *Medium.*
5. **Region plugins.** One config per area: bounding box, GTFS region and landmarks. Start with Rotherham, Barnsley and Doncaster (same feed), then other English cities. *Medium.*
6. **Occupancy where operators send it, then passenger reports.** Always labelled by source. *Medium.*
7. **Commercial.**
   - Free: everything above.
   - Premium: multiple commute routines, closed-app alerts, personal stats.
   - B2B: reliability dashboards for universities and councils.

   Payments go through Stripe Checkout and webhooks, with no card data handled here. Tickets only through operator or Passenger partnerships.

## 7. Built in round two

1. **Arrival confidence on every time.**
   - High: on GPS, trip sent, fresh.
   - Medium: GPS but matched by movement, GPS 4–10 min old, or timetable on a 97%+ route.
   - Low: anything weaker.

   The reasons are in the tooltip and on the trip page. The Medium level for matched buses rests on the live self-check (about 84% right).
2. **Reliability dashboard** (`#/reliability/routes|operators|days|accuracy`):
   - Every score shows its checked-trip count, a 95% Wilson range and a confidence word.
   - "Not checked" (no tracking) is always kept apart from "never ran".
   - Filters for operator, minimum observations and "only 5%+ missing", plus sorting.
   - All-days or last-7-days views, operator comparison with daily trend lines, and city day-by-day figures.
   - Route pages show day-by-day bars and a tappable record for every departure.
3. **Measured live accuracy.** On each update, trip inference is scored against buses that send their trip. The route-delay estimate is scored leave-one-out against the buses being tracked, and compared with simply assuming "on time".
4. **Map tools.** Buses on or off, stops on or off (shown from zoom 15.5, click a stop to open it), an operator filter, a manual refresh, and "Follow this bus" on any bus being tracked.
5. **Passenger reports** on every trip page. Each report is checked against GPS straight away: agrees, disagrees, still coming, or can't confirm. It's saved on the device, and sent to the API when one is configured (`?api=`).
   - Server: `ghostbus/reports.py` (SQLite, validation, per-device and per-IP rate limits).
   - Verification levels: single, likely (2 devices), or confirmed (GPS agrees, or 3 devices within 30 min).
   - Tested in `tests/test_reports.py`.
6. **"You" page:**
   - Theme, easy view and stops on the map.
   - Alert types on or off, notification permission, and a test alert.
   - Home and work, saved journeys with commute days, saved stops and routes.
   - Journey history, your reports and travel stats.
   - Download, restore or delete all your data.
7. **Notifications** go through the service worker (better on phones). It has `push` and `notificationclick` handlers ready, and the API has `/push/subscribe`.
8. **Data pipeline.** Daily series per route and operator, not-checked counts, and last-7-day counts are published by `publish.build()`.

### Still needs hosting or external access

| Feature | What's missing |
|---|---|
| Alerts with the site fully closed | Host the API (`uvicorn ghostbus.serve:app`). Create a VAPID key pair (`VAPID_PRIVATE_KEY`, public key in the site). Add a worker that runs the commute checks every 2 min and sends with `pywebpush`. |
| Shared passenger reports | Host the API and set its URL in the site. Reports then pool across users with the verification levels above. |
| Accounts and sync | Same API plus sign-in (email magic link or passkeys). The device data export format is already the sync format. |
| Fares ("cheapest") | BODS fares data (NeTEx), not yet ingested. |
| Trams | Supertram isn't in the bus feed that's used now; it needs its own GTFS source. |
| Other regions | `config.py` holds one bounding box. A region plugin (box, GTFS region, landmarks) is the next refactor. BODS covers England only. |
