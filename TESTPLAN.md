# Testplan v0.1.4

1. Installeer v0.1.4 over v0.1.3.
2. Voeg een brug toe die op dat moment open is en controleer dat deze binnen circa 15 seconden als Open kan verschijnen.
3. Laat een open brug sluiten en vergelijk de Homey-status met de NDW/brugstatus.
4. Controleer dat Laatste NDW-controle ongeveer iedere 15 seconden wordt bijgewerkt.
5. Controleer dat een toekomstige opening nog steeds als Aangekondigd verschijnt.
6. Houd de Homey CLI-log minimaal 10 minuten open en controleer op CPUWARN-meldingen.
7. Test Flow-triggers Brug geopend en Brug gesloten.
8. Voer lokaal `npm test` en `homey app validate` uit voor publicatie.
