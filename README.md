# Brug Open

![Brug Open](assets/images/xlarge.png)

Met **Brug Open** voeg je beweegbare bruggen in Nederland toe aan Homey. De app combineert actuele brugstatus, aangekondigde openingen, lokaal opgebouwde historie, routes en verkeersgevolgen die aantoonbaar door een brugopening worden veroorzaakt.

De kernstatus **Open / Dicht / Aangekondigd / Onbekend** blijft gebaseerd op openbare NDW- en Rijkswaterstaatgegevens. De aanvullende verkeersimpact is uitsluitend gericht op file en nasleep die aantoonbaar bij een brugopening horen.

## Per brug

- **Brugstatus** — Open, Dicht, Aangekondigd of Onbekend
- **Brug open** — Ja, Nee of Onbekend
- **Volgende opening** — alleen een werkelijk door NDW aangekondigde opening
- **Open sinds** en **Huidige openingsduur**
- **Laatste openingsduur**
- **Openingen vandaag** en **Open tijd vandaag**
- **Gemiddelde** en **langste openingsduur** uit lokaal opgebouwde historie
- **Gevolg brugopening** — file die door NDW aantoonbaar aan de actuele of laatste brugopening is gekoppeld, inclusief eventuele nasleep na het sluiten. De verkeersvelden zijn alleen zichtbaar wanneer er daadwerkelijk file/nasleep is; bij file wordt de **filelengte in km** altijd getoond.
- **Laatste NDW-controle** en **Datastatus**

Bij **Volgende opening** maakt de app onderscheid tussen een echte aankondiging, geen aankondiging, onbekende planningondersteuning, wachten op data en een tijdelijk niet bereikbare planningsfeed. Een aangekondigde opening is nadrukkelijk geen voorspelling van Brug Open.

## Brugroute

Voeg eerst de losse bruggen toe die je onderweg wilt volgen. Maak daarna via **Nieuw apparaat > Brug Open > Brugroute** een route met één of meer reeds toegevoegde bruggen.

Een route toont onder andere:

- **Routestatus** — Vrij, Opening aangekondigd, Geblokkeerd of Data onzeker
- **Relevante brug** — de brug die op dat moment aandacht vraagt
- **Volgende aankondiging** — de eerstvolgende aangekondigde opening op de route
- **Vertrekcheck** — feitelijke samenvatting van de huidige route
- Aantal bruggen, open bruggen en aangekondigde openingen
- **Gevolg brugopening op route** — alleen file/nasleep die aan een brugopening op één van de routebruggen is gekoppeld. Ook hier verschijnen de verkeersvelden alleen bij echte impact en wordt de **filelengte in km** zichtbaar.
- **Blokkades vandaag** en **totale blokkadetijd vandaag**
- Gemiddelde en langste lokaal gemeten routeblokkade

Routes kunnen achteraf in het **Brug Open Control Center** worden aangepast. Bruggen kunnen daar worden toegevoegd of verwijderd zonder de route opnieuw te koppelen.

## Brug Open Control Center

Onder de app-instellingen staat een eigen Control Center met:

- alle toegevoegde bruggen en routes in één overzicht;
- actuele brug-, route- en brugopeningsimpact;
- lokale brug- en routehistorie;
- patronen per uur uit de lokaal gemeten historie;
- beheer van de bruggen binnen een route;
- zoeken naar beweegbare bruggen dichtbij de vaste Homey-locatie;
- diagnostische informatie over de gebruikte databronnen.

De functie **Bruggen dichtbij Homey** gebruikt alleen de vaste locatie die voor Homey is ingesteld. Het is geen realtime GPS-tracking van een telefoon.

## Lokale historie

Brug Open bouwt historie lokaal op vanaf het moment dat een brug of route wordt gebruikt. Daarmee kunnen aantallen, totale duur, gemiddelden, records en uurpatronen worden weergegeven zonder een betaalde historische dienst.

Brughistorie is begrensd tot maximaal 500 afgeronde openingen en maximaal 180 dagen. Routehistorie gebruikt eveneens een begrensde lokale opslag. De gegevens worden niet naar een externe statistiekdienst gestuurd.

## File door een brugopening

Brug Open leest aanvullend de openbare NDW-feed met actuele verkeerssituaties, maar gebruikt daaruit **geen algemeen verkeer, ongevallen, werkzaamheden of incidenten in de buurt**. Een file wordt alleen aan Brug Open gekoppeld wanneer de DATEX-situatie een aantoonbare relatie met de brugopening bevat. De sterkste koppeling is een NDW `managedCause`-verwijzing van de file naar het brugopeningsrecord. Als fallback kan een file in dezelfde DATEX-situatie worden gebruikt wanneer daarin ook de brugopening staat en er geen concurrerende oorzaak zoals een ongeval of werkzaamheden aanwezig is.

Intern kent een brug de verkeersgevolgen **Geen file door brugopening**, **File door brugopening**, **Brug dicht · file loopt nog terug** of **Onbekend**. In het gewone apparaatscherm worden de verkeerscapabilities echter alleen zichtbaar bij een echte file of nasleep. Bij een actieve file verschijnt naast de impactstatus altijd **Filelengte** in km; tijdens nasleep kan daarnaast **Afwikkeltijd** zichtbaar worden. Zodra de brug sluit, blijft Brug Open exact de eerder gekoppelde file volgen totdat die uit de actuele NDW-data verdwenen is.

Deze filtering is bewust streng: als NDW bij een werkelijke file niet voldoende causale informatie levert, toont Brug Open liever géén file dan een file die mogelijk door een ongeluk, werkzaamheden of iets anders wordt veroorzaakt. De app berekent geen eigen reistijd of alternatieve route.

## Flows

### Brug — Wanneer

- Brug geopend
- Brug gesloten
- Opening aangekondigd
- Brugstatus gewijzigd
- Brug is langer dan een gekozen aantal minuten open
- Aangekondigde opening begint binnen een gekozen aantal minuten
- Aangekondigde opening gewijzigd
- Aangekondigde opening geannuleerd
- Geen actuele brugdata gedurende een gekozen aantal minuten
- File door brugopening ontstaan
- Brug dicht maar file door de opening staat er nog
- File door brugopening langer dan een gekozen aantal kilometer
- Nasleep na brugopening langer dan een gekozen aantal minuten
- Verkeer na brugopening weer vrij

### Brug — En

- Brug is open
- Brug is dicht
- Opening is aangekondigd
- Brugstatus is...
- Er is file door deze brugopening
- Brug is dicht maar de file door die opening staat er nog
- File door brugopening is langer dan een gekozen aantal kilometer

### Brug — Dan

- Brugstatus verversen
- Gevolgen van brugopening controleren

### Route — Wanneer

- Route wordt geblokkeerd
- Route is weer vrij
- Opening aangekondigd op route
- Routestatus gewijzigd
- Aankondiging op route gewijzigd
- Aankondiging op route geannuleerd
- Verkeersgevolg van brugopening op route gewijzigd
- File door brugopening op route ontstaan
- Brug dicht maar file door opening staat op de route nog
- File door brugopening op route langer dan een gekozen aantal kilometer
- Nasleep brugopening op route langer dan een gekozen aantal minuten
- Verkeer na brugopening op route weer vrij

### Route — En

- Route is vrij
- Route is geblokkeerd
- Route heeft een aangekondigde opening
- Routestatus is...
- Route heeft file door een brugopening
- Route heeft nasleep na een brugopening
- File door brugopening op route is langer dan een gekozen aantal kilometer
- Route is vrij inclusief nasleep van brugopeningen

### Route — Dan

- **Route controleren voor vertrek** — geeft tokens terug met routestatus, relevante brug, volgende aankondiging, brugopeningsimpact, filelengte, afwikkeltijd, samenvatting en aantallen.
- **Twee routes vergelijken** — geeft de actuele feitelijke brugstatus en brugopeningsimpact van route A en route B terug. Brug Open kiest daarbij niet automatisch een route voor de gebruiker.

## Privacy

Brug Open gebruikt geen eigen gebruikersaccount. De app vraagt locatietoegang alleen om, op verzoek, beweegbare bruggen rond de vaste Homey-locatie te kunnen sorteren. Lokale historie en routekeuzes blijven op Homey.

PDOK/Kadaster Location API-data valt onder CC BY 4.0.

## Ondersteuning

Heb je een probleem of een vraag? Meld deze via [GitHub Issues](https://github.com/glijie/brug-open-homey/issues).
