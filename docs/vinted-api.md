# Gebruikte Vinted-endpoints

Vinted biedt geen publieke API voor verkopers. Deze extensie gebruikt dezelfde interne
endpoints als de website zelf, vanuit een content script op de Vinted-pagina — dus met
dezelfde sessiecookies en dezelfde CSRF-header als een normale klik in de interface.

Dit bestand staat hier zodat je bij een storing snel kunt zien welke aanroep faalt.
Alles staat in [`src/lib/api.js`](../src/lib/api.js).

## Lezen

| Doel | Aanroep | Terugval |
| --- | --- | --- |
| Wie ben ik | `GET /api/v2/users/current` | `GET /api/v2/user` |
| Mijn advertenties | `GET /api/v2/wardrobe/{userId}/items?page=&per_page=` | `GET /api/v2/users/{userId}/items?...` |
| Itemdetails | `GET /api/v2/item_upload/items/{id}` | `GET /api/v2/items/{id}` |

De upload-variant heeft de voorkeur: die geeft precies de velden terug die het
aanmaak-endpoint verwacht. De publieke variant heeft een andere vorm (`brand_dto` in
plaats van `brand_id`/`brand`, `color1_id`/`color2_id` in plaats van `color_ids`);
`normalizeItem()` in [`src/lib/item-mapper.js`](../src/lib/item-mapper.js) vangt beide af.

## Schrijven

| Doel | Aanroep |
| --- | --- |
| Foto uploaden | `POST /api/v2/photos` (multipart: `photo[type]=item_photo`, `photo[temp_uuid]`, `photo[file]`) |
| Advertentie aanmaken | `POST /api/v2/item_upload/items` |
| Advertentie verwijderen | `DELETE /api/v2/items/{id}`, terugval `POST /api/v2/items/{id}/delete` |

Foto's kunnen niet worden hergebruikt tussen advertenties: ze horen bij een
upload-sessie. De extensie downloadt daarom elke foto van de oude advertentie en uploadt
hem opnieuw onder een nieuwe `temp_uuid`.

## Vorm van de aanmaak-payload

```jsonc
{
  "item": {
    "id": null,                    // nooit het oude id meesturen
    "temp_uuid": "<uuid>",         // moet gelijk zijn aan photo[temp_uuid]
    "title": "…",
    "description": "…",
    "price": "25.00",
    "currency": "EUR",
    "catalog_id": 221,
    "brand_id": 53,
    "brand": "Nike",
    "size_id": 207,
    "status_id": 2,
    "package_size_id": 2,
    "color_ids": [1],
    "assigned_photos": [{ "id": 501, "orientation": 0, "position": 0 }],
    "item_attributes": [{ "code": "material", "ids": [12] }],
    "measurement_length": null,
    "measurement_width": null
  },
  "upload_session_id": "<uuid>",
  "push_up": false,                // true zou een betaalde bump kopen
  "feedback_id": null,
  "parcel": null
}
```

`push_up` staat hard op `false`. Dat is een betaalde functie; die mag deze extensie nooit
ongevraagd aanzetten.

## Headers

De extensie stuurt exact wat de Vinted-webapp zelf ook stuurt, niet meer:

| Header | Herkomst | Waarom |
| --- | --- | --- |
| `X-CSRF-Token` | `meta[name=csrf-token]` op de pagina, of de Next.js-bootstrap | Vereist voor schrijfacties |
| `X-Anon-Id` | de `anon_id`-cookie | Meerdere routes antwoorden `403` zonder deze header, ook met een geldige sessie |

Een extra header die de echte site *niet* stuurt (zoals `X-Requested-With`) laat het
verzoek juist opvallen bij de bot-bescherming en kan een `403` opleveren terwijl er niets
mis is met de sessie. Voeg er dus niets aan toe zonder na te kijken of vinted.nl dat zelf
ook doet, in het netwerktabblad van DevTools.

## Foutafhandeling

`VintedApi.request()` probeert het opnieuw bij `429` en `5xx`, met exponentiële backoff en
jitter. Bij `401`/`403` stopt het meteen met de melding dat de sessie verlopen is; bij
`422` weigert Vinted de gegevens en staat de reden meestal in het antwoord — die komt in
de log terecht.

## De endpoints opnieuw achterhalen

Zijn de paden hierboven verouderd, dan hoeft er niets geraden te worden. De extensie
neemt op welke API-paden de Vinted-site zélf aanroept
(`src/content/api-recorder.js`, draait in de pagina-context omdat een content script
zijn eigen `window.fetch` heeft en dus niets van het paginaverkeer ziet).

Open Vinted, ga naar je kledingkast, ververs de pagina, en kijk daarna bij
**instellingen → Waargenomen endpoints**. Verversen activeert de recorder juist, want
Chrome injecteert hem bij elke paginalading opnieuw.

Vastgelegd worden alleen de methode, het pad, de *namen* van de queryparameters en de
statuscode — genoeg om een endpoint te herkennen, en niets wat een token of persoonlijke
gegevens kan bevatten.

## Als er iets breekt

1. Draai **Verbinding testen** op de instellingenpagina (`VintedApi.diagnose()`). Die
   probeert elke leesroute los en rapporteert de statuscode per aanroep zonder af te
   breken, plus of de cookies, het CSRF-token en de `anon_id` aanwezig zijn.
2. Zet testmodus aan en start één item. De log zegt bij welke stap het misgaat.
3. Vergelijk de stap met wat de website zelf doet: open het netwerktabblad in
   DevTools en plaats handmatig een advertentie. Let ook op de headers.
4. Pas het pad of de payload aan in `src/lib/api.js` of `buildCreatePayload()`, en
   draai `npm run check`.
