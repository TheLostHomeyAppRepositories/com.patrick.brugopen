# Data sources

## NDW Open Data

The app reads two public DATEX II v3 feeds. `tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz` is used as the fast source for current bridge closures/openings and is checked every 15 seconds. `planningsfeed_brugopeningen.xml.gz` is checked every 60 seconds and supplies announcements and planned opening times. A bridge is treated as open from the road-traffic perspective: `beingImplemented` and `implemented` mean road traffic can no longer pass. `approved` is used for an announcement. Lifecycle end/cancel closes the active cycle.

NDW explicitly notes that not every bridge provides every status. Therefore a bridge that has never been observed remains `unknown`. For the dedicated current-closures feed, absence is interpreted as closed only after that bridge has previously been observed in that feed and a new snapshot was downloaded successfully.

## Rijkswaterstaat FIS/ISRS

Pairing uses the public Rijkswaterstaat OGC Features API. The `brug` collection is queried only after the user starts a search, with a server-side filter for `canopen = Yes` and the entered bridge name/place. The app retrieves only a small candidate set; it does not download the full bridge catalogue.

After the user selects one candidate, that bridge's numeric `isrsid` is resolved through the `isrs_object` collection to the stable RIS/ISRS `code` used for matching NDW situations. An exact-ID ArcGIS request is retained only as a small fallback for this single selected bridge.
