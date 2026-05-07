'use strict';
console.log('ALL ENV KEYS:', Object.keys(process.env).join(', '));

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const fs      = require('fs');
const path    = require('path');
const admin   = require('firebase-admin');

// ════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════
const PORT             = process.env.PORT             || 3001;
const TG_TOKEN         = process.env.TG_TOKEN         || '';
const TG_CHAT          = process.env.TG_CHAT          || '';
const TIMEZONE         = process.env.TIMEZONE         || 'Asia/Riyadh';
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID || 'shada-task';

// Local files — for notified cache and logs only
const DATA_DIR      = path.join(__dirname, 'data');
const NOTIFIED_FILE = path.join(DATA_DIR, 'notified.json');
const LOG_FILE      = path.join(DATA_DIR, 'log.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ════════════════════════════════════════
// FILE HELPERS
// ════════════════════════════════════════
function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function appendLog(entry) {
  const logs = readJSON(LOG_FILE, []);
  logs.unshift({ ...entry, ts: new Date().toISOString() });
  if (logs.length > 500) logs.splice(500);
  writeJSON(LOG_FILE, logs);
}

// ════════════════════════════════════════
// FIREBASE ADMIN — init from env var
// ════════════════════════════════════════
let firestoreDB = null;

function initFirebaseAdmin() {
  const projectId   = process.env.FIREBASE_PROJECT_ID   || FIREBASE_PROJECT;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const privateKey  = (process.env.FIREBASE_PRIVATE_KEY || '')
    .trim()                        // إزالة مسافات بداية/نهاية
    .replace(/^["']|["']$/g, '')   // إزالة علامات اقتباس لو موجودة
    .replace(/\\n/g, '\n');        // \\n → سطر جديد حقيقي

  console.log('[FIREBASE] project_id   :', projectId);
  console.log('[FIREBASE] client_email :', clientEmail || '(not set)');
  console.log('[FIREBASE] private_key  :', privateKey ? `${privateKey.slice(0, 30)}...` : '(not set)');

  if (!clientEmail || !privateKey) {
    console.warn('[FIREBASE] ⚠️  FIREBASE_CLIENT_EMAIL أو FIREBASE_PRIVATE_KEY غير موجود');
    console.warn('[FIREBASE]    أضفهما في Railway → Variables');
    return;
  }

  try {
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        projectId,
      });
    }
    firestoreDB = admin.firestore();
    console.log(`[FIREBASE] ✅ Connected — project: ${projectId}`);
  } catch (e) {
    console.error('[FIREBASE] ❌ Init failed:', e.message);
    firestoreDB = null;
  }
}

// ════════════════════════════════════════
// FIRESTORE DATA READER
// ════════════════════════════════════════

// Read /app/{key} → returns d.data array (or null on failure)
async function fsRead(key) {
  if (!firestoreDB) return null;
  try {
    const snap = await firestoreDB.collection('app').doc(key).get();
    if (!snap.exists) return null;
    const d = snap.data();
    return Array.isArray(d?.data) ? d.data : null;
  } catch (e) {
    console.error(`[FIREBASE] read(${key}) failed:`, e.code || e.message);
    return null;
  }
}

// Read tasks, sessions, deadlines — always returns arrays
async function getAppData() {
  if (!firestoreDB) {
    return { tasks: [], sessions: [], deadlines: [], source: 'none' };
  }
  try {
    const [tasks, sessions, deadlines] = await Promise.all([
      fsRead('tasks'),
      fsRead('sessions'),
      fsRead('deadlines'),
    ]);
    return {
      tasks:     tasks     ?? [],
      sessions:  sessions  ?? [],
      deadlines: deadlines ?? [],
      source: 'firestore',
    };
  } catch (e) {
    console.error('[FIREBASE] getAppData failed:', e.message);
    return { tasks: [], sessions: [], deadlines: [], source: 'error' };
  }
}

// ════════════════════════════════════════
// TELEGRAM
// ════════════════════════════════════════
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'Markdown' }),
    });
    const j = await res.json();
    if (j.ok) console.log('[TG] ✅', text.slice(0, 60).replace(/\n/g, ' '));
    else      console.error('[TG] ❌', j.description);
    return j.ok === true;
  } catch (e) {
    console.error('[TG] ❌ fetch error:', e.message);
    return false;
  }
}

// ════════════════════════════════════════
// DATE UTILS
// ════════════════════════════════════════
function nowInTZ() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
}
function pad2(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function timeStr(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function diffMins(dateA, timeA, now) {
  const [y,m,d] = dateA.split('-').map(Number);
  const [h,mi]  = timeA.split(':').map(Number);
  return Math.round((new Date(y, m-1, d, h, mi) - now) / 60000);
}

// ════════════════════════════════════════
// MESSAGE FORMATTERS
// ════════════════════════════════════════
const CAT_AR = { daily:'☀️ يومية', weekly:'📅 أسبوعية', monthly:'🗓️ شهرية', yearly:'🎯 سنوية', once:'📌 مرة واحدة' };
const PRI_AR = { high:'🔴 عالية', medium:'🟡 متوسطة', low:'🟢 منخفضة' };
const PRI_IC = { high:'🔴', medium:'🟡', low:'🟢' };
const SEP    = '━━━━━━━━━━━━━━━━━━';

function fmtTask(task, header) {
  const [y,mo,d] = (task.dueDate||'').split('-').map(Number);
  let t = (header || '📋 *تذكير بمهمة*') + `\n\n📌 *${task.title}*\n${SEP}`;
  t += `\n📂 *التصنيف:* ${CAT_AR[task.category]||task.category}`;
  if (task.subcategory) t += ` › ${task.subcategory}`;
  t += `\n${PRI_AR[task.priority]||''} *الأولوية*`;
  if (task.dueDate||task.dueTime) {
    t += `\n⏰ *الموعد:*`;
    if (task.dueDate) t += ` ${d}/${mo}/${y}`;
    if (task.dueTime) t += ` 🕐 ${task.dueTime}`;
  }
  if (task.description)   t += `\n📝 *ملاحظات:* ${task.description}`;
  if (task.checklist?.length) {
    const done = task.checklist.filter(x => x.done).length;
    t += `\n✅ *قائمة المراجعة:* ${done}/${task.checklist.length} خطوة`;
  }
  return t;
}

function fmtSession(session, when, header) {
  const hdrs = {
    now:    '🔔 *موعد الجلسة الآن*',
    '1hour':'⚠️ *تذكير عاجل — الجلسة بعد ساعة*',
    '1day': '🏛️ *تذكير بجلسة — غداً*',
  };
  const [y,m,d] = (session.date||'').split('-').map(Number);
  let t = (header || hdrs[when] || '🏛️ *تذكير بجلسة*') + `\n\n${SEP}`;
  t += `\n👤 *الموكل:* ${session.client||''}`;
  if (session.sessType) t += `\n🏷️ *نوع الجلسة:* ${session.sessType}`;
  if (session.caseNum)  t += `\n📋 *رقم القضية:* ${session.caseNum}`;
  if (session.court)    t += `\n🏛️ *المحكمة:* ${session.court}`;
  if (session.date)     t += `\n📅 *التاريخ:* ${d}/${m}/${y}`;
  if (session.time)     t += `\n🕐 *الوقت:* ${session.time}`;
  if (session.notes)    t += `\n📝 *ملاحظات:* ${session.notes}`;
  return t;
}

function fmtDeadline(dl, header) {
  const [y,m,d] = (dl.deadline||'').split('-').map(Number);
  const diffDays = Math.round((new Date(y,m-1,d,9,0) - nowInTZ()) / 86400000);
  let t = (header || '⚖️ *تذكير بميعاد قانوني*') + `\n\n📌 *${dl.name}*\n${SEP}`;
  if (dl.category)    t += `\n🏷️ *النوع:* ${dl.category}`;
  t += `\n📅 *تاريخ الانتهاء:* ${d}/${m}/${y}`;
  t += `\n${diffDays <= 0 ? '❌ انتهى' : diffDays === 1 ? '⏰ غداً' : `⏳ متبقٍ ${diffDays} يوم`}`;
  if (dl.notes) t += `\n📝 *ملاحظات:* ${dl.notes}`;
  return t;
}

// ════════════════════════════════════════
// RECURRENCE CHECK
// ════════════════════════════════════════
function shouldNotifyToday(task, today) {
  switch (task.category) {
    case 'daily':  return true;
    case 'weekly': {
      if (!task.dueDate) return true;
      const [y,m,d] = task.dueDate.split('-').map(Number);
      return today.getDay() === new Date(y,m-1,d).getDay();
    }
    case 'monthly': {
      if (!task.dueDate) return true;
      return today.getDate() === Number(task.dueDate.split('-')[2]);
    }
    case 'yearly': {
      if (!task.dueDate) return true;
      const [,m,d] = task.dueDate.split('-').map(Number);
      return today.getMonth()+1 === m && today.getDate() === d;
    }
    case 'once':
      return task.dueDate === dateStr(today);
    default: return false;
  }
}

// ════════════════════════════════════════
// CRON — كل دقيقة: تحقق من التذكيرات
// ════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  const now      = nowInTZ();
  const today    = dateStr(now);
  const nowTime  = timeStr(now);
  const nowMin   = Math.floor(now.getTime() / 60000);

  const { tasks, sessions, deadlines, source } = await getAppData();
  if (!tasks.length && !sessions.length && !deadlines.length) return;

  const notified = readJSON(NOTIFIED_FILE, {});
  let changed    = false;
  const fired    = [];

  console.log(`[CRON] ${today} ${nowTime} | ${source} | tasks:${tasks.length} sessions:${sessions.length} deadlines:${deadlines.length}`);

  // ── 1. تذكيرات المهام عند موعدها ──────────
  for (const task of tasks) {
    if (task.completed || !task.dueTime) continue;
    const key = `t-${task.id}-${today}`;
    if (notified[key] || task.dueTime !== nowTime) continue;
    if (!shouldNotifyToday(task, now)) continue;

    const ok = await sendTelegram(fmtTask(task));
    if (ok) { notified[key] = now.toISOString(); fired.push({ type:'task', id:task.id }); changed = true; }
  }

  // ── 2. تذكيرات الجلسات (الآن، ساعة، يوم) ──
  for (const s of sessions) {
    if (!s.date || !s.time) continue;
    const diff = diffMins(s.date, s.time, now);
    const checks = [
      { key:`s-${s.id}-now`,   match: diff === 0,                  when:'now'   },
      { key:`s-${s.id}-1h`,    match: diff >= 59 && diff <= 61,    when:'1hour' },
      { key:`s-${s.id}-1d`,    match: diff >= 1439 && diff <= 1441, when:'1day' },
    ];
    for (const { key, match, when } of checks) {
      if (!match || notified[key]) continue;
      const ok = await sendTelegram(fmtSession(s, when));
      if (ok) { notified[key] = now.toISOString(); fired.push({ type:'session', id:s.id, when }); changed = true; }
    }
  }

  // ── 3. تذكيرات مخصصة (tasks) ──────────────
  const RMS = { minutes:60000, hours:3600000, days:86400000 };
  const U_AR = { minutes:'دقيقة', hours:'ساعة', days:'يوم' };
  const fmtR = r => `قبل ${r.amount} ${U_AR[r.unit]||''}`;

  for (const task of tasks) {
    if (task.completed || !task.dueDate || !task.dueTime || !task.reminders?.length) continue;
    const [y,m,d] = task.dueDate.split('-').map(Number);
    const [h,mi]  = task.dueTime.split(':').map(Number);
    const dueMs   = new Date(y,m-1,d,h,mi).getTime();
    for (const r of task.reminders) {
      if (!r.amount || !r.unit) continue;
      const fireMin = Math.floor((dueMs - r.amount * (RMS[r.unit]||0)) / 60000);
      if (fireMin !== nowMin) continue;
      const key = `cr-t-${task.id}-${r.id}-${task.dueDate}`;
      if (notified[key]) continue;
      const ok = await sendTelegram(fmtTask(task, `⏰ *تذكير — ${fmtR(r)} من الآن*`));
      if (ok) { notified[key] = now.toISOString(); fired.push({ type:'custom-task', id:task.id }); changed = true; }
    }
  }

  // ── 4. تذكيرات مخصصة (sessions) ───────────
  for (const s of sessions) {
    if (!s.date || !s.time || !s.reminders?.length) continue;
    const [y,m,d] = s.date.split('-').map(Number);
    const [h,mi]  = s.time.split(':').map(Number);
    const dueMs   = new Date(y,m-1,d,h,mi).getTime();
    for (const r of s.reminders) {
      if (!r.amount || !r.unit) continue;
      const fireMin = Math.floor((dueMs - r.amount * (RMS[r.unit]||0)) / 60000);
      if (fireMin !== nowMin) continue;
      const key = `cr-s-${s.id}-${r.id}-${s.date}`;
      if (notified[key]) continue;
      const ok = await sendTelegram(fmtSession(s, null, `⏰ *تذكير — ${fmtR(r)} من الآن*`));
      if (ok) { notified[key] = now.toISOString(); fired.push({ type:'custom-session', id:s.id }); changed = true; }
    }
  }

  // ── 5. تذكيرات مخصصة (deadlines, anchor 09:00) ─
  for (const dl of deadlines) {
    if (!dl.deadline || !dl.reminders?.length) continue;
    const [y,m,d] = dl.deadline.split('-').map(Number);
    const dueMs   = new Date(y,m-1,d,9,0,0).getTime();
    for (const r of dl.reminders) {
      if (!r.amount || !r.unit) continue;
      const fireMin = Math.floor((dueMs - r.amount * (RMS[r.unit]||0)) / 60000);
      if (fireMin !== nowMin) continue;
      const key = `cr-dl-${dl.id}-${r.id}-${dl.deadline}`;
      if (notified[key]) continue;
      const ok = await sendTelegram(fmtDeadline(dl, `⏰ *تذكير — ${fmtR(r)} من الآن*`));
      if (ok) { notified[key] = now.toISOString(); fired.push({ type:'custom-deadline', id:dl.id }); changed = true; }
    }
  }

  if (changed) writeJSON(NOTIFIED_FILE, notified);
  if (fired.length) {
    appendLog({ event:'reminders_fired', count:fired.length, fired });
    console.log(`[CRON] 🔔 fired ${fired.length} reminders`);
  }
}, { timezone: TIMEZONE });

// ════════════════════════════════════════
// CRON — الساعة 7 صباحاً: الملخص اليومي
// ════════════════════════════════════════
const QUOTES = [
  'كل يوم هو فرصة جديدة لتحقيق ما أخفقت فيه أمس',
  'الإعداد الجيد لليوم هو انتصارك المضمون في قاعة المحكمة',
  'المحامي الناجح يبني نجاحه بالاستعداد الدقيق لا بالارتجال',
  'لا تؤجّل ما يمكن إنجازه اليوم، فالمواعيد القانونية لا تنتظر أحداً',
  'كل ملف قانوني يحمل قصة إنسانية تستحق أفضل دفاع ممكن',
  'الاتقان في التفاصيل الصغيرة هو ما يصنع الفرق في القضايا الكبيرة',
  'كل موكل يثق فيك هو تكريم مهني — صُن هذه الثقة بالإعداد والإتقان',
  'النجاح يُبنى يوماً بعد يوم والتميز هو نتيجة عادات يومية صحيحة',
  'من أتقن يومه أتقن حياته ومن أهمل يومه أهمل مستقبله',
  'العدالة الحقيقية تبدأ من مكتبك قبل أن تصل إلى قاعة المحاكمة',
  'الوقت رأس المال الحقيقي للمحامي — استثمره فيما يُثمر ويُدوم',
  'الصبر والمثابرة يحوّلان القضايا الصعبة إلى انتصارات ممكنة',
  'ابدأ يومك بنية صادقة وستجد أن الصعاب تتراجع أمام عزيمتك',
  'الاستعداد المبكر للجلسة هو نصف الانتصار فيها',
  'كل تحدٍّ قانوني هو فرصة لإثبات كفاءتك وصقل خبرتك',
];
const DAYS_AR   = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const MONTHS_AR = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

function buildDailySummary(now, tasks, sessions, deadlines) {
  const today  = dateStr(now);
  const plus3  = dateStr(new Date(now.getTime() + 3 * 86400000));
  const doy    = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const quote  = QUOTES[doy % QUOTES.length];
  let msg = '';
  msg += `🌅 *صباح الخير ⚖️*\n`;
  msg += `📅 *${DAYS_AR[now.getDay()]}، ${now.getDate()} ${MONTHS_AR[now.getMonth()]} ${now.getFullYear()}*\n`;
  msg += `\n_"${quote}"_\n\n${SEP}\n`;

  // جلسات اليوم
  const todaySess = sessions.filter(s => s.date === today).sort((a,b) => (a.time||'').localeCompare(b.time||''));
  msg += todaySess.length ? `\n🏛️ *جلسات اليوم — ${todaySess.length}:*\n` : `\n🏛️ *جلسات اليوم:* لا توجد\n`;
  for (const s of todaySess) {
    msg += `\n▪️ *${s.time||'—'}* — ${s.client||'—'}\n`;
    if (s.court)    msg += `   🏛️ ${s.court}\n`;
    if (s.caseNum)  msg += `   📋 ${s.caseNum}\n`;
    if (s.sessType) msg += `   🏷️ ${s.sessType}\n`;
    if (s.notes)    msg += `   📝 ${s.notes}\n`;
  }

  // مهام اليوم
  const todayTasks = tasks
    .filter(t => !t.completed && (t.dueDate === today || (!t.dueDate && t.category === 'daily')))
    .sort((a,b) => ({high:0,medium:1,low:2}[a.priority]||1) - ({high:0,medium:1,low:2}[b.priority]||1));
  msg += `\n${SEP}\n`;
  msg += todayTasks.length ? `\n📋 *مهام اليوم — ${todayTasks.length}:*\n` : `\n📋 *مهام اليوم:* لا توجد\n`;
  for (const t of todayTasks.slice(0, 8)) {
    msg += `• ${PRI_IC[t.priority]||'⚪'} ${t.title}`;
    if (t.dueTime)     msg += ` 🕐 ${t.dueTime}`;
    if (t.subcategory) msg += ` _(${t.subcategory})_`;
    msg += '\n';
  }
  if (todayTasks.length > 8) msg += `_...و${todayTasks.length - 8} مهام أخرى_\n`;

  // مواعيد قانونية خلال 3 أيام
  const nearDls = deadlines.filter(d => d.deadline >= today && d.deadline <= plus3)
    .sort((a,b) => a.deadline.localeCompare(b.deadline));
  msg += `\n${SEP}\n`;
  msg += nearDls.length ? `\n⚖️ *مواعيد قانونية خلال 3 أيام — ${nearDls.length}:*\n` : `\n⚖️ *مواعيد قانونية:* لا توجد خلال 3 أيام\n`;
  for (const dl of nearDls) {
    const [dy,dm,dd] = dl.deadline.split('-').map(Number);
    const diff = Math.round((new Date(dy,dm-1,dd,9) - now) / 86400000);
    msg += `\n▪️ *${dl.name}*\n`;
    msg += `   ${diff <= 0 ? '⚠️ اليوم!' : diff === 1 ? '⏰ غداً' : `📅 بعد ${diff} أيام`} — ${dd}/${dm}/${dy}\n`;
    if (dl.category) msg += `   🏷️ ${dl.category}\n`;
    if (dl.notes)    msg += `   📝 ${dl.notes}\n`;
  }

  // مهام متأخرة
  const overdue = tasks.filter(t => !t.completed && t.dueDate && t.dueDate < today)
    .sort((a,b) => a.dueDate.localeCompare(b.dueDate));
  msg += `\n${SEP}\n`;
  if (overdue.length) {
    msg += `\n⏰ *مهام متأخرة — ${overdue.length}:*\n`;
    for (const t of overdue.slice(0, 6)) {
      const d = Math.abs(Math.round((new Date(t.dueDate+'T12:00:00') - now) / 86400000));
      msg += `• ${PRI_IC[t.priority]||'⚪'} ${t.title} _(منذ ${d} يوم)_\n`;
    }
    if (overdue.length > 6) msg += `_...و${overdue.length - 6} مهام أخرى_\n`;
  } else {
    msg += `\n✅ *لا توجد مهام متأخرة — أحسنت!*\n`;
  }

  if (!todaySess.length && !todayTasks.length && !nearDls.length && !overdue.length) {
    msg += `\n🎉 *يوم فارغ — استثمره في التطوير والإعداد!*\n`;
  }
  msg += `\n${SEP}`;
  return msg;
}

cron.schedule('0 7 * * *', async () => {
  const now  = nowInTZ();
  const { tasks, sessions, deadlines, source } = await getAppData();
  console.log(`[DAILY] source:${source} tasks:${tasks.length} sessions:${sessions.length}`);
  const text = buildDailySummary(now, tasks, sessions, deadlines);
  const ok   = await sendTelegram(text);
  appendLog({ event:'daily_summary', ok, date:dateStr(now) });
  console.log(`[DAILY] sent:${ok}`);
}, { timezone: TIMEZONE });

// ════════════════════════════════════════
// EXPRESS
// ════════════════════════════════════════
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── Status ──────────────────────────────
app.get('/', async (_req, res) => {
  const { tasks, sessions, deadlines, source } = await getAppData();
  res.json({
    status:     'ok',
    time:       new Date().toISOString(),
    timezone:   TIMEZONE,
    telegram:   !!TG_TOKEN,
    firebase:   !!firestoreDB,
    dataSource: source,
    counts:     { tasks: tasks.length, sessions: sessions.length, deadlines: deadlines.length },
    notified:   Object.keys(readJSON(NOTIFIED_FILE, {})).length,
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Firebase Status ──────────────────────
app.get('/firebase-status', async (_req, res) => {
  if (!firestoreDB) {
    return res.status(503).json({
      connected: false,
      firebase:  false,
      message:   'FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY not set. Check Railway Variables.',
    });
  }
  try {
    const { tasks, sessions, deadlines, source } = await getAppData();
    res.json({
      connected: true,
      firebase:  true,
      project:   FIREBASE_PROJECT,
      source,
      counts:    { tasks: tasks.length, sessions: sessions.length, deadlines: deadlines.length },
      message:   'Firestore connection OK',
    });
  } catch (e) {
    res.status(500).json({ connected: false, error: e.message });
  }
});

// ── Data sync endpoints (from app) ───────
app.post('/tasks', (req, res) => {
  const { tasks } = req.body;
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be array' });
  console.log(`[TASKS] received ${tasks.length} tasks (local cache)`);
  res.json({ ok: true, count: tasks.length });
});

app.post('/sessions', (req, res) => {
  let s = req.body;
  if (!Array.isArray(s)) s = [s];
  console.log(`[SESSIONS] received ${s.length}`);
  res.json({ ok: true, count: s.length });
});

app.post('/deadlines', (req, res) => {
  let d = req.body;
  if (!Array.isArray(d)) d = [d];
  console.log(`[DEADLINES] received ${d.length}`);
  res.json({ ok: true, count: d.length });
});

// ── Test & manual ────────────────────────
app.post('/test', async (_req, res) => {
  const ok = await sendTelegram(
    `🔔 *اختبار الإشعارات*\n\n✅ سيرفر التذكيرات يعمل\n🔥 Firebase: ${firestoreDB ? 'متصل' : 'غير متصل'}\n⏰ ${new Date().toLocaleString('ar-SA', { timeZone: TIMEZONE })}`
  );
  res.json({ ok });
});

app.post('/daily-summary', async (_req, res) => {
  const now                                    = nowInTZ();
  const { tasks, sessions, deadlines, source } = await getAppData();
  console.log(`[DAILY-MANUAL] source:${source}`);
  const text = buildDailySummary(now, tasks, sessions, deadlines);
  const ok   = await sendTelegram(text);
  appendLog({ event:'daily_summary_manual', ok, date:dateStr(now) });
  res.json({ ok, preview: text.slice(0, 300) });
});

app.post('/notify', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const ok = await sendTelegram(text);
  res.json({ ok });
});

// ── Logs & cache ─────────────────────────
app.get('/logs', (_req, res) => res.json(readJSON(LOG_FILE, [])));

app.delete('/notified', (_req, res) => {
  writeJSON(NOTIFIED_FILE, {});
  res.json({ ok: true, message: 'Notification cache cleared' });
});

// ════════════════════════════════════════
// START
// ════════════════════════════════════════
initFirebaseAdmin();

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   Reminder Server  v3 — Firestore    ║
╚══════════════════════════════════════╝
  🚀  Port      : ${PORT}
  🌍  Timezone  : ${TIMEZONE}
  🤖  Telegram  : ${TG_TOKEN ? '✅ configured' : '❌ set TG_TOKEN'}
  🔥  Firebase  : ${process.env.FIREBASE_CLIENT_EMAIL ? '✅ credentials set' : '⚠️  set FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY'}
  📦  Project   : ${FIREBASE_PROJECT}

  Endpoints:
  GET  /                 → status + data counts
  GET  /firebase-status  → Firestore connection test
  POST /daily-summary    → send morning summary now
  POST /test             → send test Telegram message
  GET  /logs             → notification history
  DEL  /notified         → reset notification cache
`);
});
