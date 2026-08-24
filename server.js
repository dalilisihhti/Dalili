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
const OPENPLACES_API_KEY = process.env.OPENPLACES_API_KEY || null;
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

// أي تصنيفات OSM (amenity) إضافية نبحث فيها لكل تخصص، فوق النطاق العام (عيادة/طبيب/مستشفى) دائمًا.
// مثلاً: الأسنان لها تصنيف "dentist" مخصص في OSM، لكن كثيرًا من عيادات الأسنان الحقيقية
// لا تزال مُصنَّفة تحت "clinic" العام أيضًا — لذلك نبحث في الاثنين معًا، لا نستبدل أحدهما بالآخر.
const SPECIALTY_EXTRA_AMENITIES = {
  'اسنان': ['dentist'],
};
const DEFAULT_CLINIC_AMENITIES = ['clinic', 'doctors', 'hospital'];

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
    _amenity: tags.amenity || null,
    _rawText: `${tags.name || ''} ${tags['healthcare:speciality'] || ''} ${tags.healthcare || ''}`.toLowerCase(),
  };
}

// حساب المسافة الحقيقية بين نقطتين (متر) — نستخدمها لترتيب النتائج قبل أي قصّ للعدد،
// حتى لا تُستبعد الأماكن القريبة الفعلية لصالح أماكن بعيدة عشوائية عند توسيع نطاق البحث.
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// يبني ويرسل استعلام Overpass QL ويعيد قائمة أماكن منسّقة، مرتّبة من الأقرب فعليًا
async function fetchFromOSM({ amenities, lat, lng, radius }) {
  const clauses = amenities
    .map(
      (a) => `
      node["amenity"="${a}"](around:${radius},${lat},${lng});
      way["amenity"="${a}"](around:${radius},${lat},${lng});`
    )
    .join('');
  // نطلب عددًا أكبر من العينات (80 بدل 20) لأن النطاق قد يكون واسعًا الآن،
  // ثم نرتّبها بالمسافة الحقيقية أدناه قبل أي قصّ — لا نعتمد على ترتيب Overpass الخام إطلاقًا.
  const query = `[out:json][timeout:25];(${clauses});out center tags 80;`;

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
      const parsed = (data.elements || [])
        .map(formatOverpassElement)
        .filter(Boolean)
        .filter((p) => p.name !== 'بدون اسم'); // نتجاهل عناصر بلا اسم لتحسين جودة النتائج

      // الترتيب الفعلي بالمسافة الحقيقية، ثم قصّ العدد لأقرب 40 فقط بعد الترتيب —
      // هذا يضمن أن توسيع النطاق يُضيف خيارات أبعد دون أن "يُزيح" الأقرب منها.
      parsed.forEach((p) => { p._distMeters = haversineMeters(lat, lng, p.lat, p.lng); });
      parsed.sort((a, b) => a._distMeters - b._distMeters);
      parsed.forEach((p) => { delete p._distMeters; });
      return parsed.slice(0, 40);
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

// كلمة بحث ممثّلة لكل تخصص، لأن بيانات Overture غالبًا مُصنَّفة/مُسمّاة بالإنجليزية أو الفرنسية
const OPENPLACES_QUERY_TERMS = {
  pharmacy: 'pharmacy',
  'عام': 'clinic',
  'اسنان': 'dentist',
  'عيون': 'ophthalmologist',
  'اطفال': 'pediatrician',
  'جلدية': 'dermatologist',
  'عظام': 'orthopedic clinic',
  'نساء': 'gynecologist',
};

// احتياطي ثانٍ: Open Places API (مبني على بيانات Overture المفتوحة — مجاني حتى 10,000 طلب/شهر،
// وأرخص بكثير من جوجل بعدها). يُستخدم فقط إن كانت نتائج OpenStreetMap ما زالت قليلة.
async function fetchFromOpenPlaces({ term, lat, lng, radius }) {
  const radiusMiles = (radius / 1609.34).toFixed(2);
  const url =
    'https://api.openplacesapi.com/v1/places?' +
    new URLSearchParams({ q: term, lat: String(lat), lon: String(lng), radius_mi: radiusMiles, limit: '20' });

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${OPENPLACES_API_KEY}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Open Places API error: ' + JSON.stringify(data));

  // معالجة متسامحة لأسماء الحقول (التوثيق العام لا يحدد الشكل الدقيق لكل حقل بيقين تام)
  return (data.results || [])
    .map((p) => ({
      name: p.name || p.display_name || 'بدون اسم',
      address: p.address || p.formatted_address || null,
      phone: p.phone || p.tel || p.phone_number || null,
      lat: p.lat ?? p.latitude,
      lng: p.lon ?? p.lng ?? p.longitude,
      open: p.open_now ?? null,
    }))
    .filter((p) => p.lat !== undefined && p.lng !== undefined && p.name !== 'بدون اسم');
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
  } else {
    // نبحث دائمًا في النطاق العام (عيادة/طبيب/مستشفى)، ونضيف إليه أي تصنيف OSM مخصص
    // للتخصص المطلوب (كالأسنان) بدل استبداله — بعض الأماكن الحقيقية مصنّفة تحت التصنيف
    // العام فقط، وأخرى تحت التصنيف المخصص فقط، فنغطي الاثنين معًا.
    const extra = (specialty && SPECIALTY_EXTRA_AMENITIES[specialty]) || [];
    amenities = [...new Set([...DEFAULT_CLINIC_AMENITIES, ...extra])];
  }

  let results = [];
  let source = 'osm';

  try {
    results = await fetchFromOSM({ amenities, lat, lng, radius });

    // فلترة صادقة حسب التخصص: نقبل أي مكان مُصنَّف مباشرة تحت الوسم المخصص لهذا التخصص
    // (مثل amenity=dentist) تلقائيًا، أو أي مكان تطابقت كلماته المفتاحية (اسمه أو وسومه) —
    // لا نستبدل نتيجة فارغة أو قليلة ببيانات عامة غير مطابقة.
    if (type === 'clinic' && specialty && specialty !== 'عام') {
      const dedicatedAmenities = SPECIALTY_EXTRA_AMENITIES[specialty] || [];
      const keywords = SPECIALTY_KEYWORDS[specialty] || [];
      results = results.filter((r) =>
        dedicatedAmenities.includes(r._amenity) || keywords.some((k) => r._rawText.includes(k.toLowerCase()))
      );
    }
    results.forEach((r) => { delete r._rawText; delete r._amenity; });
  } catch (err) {
    console.warn('تعذر الوصول لـ OpenStreetMap:', err.message);
    results = [];
  }

  // احتياطي أول: Open Places API — فقط إذا كانت نتائج OSM قليلة (أقل من 2) والمفتاح متوفر.
  // نجرّبه قبل جوجل لأنه أرخص بكثير ويسمح بتخزين النتائج، ونستخدمه فقط إن حسّن العدد فعليًا.
  if (results.length < 2 && OPENPLACES_API_KEY) {
    try {
      const term = type === 'pharmacy' ? OPENPLACES_QUERY_TERMS.pharmacy : (OPENPLACES_QUERY_TERMS[specialty] || OPENPLACES_QUERY_TERMS['عام']);
      const openPlacesResults = await fetchFromOpenPlaces({ term, lat, lng, radius });
      if (openPlacesResults.length > results.length) {
        results = openPlacesResults;
        source = 'openplaces';
      }
    } catch (err) {
      console.warn('تعذر الوصول لـ Open Places API:', err.message);
    }
  }

  // احتياطي ثانٍ: Google — فقط إذا بقيت النتائج قليلة (أقل من 2) والمفتاح متوفر
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
      (OPENPLACES_API_KEY ? '، Open Places API كاحتياطي' : '') +
      (OPENAI_API_KEY ? '، Whisper مفعّل للتفريغ الصوتي' : '') +
      (OPENROUTER_API_KEY ? '، Claude (عبر OpenRouter) مفعّل لفهم القصد' : '') +
      ') — جرّب: /api/search?type=pharmacy&lat=33.31&lng=44.36'
  );
});

app.listen(PORT, () => {
  console.log(`الخادم يعمل على المنفذ ${PORT}`);
});
