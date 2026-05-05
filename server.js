require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const fs      = require('fs');
const path    = require('path');

// ════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════
const PORT      = process.env.PORT      || 3001;
const TG_TOKEN  = process.env.TG_TOKEN  || '';
const TG_CHAT   = process.env.TG_CHAT   || '';
const TIMEZONE  = process.env.TIMEZONE  || 'Asia/Riyadh';

const DATA_DIR        = path.join(__dirname, 'data');
const TASKS_FILE      = path.join(DATA_DIR, 'tasks.json');
const SESSIONS_FILE   = path.join(DATA_DIR, 'sessions.json');
const DEADLINES_FILE  = path.join(DATA_DIR, 'deadlines.json');
const SUBCATS_FILE    = path.join(DATA_DIR, 'subcats.json');
const NOTIFIED_FILE   = path.join(DATA_DIR, 'notified.json');
const LOG_FILE        = path.join(DATA_DIR, 'log.json');

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
  if (logs.length > 200) logs.splice(200);
  writeJSON(LOG_FILE, logs);
}

// ════════════════════════════════════════
// TELEGRAM
// ════════════════════════════════════════
async function sendTelegram(text, silent = false) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn('[TG] ⚠️  Not configured. Set TG_TOKEN and TG_CHAT in .env');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:              TG_CHAT,
        text,
        parse_mode:           'Markdown',
        disable_notification: silent
      })
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[TG] ✅ Sent: ${text.substring(0, 60).replace(/\n/g, ' ')}`);
    } else {
      console.error(`[TG] ❌ Error: ${data.description}`);
    }
    return data.ok === true;
  } catch (e) {
    console.error(`[TG] ❌ Fetch error: ${e.message}`);
    return false;
  }
}

// ════════════════════════════════════════
// DATE UTILS
// ════════════════════════════════════════
function nowInTZ() {
  // Returns current time as a Date interpreted in the configured timezone
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function timeStr(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function diffMinutes(dateA, timeA, now) {
  const [y, m, d]  = dateA.split('-').map(Number);
  const [h, mi]    = timeA.split(':').map(Number);
  const target     = new Date(y, m-1, d, h, mi, 0, 0);
  return Math.round((target - now) / 60000);
}

// ════════════════════════════════════════
// MESSAGE FORMATTERS
// ════════════════════════════════════════
const CAT_AR = { daily:'☀️ يومية', weekly:'📅 أسبوعية', monthly:'🗓️ شهرية', yearly:'🎯 سنوية', once:'📌 مرة واحدة' };
const PRI_AR = { high:'🔴 عالية', medium:'🟡 متوسطة', low:'🟢 منخفضة' };
const SEP    = '━━━━━━━━━━━━━━━━━━';

function fmtTask(task, headerOverride) {
  const [y,mo,d] = (task.dueDate||'').split('-').map(Number);
  let t = headerOverride ? `${headerOverride}\n\n` : `📋 *تذكير بمهمة*\n\n`;
  t += `📌 *${task.title}*\n${SEP}`;
  t += `\n📂 *التصنيف:* ${CAT_AR[task.category] || task.category}`;
  if (task.subcategory) t += ` › ${task.subcategory}`;
  t += `\n${PRI_AR[task.priority]||''} *الأولوية*`;
  if (task.dueDate || task.dueTime) {
    t += `\n⏰ *الموعد:*`;
    if (task.dueDate) t += ` ${d}/${mo}/${y}`;
    if (task.dueTime) t += ` 🕐 ${task.dueTime}`;
  }
  if (task.description) t += `\n📝 *ملاحظات:* ${task.description}`;
  if (task.checklist?.length) {
    const done = task.checklist.filter(x => x.done).length;
    t += `\n✅ *قائمة المراجعة:* ${done}/${task.checklist.length} خطوة`;
  }
  return t;
}

function fmtSession(session, when) {
  const headers = {
    now:    `🔔 *موعد الجلسة الآن*`,
    '1hour': `⚠️ *تذكير عاجل — الجلسة بعد ساعة*`,
    '1day':  `🏛️ *تذكير بجلسة — غداً*`
  };
  const [y,m,d] = (session.date||'').split('-').map(Number);
  let t = `${headers[when]||'🏛️ *تذكير بجلسة*'}\n\n${SEP}`;
  t += `\n👤 *الموكل:* ${session.client||session.title||''}`;
  if (session.sessType || session.type) t += `\n🏷️ *نوع الجلسة:* ${session.sessType||session.type}`;
  if (session.caseNum)  t += `\n📋 *رقم القضية:* ${session.caseNum}`;
  if (session.court)    t += `\n🏛️ *المحكمة:* ${session.court}`;
  if (session.date)     t += `\n📅 *التاريخ:* ${d}/${m}/${y}`;
  if (session.time)     t += `\n🕐 *الوقت:* ${session.time}`;
  if (session.notes)    t += `\n📝 *ملاحظات:* ${session.notes}`;
  return t;
}

// ════════════════════════════════════════
// RECURRENCE CHECK
// ════════════════════════════════════════
function shouldNotifyToday(task, today) {
  switch (task.category) {
    case 'daily': return true;
    case 'weekly': {
      if (!task.dueDate) return true;
      const [y,m,d] = task.dueDate.split('-').map(Number);
      return today.getDay() === new Date(y,m-1,d).getDay();
    }
    case 'monthly': {
      if (!task.dueDate) return true;
      const [,,d] = task.dueDate.split('-').map(Number);
      return today.getDate() === d;
    }
    case 'yearly': {
      if (!task.dueDate) return true;
      const [,m,d] = task.dueDate.split('-').map(Number);
      return today.getMonth()+1===m && today.getDate()===d;
    }
    case 'once':
      return task.dueDate ? task.dueDate === dateStr(today) : false;
    default: return false;
  }
}

// ════════════════════════════════════════
// CRON — every minute
// ════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  const now      = nowInTZ();
  const todayStr = dateStr(now);
  const nowTime  = timeStr(now);

  const tasks     = readJSON(TASKS_FILE,     []);
  const sessions  = readJSON(SESSIONS_FILE,  []);
  const deadlines = readJSON(DEADLINES_FILE, []);
  const notified  = readJSON(NOTIFIED_FILE,  {});
  let   changed   = false;
  const fired     = [];
  const nowMin    = Math.floor(now.getTime() / 60000);

  // ── Custom reminder helper ──────────────
  const RMS = { minutes:60000, hours:3600000, days:86400000 };
  const UNT_AR_S = { minutes:'دقيقة', hours:'ساعة', days:'يوم' };

  function reminderMs(r) { return Number(r.amount) * (RMS[r.unit] || 0); }
  function fmtR(r) { return `قبل ${r.amount} ${UNT_AR_S[r.unit]||''}`; }

  async function checkCustomReminder(type, item, dueMs, dateKey) {
    for (const r of (item.reminders || [])) {
      if (!r.amount || !r.unit) continue;
      const fireMin = Math.floor((dueMs - reminderMs(r)) / 60000);
      if (fireMin !== nowMin) continue;
      const key = `cr-${type}-${item.id}-r${r.id}-${dateKey}`;
      if (notified[key]) continue;

      const hdr = `⏰ *تذكير — ${fmtR(r)} من الآن*`;
      let text;
      if      (type==='task')     text = fmtTask(item, hdr);
      else if (type==='session')  text = fmtSession(item, null, hdr);
      else if (type==='deadline') {
        const [y,m,d]=(item.deadline||'').split('-').map(Number);
        text = `${hdr}\n\n📌 *${item.name}*\n${SEP}`;
        if (item.category) text += `\n🏷️ *النوع:* ${item.category}`;
        text += `\n📅 *تاريخ الانتهاء:* ${d}/${m}/${y}`;
        if (item.notes) text += `\n📝 *ملاحظات:* ${item.notes}`;
      } else continue;

      const ok = await sendTelegram(text);
      if (ok !== false) {
        notified[key] = now.toISOString();
        fired.push({ type: `custom-${type}`, id: item.id, reminder: fmtR(r) });
        changed = true;
      }
    }
  }

  // ── Task reminders ──────────────────────
  for (const task of tasks) {
    if (task.completed || !task.dueTime) continue;

    const key = `t-${task.id}-${todayStr}`;
    if (notified[key]) continue;
    if (task.dueTime !== nowTime) continue;
    if (!shouldNotifyToday(task, now)) continue;

    const ok = await sendTelegram(fmtTask(task));
    if (ok !== false) {
      notified[key] = now.toISOString();
      fired.push({ type: 'task', title: task.title, when: 'now' });
      changed = true;
    }
  }

  // ── Session reminders ───────────────────
  for (const session of sessions) {
    if (!session.date || !session.time) continue;

    const diffMins = diffMinutes(session.date, session.time, now);

    const checks = [
      { key: `s-${session.id}-now`,    match: diffMins === 0,                    when: 'now'    },
      { key: `s-${session.id}-1hour`,  match: diffMins >= 59 && diffMins <= 61,  when: '1hour'  },
      { key: `s-${session.id}-1day`,   match: diffMins >= 1439 && diffMins <= 1441, when: '1day' }
    ];

    for (const { key, match, when } of checks) {
      if (!match || notified[key]) continue;
      const ok = await sendTelegram(fmtSession(session, when));
      if (ok !== false) {
        notified[key] = now.toISOString();
        fired.push({ type: 'session', title: session.title, when });
        changed = true;
      }
    }
  }

  // ── Custom reminders (tasks) ─────────────
  for (const task of tasks) {
    if (task.completed || !task.dueDate || !task.dueTime || !task.reminders?.length) continue;
    const [y,m,d]=task.dueDate.split('-').map(Number), [h,mi]=task.dueTime.split(':').map(Number);
    const dueMs = new Date(y,m-1,d,h,mi,0,0).getTime();
    await checkCustomReminder('task', task, dueMs, task.dueDate);
  }

  // ── Custom reminders (sessions) ──────────
  for (const sess of sessions) {
    if (!sess.date || !sess.time || !sess.reminders?.length) continue;
    const [y,m,d]=sess.date.split('-').map(Number), [h,mi]=sess.time.split(':').map(Number);
    const dueMs = new Date(y,m-1,d,h,mi,0,0).getTime();
    await checkCustomReminder('session', sess, dueMs, sess.date);
  }

  // ── Custom reminders (deadlines, anchor 09:00) ──
  for (const dl of deadlines) {
    if (!dl.deadline || !dl.reminders?.length) continue;
    const [y,m,d]=dl.deadline.split('-').map(Number);
    const dueMs = new Date(y,m-1,d,9,0,0,0).getTime();
    await checkCustomReminder('deadline', dl, dueMs, dl.deadline);
  }

  if (changed) writeJSON(NOTIFIED_FILE, notified);

  if (fired.length) {
    appendLog({ event: 'notifications_sent', count: fired.length, fired });
  }

  console.log(`[${todayStr} ${nowTime}] tasks:${tasks.length} sessions:${sessions.length} fired:${fired.length}`);
}, { timezone: TIMEZONE });

// ════════════════════════════════════════
// DAILY MORNING SUMMARY — 7:00 AM
// ════════════════════════════════════════

const MOTIVATIONAL_QUOTES = [
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
  'كل تحدٍّ قانوني هو فرصة لإثبات كفاءتك وصقل خبرتك',
  'الصبر والمثابرة يحوّلان القضايا الصعبة إلى انتصارات ممكنة',
  'ابدأ يومك بنية صادقة وستجد أن الصعاب تتراجع أمام عزيمتك',
  'الاستعداد المبكر للجلسة هو نصف الانتصار فيها',
];

const DAYS_AR   = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const MONTHS_AR = ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                   'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const PRI_ICON  = { high: '🔴', medium: '🟡', low: '🟢' };

function buildDailySummary(now, tasks, sessions, deadlines) {
  const today  = dateStr(now);
  const plus3  = dateStr(new Date(now.getTime() + 3 * 86400000));

  // اختيار رسالة تحفيزية بناءً على رقم اليوم في السنة
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const quote     = MOTIVATIONAL_QUOTES[dayOfYear % MOTIVATIONAL_QUOTES.length];

  // ── بناء الرسالة ──
  let msg = '';

  // العنوان والتاريخ
  msg += `🌅 *صباح الخير ⚖️*\n`;
  msg += `📅 *${DAYS_AR[now.getDay()]}، ${now.getDate()} ${MONTHS_AR[now.getMonth()]} ${now.getFullYear()}*\n`;
  msg += `\n_"${quote}"_\n`;
  msg += `\n${SEP}\n`;

  // 1. جلسات اليوم
  const todaySess = sessions
    .filter(s => s.date === today)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  if (todaySess.length) {
    msg += `\n🏛️ *جلسات اليوم — ${todaySess.length} جلسة:*\n`;
    todaySess.forEach(s => {
      msg += `\n▪️ *${s.time || '—'}* — ${s.client || '—'}\n`;
      if (s.court)   msg += `   🏛️ ${s.court}\n`;
      if (s.caseNum) msg += `   📋 القضية: ${s.caseNum}\n`;
      if (s.sessType) msg += `   🏷️ ${s.sessType}\n`;
      if (s.notes)   msg += `   📝 ${s.notes}\n`;
    });
  } else {
    msg += `\n🏛️ *جلسات اليوم:* لا توجد جلسات\n`;
  }

  // 2. مهام اليوم (يومية + مجدولة لهذا اليوم)
  const todayTasks = tasks
    .filter(t => !t.completed && (
      t.dueDate === today ||
      (!t.dueDate && t.category === 'daily')
    ))
    .sort((a, b) => {
      const p = { high: 0, medium: 1, low: 2 };
      return (p[a.priority] ?? 1) - (p[b.priority] ?? 1);
    });

  msg += `\n${SEP}\n`;
  if (todayTasks.length) {
    msg += `\n📋 *مهام اليوم — ${todayTasks.length} مهمة:*\n`;
    todayTasks.slice(0, 8).forEach(t => {
      const icon = PRI_ICON[t.priority] || '⚪';
      msg += `• ${icon} ${t.title}`;
      if (t.dueTime) msg += ` 🕐 ${t.dueTime}`;
      if (t.subcategory) msg += ` _(${t.subcategory})_`;
      msg += '\n';
    });
    if (todayTasks.length > 8) msg += `_...و${todayTasks.length - 8} مهام أخرى_\n`;
  } else {
    msg += `\n📋 *مهام اليوم:* لا توجد مهام مجدولة\n`;
  }

  // 3. المواعيد القانونية المنتهية خلال 3 أيام
  const nearDls = deadlines
    .filter(d => d.deadline >= today && d.deadline <= plus3)
    .sort((a, b) => a.deadline.localeCompare(b.deadline));

  msg += `\n${SEP}\n`;
  if (nearDls.length) {
    msg += `\n⚖️ *مواعيد قانونية قادمة خلال 3 أيام — ${nearDls.length}:*\n`;
    nearDls.forEach(d => {
      const [dy, dm, dd] = (d.deadline || '').split('-').map(Number);
      const diffMs = new Date(dy, dm - 1, dd, 9, 0, 0).getTime() - now.getTime();
      const diff   = Math.round(diffMs / 86400000);
      const when   = diff <= 0 ? '⚠️ *اليوم!*' : diff === 1 ? '⏰ *غداً*' : `📅 بعد ${diff} أيام`;
      msg += `\n▪️ *${d.name}*\n`;
      msg += `   ${when} — ${dd}/${dm}/${dy}\n`;
      if (d.category) msg += `   🏷️ ${d.category}\n`;
      if (d.notes)    msg += `   📝 ${d.notes}\n`;
    });
  } else {
    msg += `\n⚖️ *مواعيد قانونية قادمة:* لا توجد خلال 3 أيام\n`;
  }

  // 4. المهام المتأخرة
  const overdue = tasks
    .filter(t => !t.completed && t.dueDate && t.dueDate < today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  msg += `\n${SEP}\n`;
  if (overdue.length) {
    msg += `\n⏰ *مهام متأخرة — ${overdue.length} مهمة:*\n`;
    overdue.slice(0, 6).forEach(t => {
      const d = Math.abs(Math.round(
        (new Date(t.dueDate + 'T12:00:00').getTime() - now.getTime()) / 86400000
      ));
      const icon = PRI_ICON[t.priority] || '⚪';
      msg += `• ${icon} ${t.title} _(منذ ${d} يوم)_\n`;
    });
    if (overdue.length > 6) msg += `_...و${overdue.length - 6} مهام أخرى متأخرة_\n`;
  } else {
    msg += `\n✅ *لا توجد مهام متأخرة — أحسنت!*\n`;
  }

  // خلاصة إذا لا يوجد شيء
  const isEmpty = !todaySess.length && !todayTasks.length && !nearDls.length && !overdue.length;
  if (isEmpty) {
    msg += `\n\n🎉 *يوم فارغ من المواعيد — استثمره في التطوير والإعداد!*\n`;
  }

  msg += `\n${SEP}`;
  return msg;
}

cron.schedule('0 7 * * *', async () => {
  const now       = nowInTZ();
  const today     = dateStr(now);
  const tasks     = readJSON(TASKS_FILE,     []);
  const sessions  = readJSON(SESSIONS_FILE,  []);
  const deadlines = readJSON(DEADLINES_FILE, []);

  console.log(`[DAILY] Building morning summary for ${today}`);

  const text = buildDailySummary(now, tasks, sessions, deadlines);
  const ok   = await sendTelegram(text);

  appendLog({ event: 'daily_summary', ok, date: today,
    stats: {
      sessions:  sessions.filter(s => s.date === today).length,
      tasks:     tasks.filter(t => !t.completed && (t.dueDate === today || (!t.dueDate && t.category === 'daily'))).length,
      overdue:   tasks.filter(t => !t.completed && t.dueDate && t.dueDate < today).length,
      deadlines: deadlines.filter(d => d.deadline >= today && d.deadline <= dateStr(new Date(now.getTime() + 3*86400000))).length,
    }
  });
  console.log(`[DAILY] Summary sent: ${ok}`);
}, { timezone: TIMEZONE });

// ════════════════════════════════════════
// EXPRESS APP
// ════════════════════════════════════════
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// ── Health & status ─────────────────────
app.get('/', (req, res) => {
  res.json({
    status:    'ok',
    time:      new Date().toISOString(),
    timezone:  TIMEZONE,
    telegram:  !!TG_TOKEN,
    tasks:     readJSON(TASKS_FILE,    []).length,
    sessions:  readJSON(SESSIONS_FILE, []).length,
    notified:  Object.keys(readJSON(NOTIFIED_FILE, {})).length
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Tasks ───────────────────────────────
app.get('/tasks', (_req, res) => {
  res.json(readJSON(TASKS_FILE, []));
});

app.post('/tasks', (req, res) => {
  const { tasks, subcats } = req.body;
  if (!Array.isArray(tasks))
    return res.status(400).json({ error: 'tasks must be an array' });

  writeJSON(TASKS_FILE, tasks);
  if (subcats) writeJSON(SUBCATS_FILE, subcats);

  appendLog({ event: 'tasks_saved', count: tasks.length });
  console.log(`[TASKS] Saved ${tasks.length} tasks`);
  res.json({ ok: true, count: tasks.length });
});

app.delete('/tasks/:id', (req, res) => {
  const tasks = readJSON(TASKS_FILE, []).filter(t => t.id !== req.params.id);
  writeJSON(TASKS_FILE, tasks);
  res.json({ ok: true });
});

// ── Sessions ────────────────────────────
app.get('/sessions', (_req, res) => {
  res.json(readJSON(SESSIONS_FILE, []));
});

app.post('/sessions', (req, res) => {
  let sessions = req.body;
  if (!Array.isArray(sessions)) sessions = [sessions];
  writeJSON(SESSIONS_FILE, sessions);
  appendLog({ event: 'sessions_saved', count: sessions.length });
  console.log(`[SESSIONS] Saved ${sessions.length} sessions`);
  res.json({ ok: true, count: sessions.length });
});

// ── Deadlines ──────────────────────────────
app.get('/deadlines', (_req, res) => res.json(readJSON(DEADLINES_FILE, [])));

app.post('/deadlines', (req, res) => {
  let dls = req.body;
  if (!Array.isArray(dls)) dls = [dls];
  writeJSON(DEADLINES_FILE, dls);
  console.log(`[DEADLINES] Saved ${dls.length}`);
  res.json({ ok: true, count: dls.length });
});

// Add or update a single session
app.put('/sessions/:id', (req, res) => {
  const sessions = readJSON(SESSIONS_FILE, []);
  const idx      = sessions.findIndex(s => s.id === req.params.id);
  const session  = { ...req.body, id: req.params.id };
  if (idx >= 0) sessions[idx] = session;
  else sessions.push(session);
  writeJSON(SESSIONS_FILE, sessions);
  res.json({ ok: true, session });
});

app.delete('/sessions/:id', (req, res) => {
  const sessions = readJSON(SESSIONS_FILE, []).filter(s => s.id !== req.params.id);
  writeJSON(SESSIONS_FILE, sessions);
  // Clear its notifications so it can fire again if re-added
  const notified = readJSON(NOTIFIED_FILE, {});
  Object.keys(notified).filter(k => k.startsWith(`s-${req.params.id}-`)).forEach(k => delete notified[k]);
  writeJSON(NOTIFIED_FILE, notified);
  res.json({ ok: true });
});

// ── Test & manual send ───────────────────
// Manual daily summary trigger
// إرسال الملخص الصباحي يدوياً للاختبار
app.post('/daily-summary', async (_req, res) => {
  const now       = nowInTZ();
  const tasks     = readJSON(TASKS_FILE,     []);
  const sessions  = readJSON(SESSIONS_FILE,  []);
  const deadlines = readJSON(DEADLINES_FILE, []);
  const text      = buildDailySummary(now, tasks, sessions, deadlines);
  const ok        = await sendTelegram(text);
  appendLog({ event: 'daily_summary_manual', ok, date: dateStr(now) });
  res.json({ ok, preview: text.slice(0, 200) + '...' });
});

app.post('/test', async (_req, res) => {
  const ok = await sendTelegram(
    '🔔 *اختبار الإشعارات*\n\n✅ سيرفر التذكيرات يعمل بشكل صحيح\n⏰ ' + new Date().toLocaleString('ar-SA', { timeZone: TIMEZONE })
  );
  res.json({ ok });
});

app.post('/notify', async (req, res) => {
  const { text, silent } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const ok = await sendTelegram(text, !!silent);
  res.json({ ok });
});

// ── Logs ─────────────────────────────────
app.get('/logs', (_req, res) => {
  res.json(readJSON(LOG_FILE, []));
});

app.delete('/logs', (_req, res) => {
  writeJSON(LOG_FILE, []);
  res.json({ ok: true });
});

// ── Reset notified (force resend) ────────
app.delete('/notified', (_req, res) => {
  writeJSON(NOTIFIED_FILE, {});
  res.json({ ok: true, message: 'Notification cache cleared' });
});

app.delete('/notified/:key', (req, res) => {
  const notified = readJSON(NOTIFIED_FILE, {});
  delete notified[decodeURIComponent(req.params.key)];
  writeJSON(NOTIFIED_FILE, notified);
  res.json({ ok: true });
});

// ════════════════════════════════════════
// START
// ════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║       Reminder Server  v1.0          ║
╚══════════════════════════════════════╝
  🚀  Port     : ${PORT}
  🌍  Timezone : ${TIMEZONE}
  🤖  Telegram : ${TG_TOKEN ? '✅ Configured' : '❌ NOT configured (set TG_TOKEN)'}
  📋  Tasks    : ${readJSON(TASKS_FILE,    []).length}
  🗓️   Sessions : ${readJSON(SESSIONS_FILE, []).length}

  Endpoints:
  GET  /            → status
  GET  /health      → health check
  POST /tasks       → sync tasks from app
  GET  /tasks       → list tasks
  POST /sessions    → sync sessions
  PUT  /sessions/:id → add/update session
  DEL  /sessions/:id → delete session
  POST /test        → send test Telegram message
  POST /notify      → send custom message
  GET  /logs        → notification history
  DEL  /notified    → reset notification cache
`);
});
