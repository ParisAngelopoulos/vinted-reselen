/**
 * Pure helpers that turn a Vinted item (as returned by the API) into the
 * payload needed to create an identical new listing.
 *
 * No browser or chrome.* APIs are used here so this module can be unit tested
 * in plain Node.
 */

/** Fields Vinted echoes back that must never be copied onto a new listing. */
const NON_COPYABLE = new Set([
  'id',
  'user_id',
  'created_at',
  'created_at_ts',
  'updated_at',
  'updated_at_ts',
  'view_count',
  'favourite_count',
  'url',
  'path',
  'promoted',
  'is_closed',
  'is_hidden',
  'is_reserved',
  'is_visible',
  'reservation',
  'transaction_id',
  'stats',
]);

/**
 * Vinted returns prices as `12.5`, `"12.50"` or `{amount: "12.50",
 * currency_code: "EUR"}` depending on the endpoint. Reduce all of those to a
 * plain decimal string, or null when there is no usable value.
 */
export function extractAmount(price) {
  if (price === null || price === undefined) return null;
  if (typeof price === 'number') return Number.isFinite(price) ? price.toFixed(2) : null;
  if (typeof price === 'string') {
    const n = Number(price.replace(',', '.'));
    return Number.isFinite(n) ? n.toFixed(2) : null;
  }
  if (typeof price === 'object') {
    return extractAmount(price.amount ?? price.value ?? null);
  }
  return null;
}

export function extractCurrency(price, fallback = 'EUR') {
  if (price && typeof price === 'object') {
    return price.currency_code || price.currency || fallback;
  }
  return fallback;
}

/** Collect colour ids from either the upload shape or the public shape. */
function extractColorIds(raw) {
  if (Array.isArray(raw.color_ids) && raw.color_ids.length) {
    return raw.color_ids.filter((id) => Number.isInteger(id) && id > 0);
  }
  return [raw.color1_id, raw.color2_id]
    .filter((id) => Number.isInteger(id) && id > 0);
}

/** Photos differ per endpoint; keep the highest quality URL we can find. */
function extractPhotos(raw) {
  const photos = Array.isArray(raw.photos) ? raw.photos : [];
  return photos
    .map((photo, index) => {
      const url =
        photo.full_size_url ||
        photo.high_resolution?.full_size_url ||
        photo.url ||
        photo.image_url ||
        null;
      if (!url) return null;
      return {
        url,
        originalId: photo.id ?? null,
        orientation: Number.isInteger(photo.orientation) ? photo.orientation : 0,
        index,
      };
    })
    .filter(Boolean);
}

/** Attribute blocks (e.g. material, sport type) used by newer upload forms. */
function extractAttributes(raw) {
  const attrs = raw.item_attributes ?? raw.attributes;
  if (!Array.isArray(attrs)) return [];
  return attrs
    .map((attr) => {
      const code = attr.code ?? attr.attribute_code ?? null;
      if (!code) return null;
      const ids = Array.isArray(attr.ids)
        ? attr.ids
        : Array.isArray(attr.value_ids)
          ? attr.value_ids
          : attr.id !== undefined
            ? [attr.id]
            : [];
      const cleaned = ids.filter((id) => Number.isInteger(id) && id > 0);
      if (!cleaned.length) return null;
      return { code, ids: cleaned };
    })
    .filter(Boolean);
}

/**
 * Reduce any of the item shapes Vinted returns to one canonical object.
 * Unknown/absent fields become null rather than being invented.
 */
export function normalizeItem(rawInput) {
  const raw = rawInput?.item ?? rawInput ?? {};

  const brandId = raw.brand_id ?? raw.brand_dto?.id ?? null;
  const brandTitle = raw.brand ?? raw.brand_dto?.title ?? raw.brand_title ?? null;

  return {
    id: raw.id ?? null,
    title: raw.title ?? '',
    description: raw.description ?? '',
    price: extractAmount(raw.price),
    currency: extractCurrency(raw.price, raw.currency || 'EUR'),
    catalogId: raw.catalog_id ?? null,
    brandId: Number.isInteger(brandId) && brandId > 0 ? brandId : null,
    brandTitle: brandTitle || null,
    sizeId: raw.size_id ?? null,
    statusId: raw.status_id ?? null,
    packageSizeId: raw.package_size_id ?? raw.shipment_package_size_id ?? null,
    colorIds: extractColorIds(raw),
    isUnisex: raw.is_unisex ? 1 : 0,
    isbn: raw.isbn ?? null,
    manufacturer: raw.manufacturer ?? null,
    manufacturerLabelling: raw.manufacturer_labelling ?? null,
    videoGameRatingId: raw.video_game_rating_id ?? null,
    measurementLength: raw.measurement_length ?? null,
    measurementWidth: raw.measurement_width ?? null,
    attributes: extractAttributes(raw),
    photos: extractPhotos(raw),
    shipmentPrices: raw.shipment_prices ?? null,
    // Flags used to decide whether an item may be touched at all.
    isSold: Boolean(raw.is_closed || raw.is_sold || raw.transaction_id),
    isReserved: Boolean(raw.is_reserved || raw.reservation),
    isHidden: Boolean(raw.is_hidden),
    isDraft: Boolean(raw.is_draft),
    createdAtTs: raw.created_at_ts ?? raw.created_at ?? null,
  };
}

/**
 * Apply the configured price rule. Returns a decimal string.
 * Never returns less than `minPrice`, and never returns null when the original
 * price was known.
 */
export function computeNewPrice(originalPrice, settings = {}) {
  const amount = extractAmount(originalPrice);
  // Number(null) is 0, so the null check has to happen before the conversion —
  // otherwise a price-less item would silently be listed at the minimum price.
  if (amount === null) return null;
  const base = Number(amount);
  if (!Number.isFinite(base)) return null;

  const mode = settings.priceMode || 'keep';
  const value = Number(settings.priceValue) || 0;
  const min = Number.isFinite(Number(settings.minPrice)) ? Number(settings.minPrice) : 1;

  let next = base;
  if (mode === 'percent') next = base * (1 + value / 100);
  else if (mode === 'absolute') next = base + value;

  if (!Number.isFinite(next)) return base.toFixed(2);
  next = Math.max(next, min);
  // Vinted rejects more than two decimals.
  return (Math.round(next * 100) / 100).toFixed(2);
}

/** Reasons an item should be left alone, or an empty array when it is fine. */
export function blockingReasons(item, settings = {}) {
  const reasons = [];
  if (item.isSold) reasons.push('verkocht');
  if (settings.skipReserved && item.isReserved) reasons.push('gereserveerd');
  if (item.isDraft) reasons.push('concept');
  if (!item.photos.length) reasons.push('geen foto’s');
  if (item.catalogId === null || item.catalogId === undefined) reasons.push('geen categorie');
  if (item.price === null) reasons.push('geen prijs');

  const minAgeDays = Number(settings.minAgeDays) || 0;
  if (minAgeDays > 0 && item.createdAtTs) {
    const created = new Date(item.createdAtTs).getTime();
    if (Number.isFinite(created)) {
      const ageDays = (Date.now() - created) / 86_400_000;
      if (ageDays < minAgeDays) {
        reasons.push(`jonger dan ${minAgeDays} dagen`);
      }
    }
  }
  return reasons;
}

/**
 * Build the body for POST /api/v2/item_upload/items.
 *
 * @param {ReturnType<typeof normalizeItem>} item
 * @param {{photoIds: Array<{id:number,orientation:number}>, uploadSessionId: string, tempUuid: string, price?: string}} ctx
 */
export function buildCreatePayload(item, ctx) {
  const { photoIds = [], uploadSessionId, tempUuid, price } = ctx || {};
  if (!photoIds.length) {
    throw new Error('Kan geen advertentie aanmaken zonder geüploade foto’s.');
  }

  const payload = {
    item: {
      id: null,
      currency: item.currency || 'EUR',
      temp_uuid: tempUuid,
      title: item.title,
      description: item.description,
      brand_id: item.brandId,
      brand: item.brandTitle || '',
      size_id: item.sizeId,
      catalog_id: item.catalogId,
      isbn: item.isbn,
      is_unisex: item.isUnisex,
      status_id: item.statusId,
      video_game_rating_id: item.videoGameRatingId,
      price: price ?? item.price,
      package_size_id: item.packageSizeId,
      shipment_prices: item.shipmentPrices ?? { domestic: null, international: null },
      color_ids: item.colorIds,
      assigned_photos: photoIds.map((photo, index) => ({
        id: photo.id,
        orientation: photo.orientation ?? 0,
        // Vinted keeps gallery order by the position in this array; keep ours
        // explicit so the first photo stays the cover photo.
        position: index,
      })),
      measurement_length: item.measurementLength,
      measurement_width: item.measurementWidth,
      item_attributes: item.attributes,
      manufacturer: item.manufacturer,
      manufacturer_labelling: item.manufacturerLabelling,
    },
    feedback_id: null,
    push_up: false,
    parcel: null,
    upload_session_id: uploadSessionId,
  };

  // Drop keys that are null AND optional, so we never send an explicit null
  // where Vinted expects the field to be absent.
  for (const key of ['isbn', 'video_game_rating_id', 'manufacturer', 'manufacturer_labelling']) {
    if (payload.item[key] === null) delete payload.item[key];
  }
  return payload;
}

/** Guard used when copying raw fields: never carry identity/state over. */
export function isCopyableField(key) {
  return !NON_COPYABLE.has(key);
}

/** Short human label for logs and the UI. */
export function describeItem(item) {
  const bits = [item.title || `Item ${item.id}`];
  if (item.price) bits.push(`${item.price} ${item.currency}`);
  return bits.join(' — ');
}
