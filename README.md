# Brug Open — Homey app

Homey SDK 3 app for Dutch bridge-opening status, using Rijkswaterstaat FIS/ISRS for pairing plus two NDW DATEX II feeds: the planning feed for announcements and the temporary-closures feed for faster live open/closed status.

## Architecture

- One Homey device per selected bridge.
- Pairing does not download the complete bridge catalogue. After the user presses **Search**, the Rijkswaterstaat OGC Features API is queried server-side for a small set of movable bridge candidates by bridge name/place.
- Search results are ranked locally, but the stable RIS/ISRS code is resolved only after the user selects one bridge. This keeps CPU, memory and network load low on Homey.
- FIS bridge data supplies bridge name, city, coordinates and numeric `isrsid`; the ISRS object layer resolves that single selected ID to the stable RIS/ISRS `code` used for NDW matching.
- One central NDW service is shared by all bridge devices. It checks `tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz` every 15 seconds for current bridge closures and `planningsfeed_brugopeningen.xml.gz` every 60 seconds for announcements/planning.
- DATEX II bridge lifecycle is normalized to `unknown`, `planned`, `open`, `closed`.
- Network errors never turn a bridge into `closed`.
- In the current-closures feed, a previously observed open bridge disappearing from a successful new snapshot is treated as closed immediately. Planning-feed disappearance remains conservative and requires two successful snapshots.
- The first successful sync after a Homey/app restart updates the tile without firing a false Flow trigger.

## Flow

Triggers: bridge opened, bridge closed, opening announced, status changed. Conditions: open, closed, announced, status equals. Action: refresh bridge status.

## Development

```bash
npm test
homey app validate
homey app install
```

The generated root `app.json` is not the source of truth. Edit `.homeycompose/app.json`, `.homeycompose/flow/*`, `.homeycompose/capabilities/*` and `drivers/bridge/driver.compose.json`, then run `npm run generate:manifest`.

## Data sources

NDW Open Data:
- `https://opendata.ndw.nu/tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz`
- `https://opendata.ndw.nu/planningsfeed_brugopeningen.xml.gz`

Rijkswaterstaat FIS/VNDS OGC Features API: `https://geo.rijkswaterstaat.nl/services/ogc/gdr/fis_vnds/ogc/features/v1`
