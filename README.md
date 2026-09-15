# Brug Open

![Brug Open](assets/images/xlarge.png)

Met **Brug Open** kun je bruggen in Nederland toevoegen aan Homey. Je ziet of een brug open of dicht is en, wanneer beschikbaar, wanneer de volgende opening gepland staat.

De app gebruikt openbare gegevens van **NDW** en **Rijkswaterstaat**.

## Wat kun je ermee?

Per brug zie je in Homey:

- **Brugstatus** — Open, Dicht, Aangekondigd of Onbekend
- **Brug open** — Ja, Nee of Onbekend
- **Volgende opening** — als deze door NDW wordt doorgegeven
- **Laatste NDW-controle**
- **Datastatus**

## Een brug toevoegen

1. Open Homey.
2. Ga naar **Apparaten**.
3. Kies **Nieuw apparaat**.
4. Kies **Brug Open**.
5. Typ de naam of plaats van de brug.
6. Kies de juiste brug uit de zoekresultaten.

De brug wordt daarna als een eigen apparaat aan Homey toegevoegd.

## Flows

Brug Open kan worden gebruikt in Homey Flows.

### Wanneer

- Brug geopend
- Brug gesloten
- Opening aangekondigd
- Brugstatus gewijzigd

### En

- Brug is open
- Brug is dicht
- Opening is aangekondigd
- Brugstatus is...

### Dan

- Brugstatus verversen

Zo kun je bijvoorbeeld een melding krijgen wanneer een brug opent of wanneer een aangekondigde opening bekend wordt.

## Beschikbaarheid van gegevens

De app is afhankelijk van de gegevens die NDW en Rijkswaterstaat beschikbaar stellen. Niet voor iedere brug is altijd een geplande opening bekend.

Bij een tijdelijke storing blijft de laatst bekende status behouden totdat nieuwe gegevens beschikbaar zijn.

## Privacy

Brug Open gebruikt geen account en vraagt geen persoonlijke gegevens. De app leest alleen openbare brug- en verkeersgegevens.

## Ondersteuning

Heb je een probleem of een vraag? Meld deze via [GitHub Issues](https://github.com/glijie/brug-open-homey/issues).
