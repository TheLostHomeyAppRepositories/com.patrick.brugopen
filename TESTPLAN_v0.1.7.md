# Testplan v0.1.7

1. Voeg een gesloten brug toe en controleer dat deze na de eerste geldige NDW-controle `Dicht` / `Nee` toont.
2. Voeg een brug toe terwijl deze open staat en controleer dat deze `Open` / `Ja` toont.
3. Controleer dat een toekomstige geplande opening als `Aangekondigd` verschijnt.
4. Onderbreek netwerk/NDW vóór een eerste geldige controle: status moet `Onbekend` blijven en datastatus een fout aangeven.
5. Herstel netwerk: na een geldige snapshot moet `Onbekend` verdwijnen.
6. Voeg een tweede brug toe terwijl de NDW-feed ongewijzigd is; deze moet tegen de gecachte geldige snapshot worden gesynchroniseerd.
7. Controleer dat bestaande Flow-triggers niet vals afgaan bij de eerste synchronisatie na appstart/apparaatkoppeling.
