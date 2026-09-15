# Testplan v0.1.6

1. Update een bestaand brugapparaat zonder opnieuw koppelen.
2. Controleer dat **Brug open** als capability verschijnt.
3. Bij Brugstatus = Onbekend moet Brug open = Onbekend zijn.
4. Bij Brugstatus = Open moet Brug open = Ja zijn en Openingsalarm actief zijn.
5. Bij Brugstatus = Dicht moet Brug open = Nee zijn.
6. Bij Brugstatus = Aangekondigd moet Brug open = Nee zijn.
7. Kies **Brug open** als Homey-statusindicator en controleer dat Onbekend/Nee/Ja op de tegel wordt getoond.
