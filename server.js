// خادم "رفيقي" — يجلب صيدليات وعيادات قريبة من موقع المستخدم.
//
// المصدر الأساسي: OpenStreetMap (عبر Overpass API) — مجاني بالكامل وللأبد، بلا مفتاح وبلا فوترة.
// المصدر الاحتياطي: Google Places — يُستخدم فقط إذا كانت نتائج OpenStreetMap قليلة/ناقصة
//                    في منطقتك، وفقط إن كان مفتاح Google موجودًا في .env (اختياري تمامًا).
//
// بهذا الشكل: لو لم تُفعّل Google إطلاقًا، يبقى التطبيق يعمل مجانًا 100% دائمًا.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
// خلف بروكسي Railway؛ نحتاج هذا لالتقاط IP الحقيقي للمستخدم (لتحديد معدل مساهماته)
app.set('trust proxy', true);

// اللغات المدعومة فواجهات الصوت (TTS/Whisper) — أي قيمة أخرى كترجع للعربية كافتراضي
function normalizeSpeechLang(lang) {
  if (lang === 'en' || lang === 'fr') return lang;
  return 'ar';
}

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || null;
const OPENPLACES_API_KEY = process.env.OPENPLACES_API_KEY || null;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || null;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
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

// خدمات الرعاية الخاصة (إسعاف خاص، ممرض/ممرضة، مساعدة اجتماعية) — بلا تصنيف OSM موثوق
// يعبّر عن "خاص" تحديدًا (محطات الإسعاف فOSM غالبًا رسمية/عمومية، وHealthcare=nurse
// نادر جدًا فالمغرب)، فهذا النوع يعتمد كليًا على مساهمات المجتمع، بلا أي استعلام OSM —
// أفضل من عرض نتيجة OSM قد تكون خدمة عمومية معروضة خطأً على أنها "خاصة"
const CARE_TYPES = ['ambulance', 'nurse', 'social'];

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
// shops: تصنيفات OSM بوسم "shop" بدل "amenity" (مثلاً shop=chemist للبارافارماسي —
// المتاجر التجارية فOSM مصنّفة بوسم مختلف عن الأماكن الصحية الرسمية)
async function fetchFromOSM({ amenities = [], shops = [], lat, lng, radius }) {
  const amenityClauses = amenities
    .map(
      (a) => `
      node["amenity"="${a}"](around:${radius},${lat},${lng});
      way["amenity"="${a}"](around:${radius},${lat},${lng});`
    )
    .join('');
  const shopClauses = shops
    .map(
      (s) => `
      node["shop"="${s}"](around:${radius},${lat},${lng});
      way["shop"="${s}"](around:${radius},${lat},${lng});`
    )
    .join('');
  // نطلب عددًا أكبر من العينات (80 بدل 20) لأن النطاق قد يكون واسعًا الآن،
  // ثم نرتّبها بالمسافة الحقيقية أدناه قبل أي قصّ — لا نعتمد على ترتيب Overpass الخام إطلاقًا.
  const query = `[out:json][timeout:25];(${amenityClauses}${shopClauses});out center tags 80;`;

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
  parapharmacy: 'chemist',
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

// ==================== مساهمات المستخدمين (سد فجوات OSM محليًا) ====================
// حل لمشكلة ضعف تغطية OpenStreetMap في مناطق معينة (كإمزورن): نسمح لأي مستخدم بإضافة
// مكان جديد أو الإبلاغ عن معلومة خاطئة مباشرة من التطبيق، بدون الحاجة لقاعدة بيانات
// مخصصة — نخزّن المساهمات في ملفات JSON بسيطة على القرص:
//   - data/community-places.json: الأماكن الجديدة — تبان مباشرة فنتائج /api/search بلا
//     مراجعة إدارية (الانتظار لمراجعة يدوية كان عنق الزجاجة الحقيقي)، ومحمية بعلم مجتمعي
//     (POST /api/contribute/:id/flag) بدل ذلك — نفس منطق تبليغات الحراسة.
//   - data/pending-contributions.json: التصحيحات فقط (correctionFor) — هذي وحدها كتحتاج
//     مراجعة يدوية عبر /admin، لأنها ماعندهاش وجهة واضحة تلقائيًا (قد تخص مكانًا من OSM
//     ماعندناش عليه تحكم).
const DATA_DIR = path.join(__dirname, 'data');
const PENDING_FILE = path.join(DATA_DIR, 'pending-contributions.json');
const COMMUNITY_FILE = path.join(DATA_DIR, 'community-places.json');

function readJsonArraySafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function writeJsonArray(file, list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
}

function appendPendingContribution(entry) {
  const list = readJsonArraySafe(PENDING_FILE);
  list.push({ id: crypto.randomUUID(), ...entry });
  writeJsonArray(PENDING_FILE, list);
}

// معدّل بسيط بالذاكرة: نمنع الإغراق (spam) بلا حاجة لتسجيل دخول — 8 مساهمات كحد أقصى لكل IP في الساعة
const CONTRIBUTE_RATE_LIMIT = 8;
const CONTRIBUTE_RATE_WINDOW_MS = 60 * 60 * 1000;
const contributionTimestampsByIp = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (contributionTimestampsByIp.get(ip) || []).filter((t) => now - t < CONTRIBUTE_RATE_WINDOW_MS);
  timestamps.push(now);
  contributionTimestampsByIp.set(ip, timestamps);
  return timestamps.length > CONTRIBUTE_RATE_LIMIT;
}

const CONTRIBUTE_CATEGORIES = ['pharmacy', 'clinic', 'care', 'parapharmacy'];

app.post('/api/contribute', express.json({ limit: '20kb' }), (req, res) => {
  const ip = req.ip || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'عدد كبير من المساهمات في وقت قصير، حاول لاحقًا' });
  }

  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 150);
  const category = CONTRIBUTE_CATEGORIES.includes(body.category) ? body.category : null;
  // نفس الحقل "specialty" يحمل تصنيفًا فرعيًا يعتمد معناه على الفئة: تخصص طبي للعيادات،
  // أو نوع خدمة رعاية (إسعاف خاص/ممرض/مساعدة اجتماعية) للفئة "care" — نفس البنية، معنى مختلف
  let specialty = null;
  if (category === 'clinic') {
    specialty = Object.prototype.hasOwnProperty.call(SPECIALTY_KEYWORDS, body.specialty) ? body.specialty : 'عام';
  } else if (category === 'care') {
    specialty = CARE_TYPES.includes(body.specialty) ? body.specialty : null;
  }
  const phone = String(body.phone || '').trim().slice(0, 40) || null;
  const address = String(body.address || '').trim().slice(0, 200) || null;
  const note = String(body.note || '').trim().slice(0, 500) || null;
  const correctionFor = String(body.correctionFor || '').trim().slice(0, 150) || null;
  const lat = parseFloat(body.lat);
  const lng = parseFloat(body.lng);

  if (!name) return res.status(400).json({ error: 'اسم المكان مطلوب' });
  if (!category) return res.status(400).json({ error: 'نوع المكان غير صالح' });
  if (category === 'care' && !specialty) return res.status(400).json({ error: 'نوع خدمة الرعاية مطلوب' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'إحداثيات الموقع مطلوبة وغير صالحة' });
  }

  // إضافة مكان جديد (بلا correctionFor) تبان مباشرة — بلا مراجعة إدارية — لأن الإحصاء الفعلي
  // (أقل من 5 مستخدمين حاليًا) بيّن أن انتظار مراجعتي شخصيًا هو عنق الزجاجة الحقيقي اللي كيمنع
  // نظام سد فجوات OSM من الخدمة أصلاً. علم مجتمعي (POST /api/contribute/:id/flag تحت) هو
  // الحماية البديلة، بنفس منطق تبليغات الحراسة. التصحيحات (correctionFor) تبقى تحتاج مراجعة
  // يدوية لأنها ماعندهاش وجهة واضحة تلقائيًا (قد تخص مكانًا من OSM ماعندناش عليه تحكم).
  if (!correctionFor) {
    const community = readJsonArraySafe(COMMUNITY_FILE);
    community.push({
      id: crypto.randomUUID(),
      name,
      category,
      specialty,
      phone,
      address,
      lat,
      lng,
      flaggedIps: [],
    });
    writeJsonArray(COMMUNITY_FILE, community);
    return res.json({ ok: true, immediate: true });
  }

  appendPendingContribution({
    name,
    category,
    specialty,
    phone,
    address,
    note,
    correctionFor,
    lat,
    lng,
    ip,
    submittedAt: new Date().toISOString(),
  });

  res.json({ ok: true, immediate: false });
});

// تحقق بسيط من صلاحية الإدارة (نفس التوكن للقراءة وللقبول/الرفض)
function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) {
    res.status(503).json({ error: 'المراجعة الإدارية غير مُفعّلة (لا يوجد ADMIN_TOKEN)' });
    return false;
  }
  const token = req.query.token || (req.body && req.body.token) || '';
  // مقارنة بوقت ثابت (timingSafeEqual) بدل !== العادية — مقارنة النصوص العادية كتوقف
  // بمجرد أول حرف مختلف، وهذا الفرق فالوقت (ولو ميكروثواني) يقدر نظريًا يُستغل لتخمين
  // التوكن حرفًا بحرف؛ الأطوال خاصها تتطابق أولًا حيت timingSafeEqual كيرفض أطوال مختلفة
  const tokenBuf = Buffer.from(String(token));
  const adminBuf = Buffer.from(ADMIN_TOKEN);
  const valid = tokenBuf.length === adminBuf.length && crypto.timingSafeEqual(tokenBuf, adminBuf);
  if (!valid) {
    res.status(403).json({ error: 'غير مصرح' });
    return false;
  }
  return true;
}

// للمراجعة اليدوية من طرف صاحب المشروع فقط — يتطلب متغير بيئة ADMIN_TOKEN
app.get('/api/contribute', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    pending: readJsonArraySafe(PENDING_FILE),
    community: readJsonArraySafe(COMMUNITY_FILE),
  });
});

// قبول مساهمة: قائمة الانتظار دابا ماكاتحملش غير التصحيحات (الأماكن الجديدة كتبان مباشرة —
// انظر POST /api/contribute)، فالتصحيح لا نعرف وجهته تلقائيًا بثقة (قد يخص مكانًا من OSM لا
// نملكه)، فنكتفي بإزالته من قائمة الانتظار بعد أن يكون صاحب المشروع قد اطّلع
// عليها ونفّذ التصحيح يدويًا إن لزم (في التطبيق نفسه أو في OpenStreetMap).
app.post('/api/contribute/:id/approve', express.json({ limit: '5kb' }), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const pending = readJsonArraySafe(PENDING_FILE);
  const entry = pending.find((p) => p.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'المساهمة غير موجودة' });

  if (!entry.correctionFor) {
    const community = readJsonArraySafe(COMMUNITY_FILE);
    community.push({
      name: entry.name,
      category: entry.category,
      specialty: entry.specialty,
      phone: entry.phone,
      address: entry.address,
      lat: entry.lat,
      lng: entry.lng,
    });
    writeJsonArray(COMMUNITY_FILE, community);
  }

  writeJsonArray(PENDING_FILE, pending.filter((p) => p.id !== req.params.id));
  res.json({ ok: true, addedToCommunity: !entry.correctionFor });
});

app.post('/api/contribute/:id/reject', express.json({ limit: '5kb' }), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const pending = readJsonArraySafe(PENDING_FILE);
  const next = pending.filter((p) => p.id !== req.params.id);
  if (next.length === pending.length) return res.status(404).json({ error: 'المساهمة غير موجودة' });
  writeJsonArray(PENDING_FILE, next);
  res.json({ ok: true });
});

// إبلاغ مجتمعي بأن مكانًا مُضافًا من طرف المجتمع غلط/وهمي — بلا موظفين أو مراجعة إدارية،
// نفس منطق علم تبليغات الحراسة بالضبط: عتبة بسيطة (3 إبلاغات من IPs مختلفة) كافية لإخفائه
const PLACE_FLAG_THRESHOLD = 3;
const PLACE_FLAG_RATE_LIMIT = 20;
const PLACE_FLAG_RATE_WINDOW_MS = 60 * 60 * 1000;
const placeFlagTimestampsByIp = new Map();
function isPlaceFlagRateLimited(ip) {
  const now = Date.now();
  const timestamps = (placeFlagTimestampsByIp.get(ip) || []).filter((t) => now - t < PLACE_FLAG_RATE_WINDOW_MS);
  timestamps.push(now);
  placeFlagTimestampsByIp.set(ip, timestamps);
  return timestamps.length > PLACE_FLAG_RATE_LIMIT;
}

app.post('/api/contribute/:id/flag', express.json({ limit: '2kb' }), (req, res) => {
  const ip = req.ip || 'unknown';
  if (isPlaceFlagRateLimited(ip)) {
    return res.status(429).json({ error: 'عدد كبير من الإبلاغات، حاول لاحقًا' });
  }
  const community = readJsonArraySafe(COMMUNITY_FILE);
  const entry = community.find((p) => p.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'المكان غير موجود' });

  const flaggedIps = new Set(entry.flaggedIps || []);
  flaggedIps.add(ip);
  entry.flaggedIps = [...flaggedIps];

  const removed = entry.flaggedIps.length >= PLACE_FLAG_THRESHOLD;
  const next = removed ? community.filter((p) => p.id !== entry.id) : community;
  writeJsonArray(COMMUNITY_FILE, next);
  res.json({ ok: true, removed });
});

// ==================== إحصائية بسيطة: عدد ضغطات زر "مشاركة" ====================
// الهدف الوحيد: نتأكدو فعليا واش الميزة مستعملة قبل ما نبنيو عليها قرارات — عدّاد يومي
// بلا أي بيانات شخصية (لا IP، لا موقع، لا هوية) مخزّنة فالملف، غير رقم وتاريخ
const SHARE_ANALYTICS_FILE = path.join(DATA_DIR, 'share-analytics.json');

function readShareAnalytics() {
  try {
    return JSON.parse(fs.readFileSync(SHARE_ANALYTICS_FILE, 'utf8'));
  } catch (_e) {
    return {};
  }
}
function writeShareAnalytics(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SHARE_ANALYTICS_FILE, JSON.stringify(data));
}

// IP هنا كتستعمل غير للحد من السبام (فالذاكرة، مؤقتًا) — ماشي مخزّنة فالملف نفسه
const SHARE_CLICK_RATE_LIMIT = 30;
const SHARE_CLICK_RATE_WINDOW_MS = 60 * 60 * 1000;
const shareClickTimestampsByIp = new Map();
function isShareClickRateLimited(ip) {
  const now = Date.now();
  const timestamps = (shareClickTimestampsByIp.get(ip) || []).filter((t) => now - t < SHARE_CLICK_RATE_WINDOW_MS);
  timestamps.push(now);
  shareClickTimestampsByIp.set(ip, timestamps);
  return timestamps.length > SHARE_CLICK_RATE_LIMIT;
}

app.post('/api/analytics/share-click', (req, res) => {
  if (isShareClickRateLimited(req.ip || 'unknown')) {
    return res.status(429).json({ error: 'عدد كبير من الطلبات' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const data = readShareAnalytics();
  data[today] = (data[today] || 0) + 1;
  writeShareAnalytics(data);
  res.json({ ok: true });
});

app.get('/api/analytics/share-click', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(readShareAnalytics());
});

// ==================== تبرعات (معدات طبية وأدوية) ====================
// الفكرة انطلقت من حالة حقيقية: شخص محتاج دواء غالي، ولقى متبرعين على فيسبوك لكن بلا
// تنظيم (نوع الدواء ما طابقش، ولا طريقة يتأكد بيها من صلاحيته). رفيقي كيسهل الرؤية
// (شكون عندو شنو، شكون محتاج شنو) بلا ما يتدخل فتسليم الدواء الفعلي — بالنسبة للأدوية
// (بخلاف المعدات)، الواجهة كتوري دائمًا تنبيهًا بأن التسليم لازم يمر عبر صيدلية تتأكد من
// الصلاحية والملاءمة؛ رفيقي أداة تواصل فقط، ماشي طرف فسلسلة توزيع دواء بلا رقابة مختص
const DONATIONS_FILE = path.join(DATA_DIR, 'donations.json');
// شهر — أطول من الحراسة (24 ساعة) لأن التبرع ماشي حساس للوقت بنفس الدرجة، لكن ماشي
// دائم بحال صيدلية حقيقية (المعدة/الدواء يمكن يتوزع أو يبقى بلا فائدة يعرض من بعد مدة)
const DONATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DONATION_KINDS = ['equipment', 'medicine'];
const DONATION_TYPES = ['offer', 'need'];

function readActiveDonations() {
  const all = readJsonArraySafe(DONATIONS_FILE);
  const now = Date.now();
  return all.filter((d) => now - new Date(d.createdAt).getTime() < DONATION_TTL_MS);
}

const DONATION_RATE_LIMIT = 10;
const DONATION_RATE_WINDOW_MS = 60 * 60 * 1000;
const donationTimestampsByIp = new Map();
function isDonationRateLimited(ip) {
  const now = Date.now();
  const timestamps = (donationTimestampsByIp.get(ip) || []).filter((t) => now - t < DONATION_RATE_WINDOW_MS);
  timestamps.push(now);
  donationTimestampsByIp.set(ip, timestamps);
  return timestamps.length > DONATION_RATE_LIMIT;
}

app.post('/api/donations', express.json({ limit: '5kb' }), (req, res) => {
  const ip = req.ip || 'unknown';
  if (isDonationRateLimited(ip)) {
    return res.status(429).json({ error: 'عدد كبير من المحاولات، حاول لاحقًا' });
  }
  const { kind, type, item, phone, city, note, lat, lng } = req.body || {};
  if (!DONATION_KINDS.includes(kind)) return res.status(400).json({ error: 'نوع غير صالح' });
  if (!DONATION_TYPES.includes(type)) return res.status(400).json({ error: 'يجب تحديد: عندي أتبرع أو محتاج' });
  const itemTrim = String(item || '').trim();
  if (!itemTrim) return res.status(400).json({ error: 'اسم الغرض/الدواء مطلوب' });
  const phoneTrim = String(phone || '').trim();
  if (!phoneTrim) return res.status(400).json({ error: 'رقم الهاتف مطلوب' });
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'الموقع مطلوب' });
  }

  const all = readJsonArraySafe(DONATIONS_FILE);
  all.push({
    id: crypto.randomUUID(),
    kind,
    type,
    item: itemTrim,
    phone: phoneTrim,
    city: String(city || '').trim() || null,
    note: String(note || '').trim() || null,
    lat,
    lng,
    createdAt: new Date().toISOString(),
    flaggedIps: [],
  });
  writeJsonArray(DONATIONS_FILE, all);
  res.json({ ok: true });
});

// نطاق واسع افتراضيًا (100 كم) — كثافة التبرعات قليلة جدًا مقارنة بالصيدليات، فتضييق
// النطاق كيخاطر يخبي تبرعات حقيقية قريبة نسبيًا فمدن صغيرة أو مناطق أقل كثافة سكانية
app.get('/api/donations', (req, res) => {
  const { kind, lat, lng } = req.query;
  const radius = parseFloat(req.query.radius) || 100000;
  let list = readActiveDonations();
  if (kind) list = list.filter((d) => d.kind === kind);
  if (lat && lng) {
    list = list
      .map((d) => ({ ...d, _distMeters: haversineMeters(parseFloat(lat), parseFloat(lng), d.lat, d.lng) }))
      .filter((d) => d._distMeters <= radius)
      .sort((a, b) => a._distMeters - b._distMeters);
  } else {
    list = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  res.json({
    results: list.map((d) => ({
      id: d.id,
      kind: d.kind,
      type: d.type,
      item: d.item,
      phone: d.phone,
      city: d.city,
      note: d.note,
      lat: d.lat,
      lng: d.lng,
    })),
  });
});

// إبلاغ مجتمعي عن تبرع غلط/وهمي/منتهي — نفس منطق علم الحراسة/الأماكن بالضبط
const DONATION_FLAG_THRESHOLD = 3;
const DONATION_FLAG_RATE_LIMIT = 20;
const DONATION_FLAG_RATE_WINDOW_MS = 60 * 60 * 1000;
const donationFlagTimestampsByIp = new Map();
function isDonationFlagRateLimited(ip) {
  const now = Date.now();
  const timestamps = (donationFlagTimestampsByIp.get(ip) || []).filter((t) => now - t < DONATION_FLAG_RATE_WINDOW_MS);
  timestamps.push(now);
  donationFlagTimestampsByIp.set(ip, timestamps);
  return timestamps.length > DONATION_FLAG_RATE_LIMIT;
}

app.post('/api/donations/:id/flag', (req, res) => {
  const ip = req.ip || 'unknown';
  if (isDonationFlagRateLimited(ip)) {
    return res.status(429).json({ error: 'عدد كبير من الإبلاغات، حاول لاحقًا' });
  }
  const all = readJsonArraySafe(DONATIONS_FILE);
  const entry = all.find((d) => d.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'العنصر غير موجود' });

  const flaggedIps = new Set(entry.flaggedIps || []);
  flaggedIps.add(ip);
  entry.flaggedIps = [...flaggedIps];

  const removed = entry.flaggedIps.length >= DONATION_FLAG_THRESHOLD;
  const next = removed ? all.filter((d) => d.id !== entry.id) : all;
  writeJsonArray(DONATIONS_FILE, next);
  res.json({ ok: true, removed });
});

// صفحة إدارة بسيطة (HTML) لمراجعة المساهمات بضغطة زر، بدل تعديل JSON يدويًا
app.get('/admin', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).send('المراجعة الإدارية غير مُفعّلة (لا يوجد ADMIN_TOKEN)');
  res.set('Content-Type', 'text/html; charset=utf-8').send(renderAdminPage());
});

function renderAdminPage() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>مراجعة مساهمات رفيقي</title>
<style>
  body{font-family:Tajawal,Arial,sans-serif; background:#FBF7F0; color:#1E2A28; margin:0; padding:20px;}
  h1{font-size:20px;}
  .token-box{display:flex; gap:8px; margin-bottom:20px; flex-wrap:wrap;}
  .token-box input{flex:1; min-width:200px; padding:10px; border-radius:10px; border:2px solid #E1DCD0;}
  .token-box button{padding:10px 16px; border-radius:10px; border:none; background:#0E6B62; color:#fff; font-weight:800; cursor:pointer;}
  .card{background:#fff; border-radius:16px; padding:16px; margin-bottom:14px; box-shadow:0 4px 16px rgba(14,107,98,0.1); border-inline-start:6px solid #0E6B62;}
  .card.correction{border-inline-start-color:#D9922E;}
  .card h3{margin:0 0 6px;}
  .card p{margin:2px 0; font-size:14px; color:#4B5A57;}
  .badge{display:inline-block; background:#E4F2EF; color:#0A4F49; font-size:12px; font-weight:800; padding:2px 10px; border-radius:999px; margin-inline-start:8px;}
  .badge.correction{background:#FCEFDA; color:#8a5a12;}
  .actions{margin-top:10px; display:flex; gap:10px;}
  .actions button{padding:10px 16px; border-radius:10px; border:none; font-weight:800; cursor:pointer;}
  .approve{background:#0E6B62; color:#fff;}
  .reject{background:#D9503C; color:#fff;}
  .empty, .error{color:#4B5A57; font-weight:700;}
  .error{color:#B93F2E;}
  .section-title{font-weight:800; margin:24px 0 10px;}
</style>
</head>
<body>
  <h1>📋 مراجعة مساهمات رفيقي</h1>
  <div class="token-box">
    <input type="password" id="token" placeholder="التوكن الإداري (ADMIN_TOKEN)">
    <button onclick="load()">تحميل المساهمات</button>
  </div>
  <div id="status"></div>
  <div class="section-title">إحصائية زر "مشاركة" (آخر 14 يوم)</div>
  <div id="shareStats" class="empty">اكتب التوكن واضغط "تحميل المساهمات"</div>
  <div class="section-title">المساهمات المعلّقة</div>
  <div id="pendingList" class="empty">اكتب التوكن واضغط "تحميل المساهمات"</div>

  <script>
    const params = new URLSearchParams(location.search);
    if(params.get('token')) document.getElementById('token').value = params.get('token');

    function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

    async function load(){
      const token = document.getElementById('token').value.trim();
      const statusEl = document.getElementById('status');
      const listEl = document.getElementById('pendingList');
      statusEl.textContent = '';
      listEl.innerHTML = 'جارٍ التحميل...';
      try{
        const res = await fetch('/api/contribute?token=' + encodeURIComponent(token));
        const data = await res.json();
        if(!res.ok){ listEl.innerHTML = ''; statusEl.innerHTML = '<p class="error">⚠ ' + esc(data.error || ('HTTP ' + res.status)) + '</p>'; return; }
        renderList(data.pending, token);
      }catch(err){
        listEl.innerHTML = '';
        statusEl.innerHTML = '<p class="error">⚠ خطأ اتصال: ' + esc(err.message) + '</p>';
      }
      loadShareStats(token);
    }

    async function loadShareStats(token){
      const statsEl = document.getElementById('shareStats');
      statsEl.innerHTML = 'جارٍ التحميل...';
      try{
        const res = await fetch('/api/analytics/share-click?token=' + encodeURIComponent(token));
        const data = await res.json();
        if(!res.ok){ statsEl.innerHTML = '<p class="error">⚠ ' + esc(data.error || ('HTTP ' + res.status)) + '</p>'; return; }
        const days = Object.keys(data).sort().slice(-14);
        if(!days.length){ statsEl.innerHTML = '<p class="empty">لا توجد ضغطات مسجّلة بعد</p>'; return; }
        const total = days.reduce((sum, d) => sum + data[d], 0);
        statsEl.innerHTML = '<p><b>المجموع (آخر 14 يوم): ' + total + '</b></p>' +
          '<p style="direction:ltr;text-align:left;">' + days.map(d => esc(d) + ': ' + data[d]).join(' &nbsp;|&nbsp; ') + '</p>';
      }catch(err){
        statsEl.innerHTML = '<p class="error">⚠ خطأ اتصال: ' + esc(err.message) + '</p>';
      }
    }

    function renderList(pending, token){
      const listEl = document.getElementById('pendingList');
      if(!pending.length){ listEl.innerHTML = '<p class="empty">لا توجد مساهمات معلّقة حاليًا 🎉</p>'; return; }
      listEl.innerHTML = pending.map(p => \`
        <div class="card \${p.correctionFor ? 'correction' : ''}" id="card-\${p.id}">
          <h3>\${esc(p.name)} \${p.correctionFor ? '<span class="badge correction">تصحيح</span>' : '<span class="badge">مكان جديد</span>'}</h3>
          <p>النوع: \${esc({pharmacy:'صيدلية', clinic:'عيادة', care:'خدمة رعاية خاصة'}[p.category] || p.category)}\${p.specialty ? ' — ' + esc(p.specialty) : ''}</p>
          \${p.correctionFor ? '<p>تصحيح لمكان: ' + esc(p.correctionFor) + '</p>' : ''}
          \${p.phone ? '<p>هاتف: ' + esc(p.phone) + '</p>' : ''}
          \${p.address ? '<p>عنوان: ' + esc(p.address) + '</p>' : ''}
          \${p.note ? '<p>ملاحظة: ' + esc(p.note) + '</p>' : ''}
          <p>الموقع: <bdi dir="ltr">\${p.lat}, \${p.lng}</bdi> — <a href="https://www.openstreetmap.org/?mlat=\${p.lat}&mlon=\${p.lng}#map=18/\${p.lat}/\${p.lng}" target="_blank" rel="noopener">شوف على الخريطة</a></p>
          <p>وصلت: <bdi>\${esc(new Date(p.submittedAt).toLocaleString('ar-MA'))}</bdi></p>
          <div class="actions">
            <button class="approve" onclick="act('\${p.id}','approve','\${token}')">✅ قبول</button>
            <button class="reject" onclick="act('\${p.id}','reject','\${token}')">❌ رفض</button>
          </div>
        </div>
      \`).join('');
    }

    async function act(id, action, token){
      try{
        const res = await fetch('/api/contribute/' + id + '/' + action + '?token=' + encodeURIComponent(token), { method: 'POST' });
        const data = await res.json();
        if(!res.ok){ alert('⚠ ' + (data.error || ('HTTP ' + res.status))); return; }
        document.getElementById('card-' + id).remove();
      }catch(err){
        alert('⚠ خطأ اتصال: ' + err.message);
      }
    }
  </script>
</body>
</html>`;
}

// يجلب مساهمات المجتمع "الموثّقة" المطابقة لنوع/تخصص البحث ضمن النطاق، ويستبعد أي مساهمة
// قريبة جدًا (أقل من 40 مترًا) من نتيجة OSM موجودة أصلًا حتى لا نكرر نفس المكان مرتين.
function getCommunityMatches({ type, specialty, lat, lng, radius, existing }) {
  const all = readJsonArraySafe(COMMUNITY_FILE);
  return all
    .filter((p) => p.category === type && !p.correctionFor) // التصحيحات لا تُعرض كأماكن مستقلة
    .filter((p) => {
      if (type === 'clinic') return !specialty || specialty === 'عام' || p.specialty === specialty;
      if (type === 'care') return !specialty || specialty === 'all' || p.specialty === specialty;
      return true;
    })
    .map((p) => ({ ...p, _distMeters: haversineMeters(lat, lng, p.lat, p.lng) }))
    .filter((p) => p._distMeters <= radius)
    .filter((p) => !existing.some((e) => haversineMeters(p.lat, p.lng, e.lat, e.lng) < 40))
    .map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      phone: p.phone,
      lat: p.lat,
      lng: p.lng,
      open: null,
      community: true,
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

  let results = [];
  let source = type === 'care' ? 'community' : 'osm';
  // يفرّق بين "OSM رد بصدق بلا نتائج" و"تعذر الوصول لـOSM أصلًا" (كل مرايا Overpass فشلت) —
  // فرق حاسم: نتيجة فارغة حقيقية غير خطيرة، لكن فشل الاتصال نفسه لو عُومل كـ"لا توجد بيانات"
  // بصمت، غادي يوهم المستخدم بغياب صيدليات حقيقية موجودة فعليًا (بحال مدينة كبيرة كالحسيمة)
  let osmError = false;

  // "care" (إسعاف خاص/ممرض/مساعدة اجتماعية) بلا مصدر OSM موثوق أصلًا (انظر تعليق CARE_TYPES
  // أعلاه) — نتخطى OSM وOpenPlaces وGoogle كليًا ونعتمد فقط على مساهمات المجتمع أدناه
  if (type !== 'care') {
    let amenities = [];
    let shops = [];
    if (type === 'pharmacy') {
      amenities = ['pharmacy'];
    } else if (type === 'parapharmacy') {
      // بارافارماسي (مستحضرات تجميل/نظافة/مكملات بلا وصفة طبية) — بخلاف "care"، عندها
      // تصنيف OSM حقيقي وموثوق (shop=chemist)، فنستفيد من بيانات حقيقية هنا فعليًا
      shops = ['chemist'];
    } else {
      // نبحث دائمًا في النطاق العام (عيادة/طبيب/مستشفى)، ونضيف إليه أي تصنيف OSM مخصص
      // للتخصص المطلوب (كالأسنان) بدل استبداله — بعض الأماكن الحقيقية مصنّفة تحت التصنيف
      // العام فقط، وأخرى تحت التصنيف المخصص فقط، فنغطي الاثنين معًا.
      const extra = (specialty && SPECIALTY_EXTRA_AMENITIES[specialty]) || [];
      amenities = [...new Set([...DEFAULT_CLINIC_AMENITIES, ...extra])];
    }

    try {
      results = await fetchFromOSM({ amenities, shops, lat, lng, radius });

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
      osmError = true;
    }
  }

  // دمج مساهمات المجتمع الموثّقة (تُسدّ فجوات OSM محليًا) — تُضاف دائمًا، وليس فقط
  // كاحتياطي عند قلة النتائج، لأنها بالتحديد مخصصة للأماكن التي OSM لا يعرفها بعد.
  try {
    const communityMatches = getCommunityMatches({ type, specialty, lat: parseFloat(lat), lng: parseFloat(lng), radius, existing: results });
    if (communityMatches.length) {
      results = results.concat(communityMatches);
      results.sort((a, b) => haversineMeters(lat, lng, a.lat, a.lng) - haversineMeters(lat, lng, b.lat, b.lng));
      if (source === 'osm') source = results.some((r) => r.community) ? 'osm+community' : 'osm';
    }
  } catch (err) {
    console.warn('تعذر دمج مساهمات المجتمع:', err.message);
  }

  // احتياطي أول: Open Places API — فقط إذا كانت نتائج OSM قليلة (أقل من 2) والمفتاح متوفر.
  // نجرّبه قبل جوجل لأنه أرخص بكثير ويسمح بتخزين النتائج، ونستخدمه فقط إن حسّن العدد فعليًا.
  if (type !== 'care' && results.length < 2 && OPENPLACES_API_KEY) {
    try {
      const term = (type === 'pharmacy' || type === 'parapharmacy')
        ? OPENPLACES_QUERY_TERMS[type]
        : (OPENPLACES_QUERY_TERMS[specialty] || OPENPLACES_QUERY_TERMS['عام']);
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
  if (type !== 'care' && results.length < 2 && GOOGLE_API_KEY) {
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

  res.json({ results, source, osmError });
});

// ==================== نطق صوتي من السيرفر (بدل الاعتماد على صوت الهاتف) ====================
// حل لمشكلة حقيقية: بعض الهواتف (خصوصًا أندرويد الاقتصادية) ما عندهاش صوت عربي مثبت على
// مستوى النظام، فالقراءة الصوتية المحلية (Web Speech API) كتبقى صامتة بلا أي تفسير. بما أن
// التطبيق موجّه بالأساس لفئة أميين/ذوي احتياجات خاصة، ماينفعش نطلب منهم يديرو تعديلات فإعدادات
// الهاتف — الحل هو توليد الصوت من السيرفر عبر OpenAI TTS، اللي كيخدم على أي هاتف بلا شرط.
//
// التخزين المؤقت (cache) هو المفتاح لتفادي التكلفة: معظم النصوص المنطوقة ثابتة ومتكررة لكل
// المستخدمين (قوائم الشاشات، نصوص المساعدة...). أول مستخدم كيطلب نص معيّن كيولّد الصوت
// ويُخزَّن كملف MP3 على القرص، وكل طلب بعده لنفس النص (من أي مستخدم) كيرجع الملف المخزّن
// مباشرة بلا أي استدعاء لـOpenAI ولا أي تكلفة إضافية.
const TTS_CACHE_DIR = path.join(DATA_DIR, 'tts-cache');
const OPENAI_TTS_VOICE = 'alloy';
const MAX_TTS_TEXT_LENGTH = 300;

function ttsCacheKey(lang, text) {
  return crypto.createHash('sha256').update(lang + '|' + text).digest('hex');
}

// معدّل بسيط: نحسب فقط الطلبات اللي فعلاً كتولّد صوتًا جديدًا (cache miss) — التكرار
// المشروع لنفس النصوص الثابتة (اللي كيخدم بيه أغلب الاستعمال) ما كيأثرش على هذا الحد
const TTS_GEN_RATE_LIMIT = 20;
const TTS_GEN_RATE_WINDOW_MS = 60 * 60 * 1000;
const ttsGenTimestampsByIp = new Map();
function isTtsGenRateLimited(ip) {
  const now = Date.now();
  const timestamps = (ttsGenTimestampsByIp.get(ip) || []).filter((t) => now - t < TTS_GEN_RATE_WINDOW_MS);
  timestamps.push(now);
  ttsGenTimestampsByIp.set(ip, timestamps);
  return timestamps.length > TTS_GEN_RATE_LIMIT;
}

async function handleSpeakRequest(text, lang, ip, res) {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'الخادم غير مهيأ بمفتاح OpenAI بعد' });
  }
  if (!text) return res.status(400).json({ error: 'لم يصل أي نص' });
  if (text.length > MAX_TTS_TEXT_LENGTH) {
    return res.status(400).json({ error: 'النص طويل جدًا (الحد الأقصى ' + MAX_TTS_TEXT_LENGTH + ' حرف)' });
  }

  const cacheFile = path.join(TTS_CACHE_DIR, ttsCacheKey(lang, text) + '.mp3');
  if (fs.existsSync(cacheFile)) {
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-TTS-Cache', 'hit');
    fs.createReadStream(cacheFile).pipe(res);
    return;
  }

  if (isTtsGenRateLimited(ip)) {
    return res.status(429).json({ error: 'عدد كبير من طلبات الصوت الجديدة، حاول لاحقًا' });
  }

  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: 'tts-1', voice: OPENAI_TTS_VOICE, input: text, response_format: 'mp3' }),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.warn('OpenAI TTS error:', errText);
      return res.status(502).json({ error: 'فشل توليد الصوت' });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, buf);
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-TTS-Cache', 'miss');
    res.send(buf);
  } catch (err) {
    console.warn('TTS generation error:', err.message);
    res.status(500).json({ error: 'خطأ غير متوقع في توليد الصوت' });
  }
}

app.post('/api/speak', express.json({ limit: '2kb' }), (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  const lang = normalizeSpeechLang(req.body && req.body.lang);
  handleSpeakRequest(text, lang, req.ip || 'unknown', res);
});

// نسخة GET: تخلي عنصر <audio src="..."> يحمّل الصوت مباشرة من المتصفح (بحال أي فيديو
// فأي موقع) بدل ما تمر عبر fetch()+blob() فجافاسكريبت. بعض متصفحات أندرويد (خصوصًا
// الأنظمة المخصّصة) عندها مشاكل معروفة فتشغيل صوت من blob: URL رغم أن التحميل المباشر
// لرابط حقيقي كيخدم بلا مشاكل — هادشي أقرب لكيفية عمل أي عنصر وسائط عادي على الويب.
app.get('/api/speak', (req, res) => {
  const text = String(req.query.text || '').trim();
  const lang = normalizeSpeechLang(req.query.lang);
  handleSpeakRequest(text, lang, req.ip || 'unknown', res);
});

// نقطة اتصال جديدة: تفريغ صوتي دقيق عبر Whisper (OpenAI)
// الواجهة ترسل مقطعًا صوتيًا خامًا (audio/webm عادة)، ويعيد هذا المسار النص المُفرَّغ.
// المفتاح يبقى سريًا هنا في الخادم فقط، تمامًا كمفتاح Google.
// بلا حد للطلبات هنا، أي واحد يقدر يبعث سكريبت كيكرر الطلب آلاف المرات — كل طلب كيكلف
// فلوس حقيقية (Whisper API مدفوع، بخلاف /api/speak اللي عندو تخزين مؤقت يحمي منه هذا بالضبط)
const TRANSCRIBE_RATE_LIMIT = 30;
const TRANSCRIBE_RATE_WINDOW_MS = 60 * 60 * 1000;
const transcribeTimestampsByIp = new Map();
function isTranscribeRateLimited(ip) {
  const now = Date.now();
  const timestamps = (transcribeTimestampsByIp.get(ip) || []).filter((t) => now - t < TRANSCRIBE_RATE_WINDOW_MS);
  timestamps.push(now);
  transcribeTimestampsByIp.set(ip, timestamps);
  return timestamps.length > TRANSCRIBE_RATE_LIMIT;
}

app.post('/api/transcribe', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  if (isTranscribeRateLimited(req.ip || 'unknown')) {
    return res.status(429).json({ error: 'عدد كبير من طلبات التفريغ الصوتي، حاول لاحقًا' });
  }
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'الخادم غير مهيأ بمفتاح OpenAI بعد' });
  }
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'لم يصل أي صوت' });
  }

  try {
    const lang = normalizeSpeechLang(req.query.lang);
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
const VALID_INTENTS = ['nearby_pharmacy', 'on_duty_pharmacy', 'clinic', 'private_care', 'parapharmacy', 'order_medicine', 'emergency', 'donation', 'help', 'back', 'unknown'];
const VALID_SPECIALTIES = ['عام', 'اسنان', 'عيون', 'اطفال', 'جلدية', 'عظام', 'نساء'];

// نفس منطق /api/transcribe فوق — بلا حد، سكريبت بسيط يقدر يستهلك رصيد OpenRouter المدفوع
const UNDERSTAND_RATE_LIMIT = 30;
const UNDERSTAND_RATE_WINDOW_MS = 60 * 60 * 1000;
const understandTimestampsByIp = new Map();
function isUnderstandRateLimited(ip) {
  const now = Date.now();
  const timestamps = (understandTimestampsByIp.get(ip) || []).filter((t) => now - t < UNDERSTAND_RATE_WINDOW_MS);
  timestamps.push(now);
  understandTimestampsByIp.set(ip, timestamps);
  return timestamps.length > UNDERSTAND_RATE_LIMIT;
}

app.post('/api/understand', express.json({ limit: '200kb' }), async (req, res) => {
  if (isUnderstandRateLimited(req.ip || 'unknown')) {
    return res.status(429).json({ error: 'عدد كبير من طلبات الفهم، حاول لاحقًا' });
  }
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'الخادم غير مهيأ بمفتاح OpenRouter بعد' });
  }
  const text = (req.body && req.body.text || '').trim();
  const lang = req.body && req.body.lang === 'en' ? 'en' : 'ar';
  if (!text) {
    return res.status(400).json({ error: 'لم يصل أي نص' });
  }

  const systemPrompt = `You classify a spoken request to a pharmacy/clinic-finder accessibility app (users may be illiterate or speak Moroccan Darija / mixed Arabic-French, transcribed imperfectly). Reply with ONLY a compact JSON object, no other text, matching exactly this shape:
{"intent": one of ${JSON.stringify(VALID_INTENTS)}, "specialty": one of ${JSON.stringify(VALID_SPECIALTIES)} or null (only when intent is "clinic"), "careType": one of ${JSON.stringify(CARE_TYPES)} or null (only when intent is "private_care"), "medicine": string or null (only when intent is "order_medicine" and a medicine name was said), "donationKind": one of ${JSON.stringify(DONATION_KINDS)} or null (only when intent is "donation")}
Rules: "nearby_pharmacy" = wants any nearby pharmacy. "on_duty_pharmacy" = wants a night/duty pharmacy ("garde"/"حراسة"). "clinic" = wants a doctor/clinic (infer specialty from symptoms if possible, e.g. tooth pain -> اسنان). "private_care" = wants a private ambulance ("ambulance"), a home-care nurse ("nurse"), or a social/companion care worker ("social") — NOT an emergency. "parapharmacy" = wants a parapharmacy ("بارافارماسي", "parapharmacie") — an over-the-counter shop selling cosmetics/hygiene/supplements, NOT a licensed dispensing pharmacy. "order_medicine" = wants a specific medicine. "emergency" = urgent/ambulance/danger RIGHT NOW (use this instead of "private_care" whenever it sounds urgent). "donation" = wants to give away or ask for donated medical equipment or medicine ("تبرع", "donation", "محتاج دواء ما عنديش فلوس", "عندي كرسي متحرك نتبرع بيه") — set donationKind to "medicine" or "equipment" based on what's mentioned. "help" = asking how the app works. "back" = wants to go to the home screen. "unknown" = unclear or unrelated. Be lenient with transcription noise/typos and mixed languages; infer the most likely real intent.`;

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
    if (!CARE_TYPES.includes(parsed.careType)) parsed.careType = null;
    if (!DONATION_KINDS.includes(parsed.donationKind)) parsed.donationKind = null;
    res.json(parsed);
  } catch (err) {
    console.warn('Understand error:', err.message);
    res.status(500).json({ error: 'خطأ غير متوقع في فهم الطلب' });
  }
});

// ==================== تبليغات صيدلية الحراسة (بلا مرجع رسمي فالمنطقة) ====================
// فمدن صغيرة كإمزورن، ماكاين حتى لائحة رسمية لصيدليات الحراسة — التناوب كيتدار بين
// الصيادلة أنفسهم بلا نشر عمومي. حساب الدور آليًا خطر (خطأ واحد فالتتابع = بيانات غلط
// بثقة لمدة طويلة)، فالحل: كل صيدلي يبلّغ بنفسه ملي يكون هو المناوب، والتبليغ يبان
// للمستخدمين مباشرة (بلا مراجعة — الوقت حساس) ويختفي أوتوماتيكيًا بعد 24 ساعة.
const DUTY_FILE = path.join(DATA_DIR, 'duty-reports.json');
const DUTY_REPORT_TTL_MS = 24 * 60 * 60 * 1000;

const DUTY_RATE_LIMIT = 10;
const DUTY_RATE_WINDOW_MS = 60 * 60 * 1000;
const dutyTimestampsByIp = new Map();
function isDutyRateLimited(ip) {
  const now = Date.now();
  const timestamps = (dutyTimestampsByIp.get(ip) || []).filter((t) => now - t < DUTY_RATE_WINDOW_MS);
  timestamps.push(now);
  dutyTimestampsByIp.set(ip, timestamps);
  return timestamps.length > DUTY_RATE_LIMIT;
}

function readActiveDutyReports() {
  const all = readJsonArraySafe(DUTY_FILE);
  const now = Date.now();
  return all.filter((r) => now - r.reportedAt < DUTY_REPORT_TTL_MS);
}

app.post('/api/duty', express.json({ limit: '5kb' }), (req, res) => {
  const ip = req.ip || 'unknown';
  if (isDutyRateLimited(ip)) {
    return res.status(429).json({ error: 'عدد كبير من التبليغات، حاول لاحقًا' });
  }
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 150);
  const phone = String(body.phone || '').trim().slice(0, 40) || null;
  const address = String(body.address || '').trim().slice(0, 200) || null;
  const note = String(body.note || '').trim().slice(0, 200) || null;
  const lat = parseFloat(body.lat);
  const lng = parseFloat(body.lng);

  if (!name) return res.status(400).json({ error: 'اسم الصيدلية مطلوب' });
  // رقم الهاتف إجباري (ماشي اختياري): هو العمود الفقري لدفاعين أساسيين ضد بلاغات كاذبة —
  // (1) المستخدم يقدر يتصل يتأكد قبل ما يتحرك، (2) نظام العلم/الإبلاغ تحت يحتاج وسيلة تواصل حقيقية
  if (!phone) return res.status(400).json({ error: 'رقم الهاتف مطلوب' });
  // وقت الحراسة (الحقل "note") إجباري: بلا وقت واضح، التبليغ ماعندوش معنى فعلي — المستخدم
  // ما يعرفش هل الصيدلية ستقبله دابا (ليلا) ولا بعد ساعات (نهارا)، وهذا هو صلب المشكل كامل
  if (!note) return res.status(400).json({ error: 'وقت الحراسة مطلوب' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'إحداثيات الموقع مطلوبة وغير صالحة' });
  }

  // كل تبليغ جديد بنفس الاسم يلغي تبليغه القديم (ماشي يتراكمو) — كل صيدلية عندها أحدث حالة فقط
  const active = readActiveDutyReports().filter((r) => r.name !== name);
  active.push({
    id: crypto.randomUUID(),
    name,
    phone,
    address,
    note,
    lat,
    lng,
    reportedAt: Date.now(),
    flaggedIps: [], // إبلاغات "هاد المعلومة غلط" — انظر POST /api/duty/:id/flag تحت
  });
  writeJsonArray(DUTY_FILE, active);
  res.json({ ok: true });
});

// إبلاغ مجتمعي بأن تبليغ حراسة معيّن غلط — بلا موظفين أو مراجعة إدارية، الاعتماد الوحيد
// الممكن هنا هو المستخدمون أنفسهم (وخصوصًا الصيادلة المجاورين اللي كيعرفو الدور الحقيقي).
// عتبة بسيطة (3 إبلاغات من IPs مختلفة) كافية باش تُخفى البلاغة الكاذبة أوتوماتيكيًا.
const DUTY_FLAG_THRESHOLD = 3;
const DUTY_FLAG_RATE_LIMIT = 20;
const dutyFlagTimestampsByIp = new Map();
function isDutyFlagRateLimited(ip) {
  const now = Date.now();
  const timestamps = (dutyFlagTimestampsByIp.get(ip) || []).filter((t) => now - t < DUTY_RATE_WINDOW_MS);
  timestamps.push(now);
  dutyFlagTimestampsByIp.set(ip, timestamps);
  return timestamps.length > DUTY_FLAG_RATE_LIMIT;
}

app.post('/api/duty/:id/flag', express.json({ limit: '2kb' }), (req, res) => {
  const ip = req.ip || 'unknown';
  if (isDutyFlagRateLimited(ip)) {
    return res.status(429).json({ error: 'عدد كبير من الإبلاغات، حاول لاحقًا' });
  }
  const active = readActiveDutyReports();
  const entry = active.find((r) => r.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'التبليغ غير موجود أو انتهت صلاحيته' });

  const flaggedIps = new Set(entry.flaggedIps || []);
  flaggedIps.add(ip);
  entry.flaggedIps = [...flaggedIps];

  const removed = entry.flaggedIps.length >= DUTY_FLAG_THRESHOLD;
  const next = removed ? active.filter((r) => r.id !== entry.id) : active;
  writeJsonArray(DUTY_FILE, next);
  res.json({ ok: true, removed });
});

app.get('/api/duty', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius) || 50000; // نطاق واسع افتراضيًا — عدد الصيدليات المناوبة قليل أصلاً
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'الحقول المطلوبة: lat, lng' });
  }
  const results = readActiveDutyReports()
    .map((r) => ({ ...r, _distMeters: haversineMeters(lat, lng, r.lat, r.lng) }))
    .filter((r) => r._distMeters <= radius)
    .sort((a, b) => a._distMeters - b._distMeters)
    .map((r) => ({ id: r.id, name: r.name, phone: r.phone, address: r.address, note: r.note, lat: r.lat, lng: r.lng, reportedAt: r.reportedAt }));
  res.json({ results });
});

app.get('/', (req, res) => {
  res.send(
    'خادم رفيقي يعمل ✅ (OpenStreetMap مجاني كمصدر أساسي' +
      (GOOGLE_API_KEY ? '، Google Places كاحتياطي' : '، بدون Google') +
      (OPENPLACES_API_KEY ? '، Open Places API كاحتياطي' : '') +
      (OPENAI_API_KEY ? '، Whisper مفعّل للتفريغ الصوتي، ونطق صوتي من السيرفر (OpenAI TTS) مع تخزين مؤقت' : '') +
      (OPENROUTER_API_KEY ? '، Claude (عبر OpenRouter) مفعّل لفهم القصد' : '') +
      (ADMIN_TOKEN ? '، مراجعة المساهمات مفعّلة (/api/contribute?token=...)' : '') +
      ') — جرّب: /api/search?type=pharmacy&lat=33.31&lng=44.36'
  );
});

app.listen(PORT, () => {
  console.log(`الخادم يعمل على المنفذ ${PORT}`);
});
