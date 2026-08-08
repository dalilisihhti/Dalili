// خادم "رفيقي" — يجلب صيدليات وعيادات قريبة من موقع المستخدم.
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || null;
const PORT = process.env.PORT || 3000;
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

if (!GOOGLE_API_KEY) {
  console.log('لا يوجد مفتاح Google — سيعمل التطبيق بـ OpenStreetMap فقط.');
}

const SPECIALTY_KEYWORDS = {
  'اسنان': ['أسنان', 'اسنان', 'dent'],
  'عيون': ['عيون', 'عين', 'ophthalm', 'eye'],
  'اطفال': ['أطفال', 'اطفال', 'pediatr', 'paediatr'],
  'جلدية': ['جلدية', 'جلد', 'dermat'],
  'عظام': ['عظام', 'orthoped'],
  'نساء': ['نساء', 'توليد', 'gynec', 'maternity'],
  'عام': [],
};

function formatOverpassElement(el) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat === undefined || lng === undefined) return null;
  return {
    name: tags['name:ar'] || tags.name || 'بدون اسم',
    address: [tags['addr:street'], tags['addr:city']].filter(Boolean).join('، ') || null,
    phone: tags.phone || tags['contact:phone'] || null,
    lat,
    lng,
    open: null,
    _rawText: `${tags.name || ''} ${tags['healthcare:speciality'] || ''} ${tags.healthcare || ''}`.toLowerCase(),
  };
}

async function fetchFromOSM({ amenities, lat, lng, radius }) {
  const clauses = amenities
    .map(
      (a) => `
      node["amenity"="${a}"](around:${radius},${lat},${lng});
      way["amenity"="${a}"](around:${radius},${lat},${lng});`
    )
    .join('');
  const query = `[out:json][timeout:20];(${clauses});out center tags 20;`;

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error('Overpass request failed: ' + res.status);
  const data = await res.json();
  return (data.elements || [])
    .map(formatOverpassElement)
    .filter(Boolean)
    .filter((p) => p.name !== 'بدون اسم');
}

async function fetchFromGoogle({ query, lat, lng, radius }) {
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_API_KEY,
      'X-Goog-FieldMask': [
        'places.displayName',
        'places.formattedAddress',
        'places.location',
        'places.internationalPhoneNumber',
        'places.currentOpeningHours.openNow',
      ].join(','),
    },
    body: JSON.stringify({
      textQuery: query,
      languageCode: 'ar',
      locationBias: {
        circle: { center: { latitude: parseFloat(lat), longitude: parseFloat(lng) }, radius },
      },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Google Places error: ' + JSON.stringify(data));
  return (data.places || []).map((p) => ({
    name: p.displayName?.text || 'بدون اسم',
    address: p.formattedAddress || '',
    phone: p.internationalPhoneNumber || null,
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    open: p.currentOpeningHours?.openNow ?? null,
  }));
}

app.get('/api/search', async (req, res) => {
  const { type, specialty, lat, lng } = req.query;
  const radius = parseFloat(req.query.radius) || 3000;

  if (!type || !lat || !lng) {
    return res.status(400).json({ error: 'الحقول المطلوبة: type, lat, lng' });
  }

  const amenities = type === 'pharmacy' ? ['pharmacy'] : ['clinic', 'doctors', 'hospital'];

  let results = [];
  let source = 'osm';

  try {
    results = await fetchFromOSM({ amenities, lat, lng, radius });
    if (type === 'clinic' && specialty && SPECIALTY_KEYWORDS[specialty]?.length) {
      const keywords = SPECIALTY_KEYWORDS[specialty];
      const filtered = results.filter((r) => keywords.some((k) => r._rawText.includes(k.toLowerCase())));
      if (filtered.length >= 2) results = filtered;
    }
    results.forEach((r) => delete r._rawText);
  } catch (err) {
    console.warn('تعذر الوصول لـ OpenStreetMap:', err.message);
    results = [];
  }

  if (results.length < 2 && GOOGLE_API_KEY) {
    try {
      const specLabel = specialty && specialty !== 'عام' ? ' ' + specialty : '';
      const q = type === 'pharmacy' ? 'صيدلية' : 'عيادة' + specLabel;
      const googleResults = await fetchFromGoogle({ query: q, lat, lng, radius });
      if (googleResults.length > results.length) {
        results = googleResults;
        source = 'google';
      }
    } catch (err) {
      console.warn('تعذر الوصول لـ Google Places:', err.message);
    }
  }

  res.json({ results, source });
});

app.get('/', (req, res) => {
  res.send('خادم رفيقي يعمل ✅ — جرّب: /api/search?type=pharmacy&lat=33.31&lng=44.36');
});

app.listen(PORT, () => {
  console.log(`الخادم يعمل على المنفذ ${PORT}`);
});
