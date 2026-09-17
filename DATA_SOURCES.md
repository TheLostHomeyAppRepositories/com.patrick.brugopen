# Data sources

## NDW Open Data — live bridge state and planning

The core bridge state uses public DATEX II data from NDW. `tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz` is the fast source for current bridge road closures/openings and is checked every 15 seconds. `planningsfeed_brugopeningen.xml.gz` is checked every 60 seconds and supplies announcements and planned opening times.

From the road-traffic perspective, an active bridge swing/closure means road traffic cannot pass. Planning information is shown only when NDW actually supplies a matching announcement. The app deliberately does not turn historical patterns into a prediction.

NDW does not guarantee identical status/planning coverage for every bridge. On download errors the last useful state is retained where appropriate and a data status is exposed. The core live bridge service is independent from the optional bridge-opening traffic-impact feed.

## NDW Open Data — queues caused by a bridge opening

The app also reads the public current-situations feed `actueel_beeld.xml.gz`, currently polled every 30 seconds. This feed is **not** used as a generic nearby-traffic or incident detector. Brug Open only exposes a queue when the DATEX data provides evidence that the queue belongs to the bridge-opening situation.

The preferred relation is an explicit DATEX `managedCause` reference from the queue record to a `GeneralNetworkManagement` record with `generalNetworkManagementType=bridgeSwingInOperation`. As a conservative fallback, a queue can be accepted when it is grouped in the same DATEX situation as the bridge-opening record and there is no competing accident, roadworks, obstruction or other non-bridge cause in that situation. Proximity alone is never sufficient.

After a proven queue has been associated with a bridge opening, the app tracks that exact queue record/situation after the bridge closes. While it remains present, the impact is exposed as residual traffic/aftermath. When the proven queue disappears from the current feed, the traffic consequence is considered recovered.

This deliberately strict model can produce a false negative when NDW does not provide enough relationship information for a real bridge-caused queue. That is preferred over attributing an unrelated accident, roadworks queue or nearby traffic jam to a bridge opening. No exact ETA, travel-time prediction or alternative route is calculated.

A Bridge Route aggregates only these proven bridge-opening queue/aftermath states from its member bridges. No additional traffic request is made per route.

## Rijkswaterstaat FIS/ISRS

Pairing uses the public Rijkswaterstaat OGC Features API. The `brug` collection is queried after the user starts a search, with a server-side filter for movable bridges. The app retrieves a small candidate set rather than downloading the full bridge catalogue.

After selection, the bridge's numeric `isrsid` is resolved through the `isrs_object` collection to the stable RIS/ISRS `code` used for matching NDW situations. An exact-ID ArcGIS request remains only as a small fallback for the selected bridge.

For **Bridges nearby Homey**, the app uses the Homey geolocation manager's configured home position, queries movable bridges in progressively larger small bounding boxes, deduplicates them and sorts the results by geographic distance. This is the fixed Homey location, not a phone's live GPS location.

## PDOK / Kadaster Location API

If FIS bridge/opening/ISRS-object names do not sufficiently match search text, pairing can use the public PDOK Location API as a name-to-location fallback. A small result set from the `inrichtingselement` collection is requested and linked back to the nearest movable FIS bridge. The Homey device therefore still uses the FIS/ISRS bridge identity and NDW for status.

PDOK Location API: `https://api.pdok.nl/kadaster/location-api/v1/` — Kadaster/PDOK, CC BY 4.0.

## Local bridge and route history

Opening history, duration statistics and Bridge Route selections are generated locally from states already received by the app. They do not add an external historical-data dependency.

Completed bridge openings are retained locally for up to 180 days with a maximum of 500 records per bridge. Route blockage history is likewise bounded locally. The Control Center derives totals, averages, records, recent events and hour patterns from these local measurements.

Historical measurements begin when the relevant bridge/route is actually monitored by this Homey; they are not presented as complete historic records from before installation.

## Homey Web API / local Control Center

The app exposes only its own local Homey app API routes for the Control Center: dashboard snapshot, route editing, refresh and nearby-bridge lookup. The Control Center communicates with the running app through Homey's app API and realtime events; it is not a separate cloud service.
