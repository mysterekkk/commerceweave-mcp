# CommerceWeave MCP v0.1.0

**Jeden serwer MCP. Trzy platformy sprzedażowe.** Pierwsze publiczne wydanie.

Podłącz agentów AI (Claude Code, Claude Desktop, Cursor, dowolny klient MCP ze stdio) do Allegro, Base.com i WooCommerce przez jeden lokalny serwer. Bez VPS, bez bazy danych, bez konta SaaS.

## Najważniejsze

- 9 narzędzi ujednoliconych (`commerce_*`): zamówienia ze wszystkich sklepów, niskie stany, raport magazynowy, podsumowanie sprzedaży, rozbieżności stanów, wyszukiwanie produktów.
- 26 narzędzi odczytu dla Allegro, Base.com i WooCommerce (rejestrowane dla skonfigurowanych platform).
- **Domyślnie tylko odczyt.** Zapisy (stan, cena, status zamówienia) to propozycje z widokiem przed/po, wymagające zatwierdzenia przez człowieka w terminalu; zatwierdzenia są jednorazowe, wygasają i są przypięte do dokładnego planu.
- Zaimportowane zamówienia są deduplikowane (potwierdzone vs potencjalne), waluty nie są mieszane, przychód nie jest nazywany zyskiem.
- Tryb demo na danych syntetycznych: `COMMERCEWEAVE_DEMO=true`.
- README po angielsku i po polsku.

## Uczciwy status

- Przetestowane na lokalnych serwerach implementujących udokumentowany protokół każdej platformy oraz w prawdziwych sesjach MCP po stdio. **Jeszcze nie zweryfikowane na prawdziwych kontach Allegro / Base.com / WooCommerce.**
- Niezaimplementowane: notatki do zamówień, szkice produktów, publikacja/zakończenie ofert, transport HTTP.
- Brak powiązań z Allegro, Base.com/BaseLinker ani WooCommerce. Nie zastępuje ich oficjalnych integracji.
