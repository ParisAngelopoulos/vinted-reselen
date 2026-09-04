# Gebruikte Vinted-endpoints

Vinted biedt geen publieke API voor verkopers. Deze extensie gebruikt dezelfde interne
endpoints als de website zelf, vanuit een content script op de Vinted-pagina — dus met
dezelfde sessiecookies en dezelfde CSRF-header als een normale klik in de interface.

Dit bestand staat hier zodat je bij een storing snel kunt zien welke aanroep faalt.
Alles staat in [`src/lib/api.js`](../src/lib/api.js).

## Lezen

| Doel | Aanroep | Terugval |
| --- | --- | --- |
| Mijn advertenties | `GET /api/v2/wardrobe/{userId}/items?order=&page=&per_page=` | `GET /api/v2/users/{userId}/items?...` |
| Itemdetails | `GET /api/v2/item_upload/items/{id}` | `GET /api/v2/items/{id}` |

### Het gebruikers-id komt uit de pagina

`GET /api/v2/users/current` werkt wel degelijk, maar alleen mét de Accept-header; zonder
die header serveert Rails de HTML-pagina en lijkt het endpoint dood. Het id wordt
desondanks uit de pagina gelezen: dat is één netwerkverzoek minder en het staat gewoon in
de URL van je profiel.

De volgorde
([`src/lib/user-id.js`](../src/lib/user-id.js)):

1. handmatig ingevuld bij de instellingen;
2. de URL van de profielpagina die open staat (`/member/3152705349`);
3. een eerder herkend profiel;
4. een waargenomen `GET /api/v2/wardrobe/{id}/items` van de site zelf.

Dat is robuuster dan een endpoint: het id staat gewoon in de URL van je profiel.

De upload-variant heeft de voorkeur: die geeft precies de velden terug die het
aanmaak-endpoint verwacht. De publieke variant heeft een andere vorm (`brand_dto` in
plaats van `brand_id`/`brand`, `color1_id`/`color2_id` in plaats van `color_ids`);
`normalizeItem()` in [`src/lib/item-mapper.js`](../src/lib/item-mapper.js) vangt beide af.

## Foto's ophalen

De foto's van een bestaande advertentie staan niet op de site zelf maar op
`images*.vinted.net` (het veld `photos[].full_size_url`). Voor een content script op
`vinted.<tld>` is dat een andere origin, en sinds Chrome 85 gelden daarvoor de
CORS-regels van de pagina in plaats van de host-rechten van de extensie. De CDN stuurt
geen `Access-Control-Allow-Origin`, dus daar lezen mislukt met een kale
`TypeError: Failed to fetch` — zonder statuscode, wat het lastig te herkennen maakt.

De service worker heeft die host-rechten wél. Het downloaden gebeurt daarom in
[`src/background/service-worker.js`](../src/background/service-worker.js) (`fetchPhoto`,
zonder cookies) en de bytes gaan als data-URL terug naar het content script, omdat
`chrome.runtime`-berichten JSON zijn en een `Blob` daar niet doorheen komt.

Staat `*://*.vinted.net/*` niet bij `host_permissions` in `manifest.json`, dan faalt dit
alsnog — de foutmelding noemt dan het domein dat ontbreekt.

## Schrijven

| Doel | Aanroep |
| --- | --- |
| Foto uploaden | `POST /api/v2/photos` (multipart, in deze volgorde: `photo[type]=item_photo`, `photo[file]`, `photo[temp_uuid]`) |
| Advertentie aanmaken | `POST /api/v2/item_upload/items` |
| Advertentie verwijderen | `DELETE /api/v2/items/{id}`, terugval `POST /api/v2/items/{id}/delete` |

De **volgorde** van de multipart-velden is overgenomen van wat de site zelf stuurt. Bij
multipart is de volgorde onderdeel van het verzoek: een parser die het bestand streamt
terwijl het binnenkomt kan afhangen van welke velden eraan voorafgaan. Een vergelijking op
veldnamen als verzameling meldde daardoor ten onrechte "komt overeen".

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
| `Accept: application/json, …` | vast | **Op elk verzoek.** Vinted draait op Rails en doet content-negotiation: een aanroep die niet om JSON vraagt krijgt de HTML-pagina in plaats van API-gegevens. Dat leest als "geblokkeerd" terwijl het endpoint prima werkt. |
| `X-CSRF-Token` | `meta[name=csrf-token]` op de pagina, of de Next.js-bootstrap | Vereist voor schrijfacties; op het huidige Vinted vaak afwezig |
| `X-Anon-Id` | de `anon_id`-cookie | De site stuurt deze bij elke API-aanroep mee |

De opname bij **Waargenomen endpoints** noteert ook de *namen* van de headers die de site
zelf meestuurt. Dat is de snelste manier om te zien of de extensie iets mist.

### Het CSRF-token wordt afgekeken van de site

Zonder `X-CSRF-Token` weigert Vinted elke schrijfactie (`403`, `"Accès refusé"`) terwijl
alle leesacties gewoon werken — een asymmetrie die zich voordoet als "hij haalt mijn
advertenties op maar plaatst niets terug".

Het token staat niet in een cookie en niet in een meta-tag. Waar het huidige front-end het
bewaart doet er ook niet toe: `src/content/api-recorder.js` draait in de pagina-context en
leest de waarde af van de verzoeken die de site zelf doet. Dat is per definitie het juiste
token, ongeacht waar Vinted het vandaan haalt.

Naast de headernamen legt de opname ook de *veldnamen* van een schrijfactie vast
(`photo[type]`, `photo[file] (bestand)`, …). Een multipart-upload wordt gedefinieerd door
zijn veldnamen; de waarden en de bestandsinhoud worden nooit bewaard.

Dit is de enige header*waarde* die wordt vastgelegd; van alle andere worden alleen de
namen bewaard. Het token gaat naar `chrome.storage.session` van de service worker: alleen
in het geheugen, nooit naar schijf, weg zodra de browser sluit. Het verlaat het apparaat
niet en wordt alleen gebruikt voor verzoeken die de ingelogde gebruiker zelf ook met de
hand kan doen.

Gevolg voor het gebruik: de extensie heeft één paginalading op Vinted nodig voordat
schrijfacties werken. De verbindingstest meldt of er een token beschikbaar is.

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

Open je eigen Vinted-profiel (de pagina met je advertenties), ververs die, en kijk bij
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
