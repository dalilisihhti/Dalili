// خادم "رفيقي" — يجلب صيدليات وعيادات قريبة من موقع المستخدم.
//
// المصدر الأساسي: OpenStreetMap (عبر Overpass API) — مجاني بالكامل وللأبد، بلا مفتاح وبلا فوترة.
// المصدر الاحتياطي: Google Places — يُستخدم فقط إذا كانت نتائج OpenStreetMap قليلة/ناقصة
//                    في منطقتك، وفقط إن كان مفتاح Google موجودًا في .env (اختياري تمامًا).
//
// بهذا الشكل: لو لم تُفعّل Google إطلاقًا، يبقى التطبيق يعمل مجانًا 100% دائمًا.

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || null;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || null;
const PORT = process.env.PORT || 3000;
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

if (!GOOGLE_API_KEY) {
  console.log('ملاحظة: لا يوجد مفتاح Google — سيعمل التطبيق بـ OpenStreetMap فقط (مجاني بالكامل).');
}

// خرائط الكلمات المفتاحية للتعرف على التخصص داخل بيانات OpenStreetMap
// (لأن OSM لا يملك حقل "تخصص" موحّدًا لكل التخصصات، نبحث عن الكلمة داخل الاسم والوسوم
// حين لا يوجد تصنيف OSM مخصص. لطب الأسنان تحديدًا يوجد تصنيف "dentist" دقيق ومنتشر، فنستخدمه مباشرة)
const SPECIALTY_KEYWORDS = {
  'اسنان': ['أسنان', 'اسنان', 'dent'],
  'عيون': ['عيون', 'عين', 'ophthalm', 'eye', 'optometr'],
  'اطفال': ['أطفال', 'اطفال', 'pediatr', 'paediatr'],
  'جلدية': ['جلدية', 'جلد', 'dermat'],
  'عظام': ['عظام', 'orthoped'],
  'نساء': ['نساء', 'توليد', 'gynec', 'maternity'],
  'عام': [], // بدون فلترة تخصص
};

// أي تصنيفات OSM (amenity) نبحث فيها لكل تخصص. الأسنان لها تصنيف مخصص ودقيق في OSM.
const SPECIALTY_AMENITIES = {
  'اسنان': ['dentist'],
  'عام': ['clinic', 'doctors', 'hospital'],
  'default': ['clinic', 'doctors', 'hospital'], // البقية تُفلتَر بالكلمات المفتاحية داخل هذا النطاق
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
    open: null, // OpenStreetMap لا يوفر عادة حالة "مفتوح الآن" الموثوقة
    _rawText: `${tags.name || ''} ${tags['healthcare:speciality'] || ''} ${tags.healthcare || ''}`.toLowerCase(),
  };
}

// يبني ويرسل استعلام Overpass QL ويعيد قائمة أماكن منسّقة
async function fetchFromOSM({ amenities, lat, lng, radius }) {
  const clauses = amenities
    .map(
      (a) => `
      node["amenity"="${a}"](around:${radius},${lat},${lng});
      way["amenity"="${a}"](around:${radius},${lat},${lng});`
    )
    .join('');
  const query = `[out:json][timeout:20];(${clauses});out center tags 20;`;

  let lastError = null;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'RafiqiPharmacyFinder/1.0 (accessibility app for pharmacy/clinic search)',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) {
        lastError = new Error('Overpass request failed: ' + res.status + ' (' + url + ')');
        continue; // جرّب الرابط التالي بدل الفشل الفوري
      }
      const data = await res.json();
      return (data.elements || [])
        .map(formatOverpassElement)
        .filter(Boolean)
        .filter((p) => p.name !== 'بدون اسم'); // نتجاهل عناصر بلا اسم لتحسين جودة النتائج
    } catch (err) {
      lastError = err;
      continue;
    }
  }
  throw lastError || new Error('All Overpass mirrors failed');
}

// احتياطي: Google Places (Text Search) — يُستدعى فقط عند الحاجة وإن توفر المفتاح
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

// نقطة الوصول الرئيسية التي يستدعيها التطبيق
// أمثلة:
//   /api/search?type=pharmacy&lat=33.31&lng=44.36&radius=3000
//   /api/search?type=clinic&specialty=اسنان&lat=33.31&lng=44.36&radius=5000
app.get('/api/search', async (req, res) => {
  const { type, specialty, lat, lng } = req.query;
  const radius = parseFloat(req.query.radius) || 3000;

  if (!type || !lat || !lng) {
    return res.status(400).json({ error: 'الحقول المطلوبة: type, lat, lng' });
  }

  let amenities;
  if (type === 'pharmacy') {
    amenities = ['pharmacy'];
  } else if (specialty && SPECIALTY_AMENITIES[specialty]) {
    amenities = SPECIALTY_AMENITIES[specialty]; // مثلاً: الأسنان لها تصنيف OSM مخصص ودقيق
  } else {
    amenities = SPECIALTY_AMENITIES.default;
  }

  let results = [];
  let source = 'osm';

  try {
    results = await fetchFromOSM({ amenities, lat, lng, radius });

    // فلترة صادقة حسب التخصص: لا نستبدل نتيجة فارغة أو قليلة ببيانات عامة غير مطابقة —
    // إن لم تُطابق بيانات OSM هذا التخصص تحديدًا، نعرض ذلك بصدق بدل تكرار نفس القائمة لكل تخصص.
    if (type === 'clinic' && specialty && specialty !== 'عام' && SPECIALTY_KEYWORDS[specialty]?.length) {
      const keywords = SPECIALTY_KEYWORDS[specialty];
      results = results.filter((r) => keywords.some((k) => r._rawText.includes(k.toLowerCase())));
    }
    results.forEach((r) => delete r._rawText);
  } catch (err) {
    console.warn('تعذر الوصول لـ OpenStreetMap:', err.message);
    results = [];
  }

  // احتياطي Google: فقط إذا كانت نتائج OSM قليلة (أقل من 2) والمفتاح متوفر
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

// نقطة اتصال جديدة: تفريغ صوتي دقيق عبر Whisper (OpenAI)
// الواجهة ترسل مقطعًا صوتيًا خامًا (audio/webm عادة)، ويعيد هذا المسار النص المُفرَّغ.
// المفتاح يبقى سريًا هنا في الخادم فقط، تمامًا كمفتاح Google.
app.post('/api/transcribe', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'الخادم غير مهيأ بمفتاح OpenAI بعد' });
  }
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'لم يصل أي صوت' });
  }

  try {
    const lang = req.query.lang === 'en' ? 'en' : 'ar';
    const form = new FormData();
    form.append('file', new Blob([req.body], { type: req.headers['content-type'] || 'audio/webm' }), 'audio.webm');
    form.append('model', 'whisper-1');
    form.append('language', lang);

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    const data = await r.json();
    if (!r.ok) {
      console.warn('Whisper error:', data);
      return res.status(r.status).json({ error: 'فشل التفريغ الصوتي', details: data });
    }
    res.json({ text: data.text || '' });
  } catch (err) {
    console.warn('Transcribe error:', err.message);
    res.status(500).json({ error: 'خطأ غير متوقع في التفريغ الصوتي' });
  }
});

// نقطة اتصال جديدة: فهم القصد من نص طبيعي (بعد تفريغه صوتيًا) عبر Claude.
// تُرجع إجراءً محددًا (intent) بدل الاعتماد فقط على مطابقة كلمات مفتاحية صارمة.
const VALID_INTENTS = ['nearby_pharmacy', 'on_duty_pharmacy', 'clinic', 'order_medicine', 'emergency', 'help', 'back', 'unknown'];
const VALID_SPECIALTIES = ['عام', 'اسنان', 'عيون', 'اطفال', 'جلدية', 'عظام', 'نساء'];

app.post('/api/understand', express.json({ limit: '200kb' }), async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'الخادم غير مهيأ بمفتاح OpenRouter بعد' });
  }
  const text = (req.body && req.body.text || '').trim();
  const lang = req.body && req.body.lang === 'en' ? 'en' : 'ar';
  if (!text) {
    return res.status(400).json({ error: 'لم يصل أي نص' });
  }

  const systemPrompt = `You classify a spoken request to a pharmacy/clinic-finder accessibility app (users may be illiterate or speak Moroccan Darija / mixed Arabic-French, transcribed imperfectly). Reply with ONLY a compact JSON object, no other text, matching exactly this shape:
{"intent": one of ${JSON.stringify(VALID_INTENTS)}, "specialty": one of ${JSON.stringify(VALID_SPECIALTIES)} or null (only when intent is "clinic"), "medicine": string or null (only when intent is "order_medicine" and a medicine name was said)}
Rules: "nearby_pharmacy" = wants any nearby pharmacy. "on_duty_pharmacy" = wants a night/duty pharmacy ("garde"/"حراسة"). "clinic" = wants a doctor/clinic (infer specialty from symptoms if possible, e.g. tooth pain -> اسنان). "order_medicine" = wants a specific medicine. "emergency" = urgent/ambulance/danger. "help" = asking how the app works. "back" = wants to go to the home screen. "unknown" = unclear or unrelated. Be lenient with transcription noise/typos and mixed languages; infer the most likely real intent.`;

  try {
    // OpenRouter uses an OpenAI-compatible chat completions format
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        max_tokens: 200,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.warn('OpenRouter error:', data);
      return res.status(r.status).json({ error: 'فشل فهم الطلب', details: data });
    }
    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (parseErr) {
      return res.status(502).json({ error: 'رد غير متوقع من النموذج', raw });
    }
    if (!VALID_INTENTS.includes(parsed.intent)) parsed.intent = 'unknown';
    if (!VALID_SPECIALTIES.includes(parsed.specialty)) parsed.specialty = null;
    res.json(parsed);
  } catch (err) {
    console.warn('Understand error:', err.message);
    res.status(500).json({ error: 'خطأ غير متوقع في فهم الطلب' });
  }
});

app.get('/', (req, res) => {
  res.send(
    'خادم رفيقي يعمل ✅ (OpenStreetMap مجاني كمصدر أساسي' +
      (GOOGLE_API_KEY ? '، Google Places كاحتياطي' : '، بدون Google') +
      (OPENAI_API_KEY ? '، Whisper مفعّل للتفريغ الصوتي' : '') +
      (OPENROUTER_API_KEY ? '، Claude (عبر OpenRouter) مفعّل لفهم القصد' : '') +
      ') — جرّب: /api/search?type=pharmacy&lat=33.31&lng=44.36'
  );
});

app.listen(PORT, () => {
  console.log(`الخادم يعمل على المنفذ ${PORT}`);
});
