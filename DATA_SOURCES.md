# Data sources

## NDW Open Data

The app reads two public DATEX II v3 feeds. `tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz` is used as the fast source for current bridge closures/openings and is checked every 15 seconds. `planningsfeed_brugopeningen.xml.gz` is checked every 60 seconds and supplies announcements and planned opening times. A bridge is treated as open from the road-traffic perspective: `beingImplemented` and `implemented` mean road traffic can no longer pass. `approved` is used for an announcement. Lifecycle end/cancel closes the active cycle.

NDW explicitly notes that not every bridge provides every status. The app keeps the last known state on download errors. After a successful current-closures snapshot, a selected bridge that is not active in that snapshot is treated as closed; an active matching bridge is treated as open.

## Rijkswaterstaat FIS/ISRS

Pairing uses the public Rijkswaterstaat OGC Features API. The `brug` collection is queried only after the user starts a search, with a server-side filter for `canopen = Yes` and the entered bridge name/place. The app retrieves only a small candidate set; it does not download the full bridge catalogue.

After the user selects one candidate, that bridge's numeric `isrsid` is resolved through the `isrs_object` collection to the stable RIS/ISRS `code` used for matching NDW situations. An exact-ID ArcGIS request is retained only as a small fallback for this single selected bridge.


## PDOK / Kadaster Location API

If the nationwide FIS bridge, opening and ISRS-object names do not sufficiently match a user's search text, pairing can use the public PDOK Location API as a name-to-location fallback. Only a small result set from the `inrichtingselement` collection is requested. The returned location is then linked back to the nearest movable bridge in Rijkswaterstaat FIS, so the actual Homey device still uses the FIS/ISRS bridge identity and NDW for status.

PDOK Location API: `https://api.pdok.nl/kadaster/location-api/v1/` — Kadaster/PDOK, CC BY 4.0.
