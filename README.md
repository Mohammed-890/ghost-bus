# Ghost Bus Detector

**Which timetabled buses in Sheffield never actually turn up?** This project counts them, trip by trip, from the government's live bus location feed.

**Live site:** https://mohammed-890.github.io/ghost-bus/

![Ghost Bus Detector](docs/social.png)

A "ghost bus" is on the timetable and often on the arrival board, but never comes. People wait in the cold, miss work and appointments, and nobody publishes how often it happens. Every bus in England reports its GPS position to the [Bus Open Data Service](https://www.bus-data.dft.gov.uk/) (BODS), and every operator publishes its timetable there. Put the two side by side for long enough, and the ghosts show up.

## What it looks like

> These screenshots use **simulated data** to show the design (it says so on each image). The live site only ever shows real results, and real screenshots replace these once collection has run.

| Home | On a phone |
|---|---|
| ![Home page](docs/img/preview-home.png) | <img src="docs/img/preview-phone.png" width="260" alt="Phone view of a route"> |

**Check your bus:** every timetabled departure on a route, and how often a bus actually ran it. Dashed purple departures miss 3 in 10 times or more.

![Route view](docs/img/preview-route.png)

**Least reliable routes and recent ghost buses**

![League table](docs/img/preview-league.png)

## How it works

![How it works](docs/img/how-it-works.png)

```
BODS timetable (GTFS, weekly) ──► every trip scheduled in the city today
BODS live feed (GTFS-RT, every 60 s) ──► every bus position, around the clock
                     │
                     ▼
            match each scheduled trip
   1. a bus reported this exact trip ID          → ran (tracked)
   2. a bus with no trip ID passed the trip's    → ran (matched by position)
      stops in order, on time
   3. neither, while we were watching and the    → ghost
      operator was reporting other buses
   4. otherwise                                  → not judged
                     │
                     ▼
     daily results ──► model: chance each departure runs ──► website
```

- **Collector** (`ghostbus/collect.py`, GitHub Actions every 15 min): polls the GTFS-RT feed for the Sheffield bounding box every 60 seconds. Every poll is logged, failures included, so the analysis knows exactly when the feed was and wasn't watched.
- **Timetable** (`ghostbus/schedule.py`): downloads the Yorkshire GTFS from BODS weekly, cuts it to stops inside the city, and lists the trips running on each service day (calendar plus exceptions, times past midnight handled).
- **Matching** (`ghostbus/match.py`): the core. Up to 20% of live positions carry no trip ID ([BODS user forum](https://boduf.discourse.group/t/missing-trip-id-s-in-gtfs-rt-data/124)), so a trip with no exact match is checked against every untagged bus. It has to pass at least 40% of the trip's sampled stops (minimum 3) within 200 m, from 5 minutes early to 25 minutes late, **in the right order**. One bus can't explain two overlapping trips; the best matches are assigned first.
- **Fairness rules**: a trip is only called a ghost if the feed answered for at least 90% of the trip's polls, the operator had tagged buses visible in at least 80% of them, and the route was seen at least once that day. Anything else is *not judged* and is never counted against anyone.
- **Model** (`ghostbus/model.py`): predicts the chance each departure runs from route, operator, time of day, weekday, headway, and the recent history of that route, hour and exact departure. History features for a day only use earlier days, and the test set is the most recent 30% of days. It's compared with two baselines: the overall rate, and the departure's own past rate.
- **Website** (`docs/`): a static GitHub Pages site that reads JSON written by the daily job.

## Status

Collection started in late October 2026. The site shows real numbers only, and says so while it is still collecting. The model is trained once there are at least 7 judged days and 30 ghost buses.

## Limits, honestly

- "Ghost" means *no bus was seen*. Causes include cancellations, driver shortages and buses running with their tracker off. Operators with poor tracking are protected by the fairness rules, but a bus that ran with its tracker off on a day the operator was otherwise reporting would still be counted.
- Matching by position can't tell two buses on the same road apart if neither has a trip ID; the one-bus-one-trip rule limits but doesn't remove this.
- Trips with fewer than 3 stops inside the city boundary aren't judged.
- One city, one region's timetable. The code works for any bounding box in England.

## Run it

```bash
pip install -r requirements.txt
python -m pytest -q                      # synthetic days covering every verdict rule
export BODS_API_KEY=...                  # free: https://data.bus-data.dft.gov.uk/account/signup/
python -m ghostbus.schedule refresh      # timetable
python -m ghostbus.collect --minutes 10  # live positions
python -m ghostbus.daily                 # judge finished days, build docs/data
```

In this repository the raw data, timetables and daily verdicts live on the [`data` branch](../../tree/data).

## Data licence

Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Not affiliated with any bus operator or the Department for Transport.

Built by [Mohammed Banabilh](https://www.linkedin.com/in/mohammed-banabilh-6340553b0/). MIT licence.
