"""Settings shared by the collector, the analysis and the website build."""
import os
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
# Raw data lives on the repo's `data` branch, checked out to GHOSTBUS_DATA in CI.
DATA = Path(os.environ.get("GHOSTBUS_DATA", ROOT / "data")).resolve()
RAW = DATA / "raw"            # live pings, one gzip CSV per hour
HEALTH = DATA / "health"      # one row per poll: did the feed answer, how many buses
SCHEDULE = DATA / "schedule"  # scheduled trips and stop times per service day
RESULTS = DATA / "results"    # trip-by-trip verdicts per day
SITE_DATA = ROOT / "docs" / "data"

TZ = ZoneInfo("Europe/London")

# Sheffield, roughly the city boundary. [min_lat, max_lat, min_lon, max_lon]
CITY = "Sheffield"
BBOX = (53.30, 53.46, -1.62, -1.32)

BODS = "https://data.bus-data.dft.gov.uk"
GTFS_RT_URL = BODS + "/api/v1/gtfsrtdatafeed/"
GTFS_REGION = "yorkshire"
GTFS_URL = BODS + f"/timetable/download/gtfs-file/{GTFS_REGION}/"

POLL_SECONDS = 60

# --- verdict rules (see METHOD.md) -----------------------------------------
# A scheduled trip is judged only if the live feed answered for most of the
# trip's time window and the operator was visibly reporting at the time.
MIN_POLL_COVERAGE = 0.9
MIN_OPERATOR_COVERAGE = 0.8
# Matching a bus with no trip ID by where and when it was seen.
STOP_RADIUS_M = 200
EARLY_MIN = 5      # a bus may pass a stop up to 5 minutes early
LATE_MIN = 25      # or up to 25 minutes late
MIN_STOPS_MATCHED = 3
MIN_STOP_SHARE = 0.4
SAMPLE_STOPS = 12
