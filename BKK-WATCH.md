# bkk-watch

A fork of [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) (remote `upstream`) that shows Bangkok water levels and MEA planned power outages on the map, and sends alerts to subscribers through a Telegram bot.

## What visitors see (simple mode)

The site opens in a Thai-first flood overview (`src/bkk/thaiShell.js`, `thaiShell.css`), not GEV's operator interface. The design is "direction A" from the Doop canvas: a light panel beside a muted map, where colour is reserved for water status.

- **Headline:** how many water gauges are over the bank right now and in how many provinces, plus how many are near the bank.
- **Province bars:** provinces with at least one over-bank gauge, worst first. Clicking one filters the list and flies there. The search box finds provinces, districts and gauges.
- **Map:** all of Thailand on a desaturated OSM base map. Near-bank gauges are orange dots and the rest are small and grey. Each over-bank gauge is a red dot inside a circle whose radius grows with the metres of water above the bank (`src/bkk/floodMath.js`); a solid circle means the level rose since the previous reading. The circles shrink as the camera rises, so the country view is not one red blob. Once a circle's radius reaches 9 px it is drawn as a tank instead: water fills it to the gauge's percentage of bank-full depth, a dashed line at half height is the bank, and the surface creeps up or sinks when the level rose or fell since the previous reading. With the camera below 120 km every over-bank gauge is a tank of at least 10 px, and the near-bank gauges become 9 px amber tanks whose water stands under the line. Gauge labels carry ▲ or ▼ for that change; the number keeps the bank's colour (red over, amber near). The dots along rivers are off until switched on, from their entry in the dock's legend or from the menu (phones have no dock); the choice is remembered in `localStorage` under `bkkwatch:flow`. When on and below 120 km, dots run along the river or canal a gauge stands on (`src/bkk/flowOverlay.js`): fast when its level rose since the previous reading, slow when it fell. The speed is that change, not a measured current, and the direction is the one the waterway is drawn in OpenStreetMap, so a tidal reach or a pumped canal can really be running the other way. The open gauge's line is fetched on demand; other gauges in view show theirs only once the service has it cached. Nothing on the map paints flooded ground; the service has gauge levels, not flood extent. Ripples mark the 18 worst gauges at country zoom and the rising ones when zoomed in. Names, news zones and resident reports appear as HTML pills (`src/bkk/mapOverlay.js`) that hide when they would overlap. The selected gauge carries a pin: its metres above or below the bank on a leader line.
- **Trend strip:** under the headline, how many over-bank gauges are rising, steady and falling.
- **List:** tabs for ล้นตลิ่ง (over the bank) and ใกล้ล้น (near the bank). Each row has the percentage of bank-full depth, a bar with a tick at the bank, and an arrow for rising or falling.
- **Gauge detail** (`src/bkk/thaiDetail.js`), opened from a row, a dot or `?station=<id>`:
  - An animated tank with the bank line, metres above or below the bank, and the change over 1 h and 24 h.
  - A 3-day chart with the bank as a dashed line, and the age of the latest reading.
  - **Street depth near this point**, from the deepest of a resident report within 1.5 km or a news headline within 3 km, with a ladder showing what can get through (walking, motorcycle, car, pickup, boat; `src/bkk/depthLadder.js`). With no source it says there is no street-depth data. The gauge itself measures the river or canal, and the panel says so.
  - **Before you go:** rain in the next 6 h, news within 8 km, the nearest live camera within 30 km, and planned outages within 5 km. The news and camera lines do not leave the page: they turn the layer on, open its player over the map and fly so the zone or camera sits in the part of the map the players leave free (`showOnMap` in `thaiShell.js`). The full pages stay one link away inside each player.
  - **Before you go** also lists trash reports within 3 km.
  - **"ยังมีอาหารขายไหม" (is food still on sale):** up to six places to eat within 1.5 km from OpenStreetMap (markets, convenience stores, supermarkets, restaurants, food courts), each with what residents last said: still selling, closed, or nobody has confirmed. Spots that residents pinned themselves (street vendors are not in OSM) are listed too. Tapping a row opens its card.
  - **Nearby:** the closest hospital, police station, school (often used as a shelter), pharmacy and fuel station within 3 km, labelled "not confirmed open".
  - Hotlines 1784 and 1669, plus 1555 for Bangkok gauges or 191 elsewhere; a Google Maps directions link; "nearby gauges".
- **"จากคนในพื้นที่" (from people on the spot):** a row on the map, apart from the sensor layers, with three chips that show and hide what residents reported: ขยะลอยน้ำ (trash in the water), อาหารยังขาย (food still on sale) and น้ำบนถนน (street depth). The numbers are the spots on the map now. Trash spots are brown squares, ringed when the trash blocks a drain; food spots are green circles when selling and grey outlines when closed; with a gauge open, the unconfirmed places to eat around it are dashed outlines. A marker opens a card with how many people reported, how long ago, the nearest gauge at or near its bank within 5 km, and two buttons to confirm or contradict it. The list has a third tab, คนในพื้นที่, with the same spots.
- **"รายงานจุดนี้" (report this spot)**, on that row and in the gauge detail: one form with three questions, each answered by one fixed choice — street depth (six levels), trash (none, floating, blocking the drain), food (still on sale, none). Any subset can be sent. From the row it reports at the browser's location; from a gauge, at the gauge. See Reports below.
- **"น้ำใกล้ฉัน" (water near me):** uses the browser's location to list over-bank and near-bank gauges within 80 km, nearest first.
- **Layer chips:** water, flood news, live cameras, planned outages. The outage chip shows how many announcements MEA lists (0 means none, not a failed load); MEA covers Bangkok, Nonthaburi and Samut Prakan only, and unplanned cuts are not in its list. News and camera markers open a player with stepping to the next clip or the next camera. With both open they sit side by side and share the map's width; on a phone, in advanced mode, or when that would leave each under 260 px wide, the one opened last replaces the other.
- **Dock** (`src/bkk/thaiDock.js`), under the map on desktop: what the circles mean, and a 72-hour replay. The bars count the gauges over the bank each hour and start at zero. Dragging across them or pressing play redraws the map for that hour from the service's hourly table; the live dots are hidden meanwhile, and "กลับสู่ตอนนี้" returns to now.
- **Only its own layers and its own base map.** Simple mode shows the four layers its chips control and the base map its two buttons choose. GEV's saved address switches advanced-mode layers (its cameras with "CAM-…" labels, weather, wind) and the 3D map back on a moment after start-up, so simple mode parks those layers (`parkAdvancedLayers` in `thaiShell.js`, remembered in `localStorage` under `bkkwatch:parked`) and puts its base map back; going to advanced mode switches the parked layers on again.
- **Preloader:** the app's own mark (`public/bkk-logo.svg`, also the tab icon) and name, in the saved theme, with Thai status lines. The template is `src/ui/templates/hud-loading.html`. Advanced mode's title bar still carries upstream's name.
- **Dark theme:** the สว่าง/มืด switch in the top bar (in the menu on phones), remembered in `localStorage` under `bkkwatch:theme`. Light is the default. The street map is inverted inside Cesium (a negative imagery contrast plus a half-turn of hue) and washed navy by a CSS layer. On screens 1100 px and wider the dark theme is a three-column dashboard: a full-height stack of cards on the left, the list or gauge detail on the right, the map and dock between them. The left cards are the three headline counts, the province bars, the trend donut and one gauge in figures (metres against the bank, change since the previous reading, percent of bank-full depth, rain chance in 6 h). That last card describes the selected gauge, and otherwise the worst one in the current view (the nearest one in "near me"), with a button to open it. The dock gains a strip with the three headline counts and the rain chance at the selected gauge.
- **Phones:** the panel becomes a bottom sheet with three heights. A gauge opens it to full height, which hides the map's chips and the near-me button. The dock and the trend strip are not shown on phones.
- **"โหมดขั้นสูง" (advanced mode)** brings back the full GEV interface; "← กลับโหมดดูน้ำท่วม" returns. The choice is remembered in `localStorage` under `bkkwatch:mode`.

Water data is nationwide: about 800 ThaiWater gauges, of which the ones with a bank reference are used. "Over the bank" means the river or canal level at the gauge is above its bank. It is not a measurement of street flooding.

## Stay-or-go data

| Endpoint | Source | Notes |
|---|---|---|
| `GET /api/bkk/water/history?id=` | ThaiWater `public/waterlevel_graph` | Hourly levels for 3 days. |
| `GET /api/bkk/water/timeline` | `alert-service/history.js` | Percent of bank-full depth per hour for the last 72 h, for every gauge that came within 70% of its bank, plus hourly over-bank and near-bank counts. See below. |
| `GET /api/bkk/places?lat&lon` | OSM via Overpass (ODbL) | 3 km radius. Cached in SQLite for 30 days because the public Overpass servers often time out; over-bank gauges are pre-fetched in the background, 20 s apart. OSM has no live opening status. |
| `GET /api/bkk/food?lat&lon` | OSM via Overpass (ODbL) | Places that sell food within 1.5 km, cached and pre-fetched the same way. A separate lookup, so when Overpass refuses one the other still answers; if this one fails the detail view falls back to the shops in `places`. |
| `GET /api/bkk/rain?lat&lon` | Open-Meteo forecast | Next 6 h, cached 30 min. |
| `GET /api/bkk/river?lat&lon` | OSM via Overpass (ODbL) | The nearest `river` or `canal` way within 1.2 km of the point, plus other ways of the same name within 400 m (one river is many ways in OSM; a differently named canal nearby is left out), each cut to the stretch within 4 km, as `[lon, lat]` points in the way's own order. Cached 30 days and pre-fetched like places. With `cached=1` it answers only from the cache (`rivers: null` otherwise), so drawing many gauges never sends a burst to Overpass. |
| `GET /api/bkk/news` → `depth` | `alert-service/news/depth.js` | Depth read from the headline: a number with a unit, or a body part (ankle 10 cm, shin 25, knee 45, waist 95, chest 125). |
| `GET`/`POST /api/bkk/reports` | Residents | See below. |

The vehicle thresholds in `depthLadder.js` follow the US National Weather Service's general flood-driving guidance (15 cm, 30 cm, 60 cm). They have not been checked against a Thai authority's figures and are no substitute for judgement at the scene.

### Hourly history

ThaiWater serves history one station at a time, so the service keeps its own `water_hourly` table. Every poll stores each fresh station's percent under the hour it was observed. Stations at or near the bank get their last three days backfilled once from `waterlevel_graph`, 400 ms apart (about 250 stations, a few minutes). Rows older than 7 days are deleted. A missing hour is filled from the reading before it, up to 3 hours back.

Hours from before the service started recording only contain the backfilled stations. A gauge that was over the bank then and is well below it now is missing from those hours, so early counts can be too low.

### Reports

`alert-service/reports.js`. A report is a location inside Thailand plus a fixed choice of one kind: `depth` (six levels), `trash` (`floating`, `blocking`, `clear`) or `food` (`open`, `closed`). `POST /api/bkk/reports` takes `{ lat, lon, answers: { depth?, trash?, food? } }` and stores one row per answer; the older `{ lat, lon, level }` still files a depth report. There is no free text and no photo, so there is nothing to moderate. Reports count for 6 h, then drop off the map. One sender can file 3 submissions in 10 min and 20 in a day (a submission with three answers counts once); the sender is stored as a salted hash of the IP address, never the address itself. Reports are unverified and the UI labels them as resident reports. Nothing stops a person from reporting a place they are not at.

`GET /api/bkk/reports` returns `reports` (depth), `spots` (trash and food) and `choices`. Trash and food reports of the same kind within 60 m are one spot. The newest report sets the spot's status, and `count` is the number of distinct senders who said the same since anyone last said otherwise. A trash spot whose newest report is `clear` leaves the map; a food spot reported `closed` stays, shown as closed. A report carries no shop name: the browser matches each food spot to the nearest OSM place within 60 m (`src/bkk/folk.js`), so two shops side by side do not share a report.

## Run

```sh
npm run alert        # alert service at 127.0.0.1:4191 (polls ThaiWater and MEA, runs the Telegram bot)
npm run dev          # map at http://localhost:4173 (add `-- --port 4190` to pick a port) (proxies /api/bkk/* to the alert service)
```

To get Telegram alerts, copy `alert-service/.env.example` to `alert-service/.env` and set `TELEGRAM_BOT_TOKEN` to a token from @BotFather. Without a token, the service still serves the map and writes alerts to the log.

## Data

| Signal | Source | Update rate | Limits |
|---|---|---|---|
| River/canal water level | `api-v3.thaiwater.net …/public/waterlevel_load` (HII, RID and others) | Polled every 5 min; stations report every ~10–60 min | About 800 gauges nationwide (9 in Bangkok). Measures river/canal level, not street flooding. |
| Planned outages | MEA announcement pages (HTML scrape) | Polled every 30 min | Planned outages only, no unplanned ones. Locations are geocoded from free text. |

`situation_level` bands `storage_percent` (water depth as a percentage of bank-full depth) into five levels: 1 ≤10, 2 ≤30, 3 ≤70, 4 ≤100, 5 >100 (overflowing the bank). An alert fires when a station rises into level 4 or 5, and again when it falls back below 4. Readings older than 3 h are shown but never trigger an alert.

Each outage location gets a geocode precision: `soi` (the soi itself matched), `road` (only the road matched, so the location can be off by kilometres), or `approx`. Location-based alerts fire only for `soi` precision. Keyword watches (`/watch <text>`) match against MEA's own text, so they work at any precision.

## Live cameras (Thailand)

- `server/providers/cctv/itic.js` loads the iTIC Foundation / Longdo feed (`camera.longdo.com/feed/?command=json`) for all of Thailand. It keeps only cameras with an HTTPS HLS stream on iTIC's hosts whose playlist answers at load time; the check re-runs on each catalog refresh (15 min). On 2026-09-28 that was 161 of 229: Chonburi, Chachoengsao, Bangkok and Khon Kaen. Every provincial DOH relay returned 502 upstream. `CCTV_ITIC_KEEP_DEAD=1` lists the dead cameras too.
- `server/providers/cctv/dds.js` loads BMA DDS water-level cameras from the markers on `dds.bangkok.go.th/cctv.php`: 6 still images of canal staff gauges. Each name includes the image's age. On 2026-09-28 the latest image was from 28 Aug, so the feed had stopped updating.
- `server/providers/cctv/egat.js` adds EGAT's dam cameras: 34 still images of ten large dams (ภูมิพล, สิริกิติ์, วชิราลงกรณ, ศรีนครินทร์, รัชชประภา, บางลาง, อุบลรัตน์, น้ำพุง, สิรินธร, จุฬาภรณ์) from `egatwater.egat.co.th/assets/CCTV/images/<dam>/<n>.jpg`, which EGAT rewrites about every 30 s. EGAT's page has no list with positions, so the dams are a table in that file, with the coordinates ThaiWater's camera list gives. Only views whose image answers at load time are kept. `CCTV_EGAT_ENABLED=0` turns the pack off. In simple mode they are the blue camera dots; the player shows the picture and refreshes it every 30 s, and refuses the Street View frame the server would otherwise substitute for a camera that does not answer. **Permission to re-show these images has not been asked of EGAT.**
- Looked at and not added (2026-09-30): ThaiWater's own camera list (`api-v3.thaiwater.net/api/v1/thaiwater30/analyst/cctv`) has 106 entries, but of the 78 with an address only the 8 EGAT ones answered; the riverside cameras on `dyndns` hosts did not connect. Nonthaburi's water-level page (`cctv-nont.firsttech.co.th`) is a single stream with no position published.
- `CCTV_THAILAND_ONLY=1` in `.env` turns off the overseas packs. Unset, upstream's packs load as before.
- The live-session cap is `CCTV_HLS_MAX_SESSIONS` (default 40 in this fork; upstream uses 2).

**Camera wall:** `/bkk-cams.html` (dev server only). Modes are 🌊 flood zone (the default), one per province, and all of Thailand. Only tiles on screen hold a stream. Flood zone shows cameras within 6 km of a station at level 4–5, plus the DDS gauge cameras. The traffic cameras sit on main roads and don't look at the canals themselves.

On the map: Data Layers → **Cameras** → choose a city in the CCTV panel → **NEAREST** / **PREV** / **NEXT**.

## News by zone (YouTube)

- `alert-service/news/` polls the channels in `news/channels.json` every 10 min (`NEWS_POLL_MS`; `NEWS_ENABLED=0` turns it off). It tries the channel's official RSS feed first. The feed failed about half the time in testing, so the fallback reads the public `/videos` and `/streams` pages. The unit placed on the map is one clip, not a 24/7 live channel.
- Headlines are matched against `alert-service/gazetteer/bangkok.json`: 15,922 Bangkok names (51 districts, 179 sub-districts, roads, sois, canals) from OSM (ODbL). Rebuild it with `node alert-service/scripts/build-gazetteer.mjs`. Guards against false matches:
  - The longest match wins.
  - Thai syllable and number boundaries are respected.
  - A road name without its "ถนน" prefix only counts for roads 3 km or longer.
  - Title segments that repeat across a channel's clips are treated as show names and dropped.
  - A headline that names another province without saying กทม is skipped.
  - Prefixed names are matched before province names are looked for, so a road like "ถนนเพชรบุรี" doesn't count as the province.
- Topics are น้ำท่วม (flood), ไฟดับ (outage), ไฟไหม้ (fire) and จราจร (traffic). A clip about flooding, an outage or a fire that was published within the last 3 h alerts subscribers near its zone (their radius plus the place's own size) and anyone with a `/watch` keyword match.
- `GET /api/bkk/news` returns the last 48 h. `/bkk-news.html` lists clips with zone and topic filters and plays each one with YouTube's embed player when you click it.
- **On the map, news works like the cameras.** The 📰 layer shows one dot per zone (with a ring when the zone is a wide area). Clicking a dot or its ring opens a player panel (`src/layers/bkk/newsPanel.js`) with PREV/NEXT through that zone's clips, "โซน ◀ / ▶" to fly to the neighbouring zones, a link to the full list, and Esc to close. The clicks register with GEV's pick registry, so other layers don't treat them as clicks on empty space.
- The place list also includes 3,562 OSM neighbourhoods and housing estates. Estate names generate the short forms the news uses ("แฟลตการเคหะคลองจั่น" → "แฟลตคลองจั่น", "เคหะคลองจั่น"), and a road named after an estate can be matched without its "ถนน" prefix ("ถนนเคหะร่มเกล้า" → "เคหะร่มเกล้า").
- Measured on 2026-09-28 (during the Bangkok flood): 38–41 of ~430–460 recent clips from 9 channels were placed in Bangkok, almost all real flood reports (Khlong Chan, Keha Rom Klao, Lat Phrao, Bang Kapi, Suan Luang, Lak Si).

## Bot commands

Send your location to subscribe. `/radius 3`, `/watch ลาซาล`, `/unwatch ลาซาล`, `/status`, `/stop`.

## Changes to upstream files

- The point layers remove the old entities before adding the new ones as two separate collection events. In one suspended batch Cesium cancels a removal against an addition with the same id, and the map kept drawing the first colours it was given (`src/layers/bkk/pointLayer.test.mjs`).
- New layers `bkk-water`, `bkk-outages`, `bkk-news` and `bkk-cams` (`src/layers/bkk/`). They are registered as `local-only`, so they stay out of share-link tokens, and they are switched on at startup.
- The startup camera opens over Bangkok (`src/camera.js`, `src/app/controls.js`).
- `server/providers/bkk.js` proxies `/api/bkk/*` (GET and POST) to the alert service and is installed before `api-not-found`.
- Three pinned upstream tests and `scripts/package-boundaries.json` were updated to include these additions.
