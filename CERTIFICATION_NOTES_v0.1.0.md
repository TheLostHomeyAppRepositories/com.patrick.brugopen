# Certification notes v0.1.0

- Homey SDK 3 / Node.js runtime / Homey Compose source-of-truth.
- Local Homey platform, compatibility >= 7.4.0.
- Separate 960x960 transparent line-art SVGs for app and driver.
- EN and NL translations for app, driver, capabilities, pairing and all Flow cards.
- App and driver store images use the dimensions required by Athom.
- Every Flow card is device-scoped to `driver_id=bridge`.
- Pairing validates duplicates and uses the stable ISRS code as `data.id`.
- One central NDW feed poller for all bridge devices.
- Initial sync after restart is silent to prevent false trigger events.
- Network/data-source failures do not force a bridge to closed.
