# Regresje formularzy: TDD i odbiór w przeglądarce

Każdy zgłoszony błąd wykrywania, tarczy, wypełnienia lub zapisu zamieniamy
w trwały test. Dotyczy to logowania, rejestracji, zmiany hasła i kolejnych kroków.
Użyj [szablonu raportu](FORM-REGRESSION-TEMPLATE.md).

## Odtworzenie

1. Zapisz publiczny adres bez query/fragmentu, datę, wariant strony, język,
   przeglądarkę, commit buildu i dokładny objaw. Odróżnij kod zainstalowany od
   roboczego katalogu. Po wymianie rozszerzenia sprawdź także wersję skryptu karty.
2. Obserwuj rzeczywisty formularz. Zachowaj strukturę, etykiety, typy,
   `autocomplete`, powiązania `form`, istotne otoczenie, CSS widoczności i granice
   otwartego Shadow DOM. Nie dodawaj brakującego `form` ani semantyki przycisków.
3. Zastąp dane wyłącznie sztucznymi wartościami. Nie zbieraj wartości istniejących
   inputów, ukrytych pól, cookies, storage, tokenów, HAR ani pełnej zalogowanej
   strony. Nie uruchamiaj skryptów produkcyjnej witryny w fixture.
4. Zapisz pochodzenie i ograniczenia redukcji. Fragment DOM bez CSS i zachowania
   frameworka nie jest pełnym odtworzeniem strony. Zaobserwowany HTML oraz
   syntetyczny model zdarzeń opisuj osobno. Nie wymyślaj próbki na podstawie nazwy
   serwisu i nie nazywaj jej produkcyjną.
5. Dodaj test odtwarzający konkretną wadliwą asercję i uruchom go przed poprawką.
   Błąd importu, infrastruktury lub timeout harnessu nie jest RED formularza.
6. Popraw wspólny mechanizm. Uruchom ten sam test i dodaj istotny negatyw:
   newsletter, wyszukiwarkę, OTP, rejestrację, ukryte pole, drugi formularz,
   zmieniony dokument albo inną domenę. Nie osłabiaj granic fill, aby zaliczyć test.

Wspólny egzemplarz umieszczaj w `tests/fixtures/forms/`; użytkownik i agent powinni
testować tę samą strukturę, z osobnymi oczekiwaniami. Wspólne reguły semantyki
znajdują się w `credential-form-analysis.ts` i `login-controls.ts`. Adaptery nadal
odpowiadają za własne write/submit, uprawnienia i transport. Fixture nie włącza
wyłączonego adaptera Playwright do dostarczania prawdziwych sekretów.

## Co sprawdzać

| Obszar | Asercja |
| --- | --- |
| Tarcza | Jest przy właściwym polu, jedna na etap; znika z usuniętym formularzem i pojawia się na kolejnym kroku |
| Geometria | Po błędzie walidacji, zmianie rozmiaru, scrollu i zmianie layoutu pozostaje przy polu; nie zasłania submit ani innej kontrolki |
| Podpowiedzi | Otwierają się po kliknięciu tarczy; wybór konta działa także po automatycznym wypełnieniu |
| Automatyczne fill | Dokładny HTTPS host, puste pola, bez nadpisania i bez submit |
| Ręczne fill | Jawnie wybrane konto trafia do tego samego dokumentu/formularza; submit używa zakończonego fill |
| CLI | Jeden Inject przechodzi dostępne etapy; sukces wypełnienia nie jest dowodem zalogowania |
| Capture | Niezmienione dane nie wywołują Update; zmiana/rejestracja daje właściwy zapis po rozpoznanym wyniku |
| Bezpieczeństwo | Untrusted event, zmiana tab/document/origin, obce scope i pola agenta nie obchodzą istniejących granic |
| Wydajność | Czas całego flow, liczba etapów i wywołań; osobno czas wrappera CLI, bez logowania wartości pól |

Dla CSS, geometrii, zaufanych kliknięć/Entera, nawigacji i zapisu wymagany jest
scenariusz w rzeczywistym Chromium z fikcyjnymi danymi. jsdom nie dowodzi poprawnej
pozycji tarczy ani `isTrusted`. Dla zwykłej klasyfikacji wystarczy test jednostkowy.
Nie stosuj `.skip`, nie dopisuj stronie atrybutów dla GREEN, nie klikaj przez
zasłaniający modal. Sprawdzaj wynik zapisu i Vault, a nie tylko obecność modalu.

## Weryfikacja

```sh
npx vitest run src/content/isolated/inline-autofill.test.ts
npm test
npm run build
npm run test:browser:capture
npm run test:browser:agent-live
```

Dobierz najpierw test do błędu: `fill.test.ts`, `inline-autofill.test.ts`,
`credential-submission.test.ts`, `credential-coordinator.test.ts` lub
`credential-toast.test.ts`. Testy przeglądarkowe uruchamiaj dla zmienianej ścieżki.
Używają izolowanego profilu i sztucznych danych; nie kieruj ich do stage z kontami
użytkownika. Lokalny PASS nie zastępuje CI ani realnego odbioru.

Po załadowaniu poprawionego artefaktu odtwórz oryginalne kroki na witrynie.
Raportuj osobno: fixture RED→GREEN, Chromium PASS/FAIL i witryna PASS/FAIL lub
niesprawdzona. Dla strony z etapami zapisz stan tarczy na każdym z nich.
CAPTCHA/MFA/odmowa serwisu nie uprawniają do obejścia mechanizmu ani do ogłoszenia
nieaktualnego hasła. Nie zaliczaj już istniejącej sesji jako nowego logowania.

Macierz popularnych serwisów musi rozróżniać login/rejestrację, CLI/ręczne fill,
egzemplarz/realny odbiór oraz datę. Zielony test syntetyczny nie oznacza obsługi
całego serwisu ani ukończenia korpusu 100 Global + 100 Polska + 100 UE/UK/EFTA.
