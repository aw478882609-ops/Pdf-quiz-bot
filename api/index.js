// =========================================================
// 🎮 Vercel Controller - Version 53.0 (Persisted Maintenance Mode + Ban System + Min-Keys-for-Generate)
// Features: Detailed Admin Help | HTML Escaping | Spoiler Mode | Text-to-Quiz | Image-to-Quiz | Doc-to-Quiz | Broadcast | Quiz-to-PDF | User API Keys | Extract/Generate Mode Picker | Ban System
//
// 🩹 CHANGELOG vs 52.0:
// 1) FIXED: Maintenance mode ("وضع الصيانة") used to live in an in-memory
//    `global.isMaintenanceMode` variable. On Vercel this is NOT reliable:
//    serverless functions can spin up fresh instances at any time (cold
//    starts, scale-out, redeploys), each with its OWN copy of `global`, so
//    /repairon in one instance would silently NOT apply to requests handled
//    by another instance — regular users could keep using the bot even
//    though the admin had "turned on" maintenance mode. Maintenance mode is
//    now persisted in Supabase (bot_config key `maintenance_mode`) via new
//    getMaintenanceMode()/setMaintenanceMode() helpers, and is read fresh on
//    every single request — so it now reliably blocks all non-admin users
//    everywhere, on every instance, immediately after /repairon.
// 2) NEW: /ban <user_id> — admin-only command to fully block a user (by
//    Telegram user id) from using the bot. Banned users get a polite
//    "you are banned" notice on any message or button tap; every other flow
//    (file/photo/text/poll/keys/etc.) is short-circuited before it runs.
// 3) NEW: /unban <user_id> — removes a user from the ban list.
// 4) NEW: /banlist — lists all currently banned user ids.
//    Ban state is persisted the same way as maintenance mode: Supabase
//    bot_config key `banned_users` holding an array of id strings, via new
//    getBannedUsers()/setBannedUsers()/isUserBanned() helpers.
// 5) NEW: MIN_USER_KEYS_FOR_GENERATE = 2 — the "🤖 إنشاء أسئلة بالذكاء
//    الاصطناعي" (AI-generate) mode now requires the user to have AT LEAST 2
//    of their own active Gemini API keys saved (previously just 1 was
//    enough). The cmd_filemode_generate callback now checks
//    userKeys.length < MIN_USER_KEYS_FOR_GENERATE and, if the user falls
//    short, tells them exactly how many keys they currently have vs how many
//    are required, and points them to /addkey.
// 6) /adminhelp updated to document /ban, /unban, /banlist, and to clarify
//    the 2-key minimum for AI-generation.
// =========================================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const micro = require('micro');

// ⚙️ إعدادات البيئة
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

// 🗄️ إعدادات Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// 🧠 الذاكرة المؤقتة
// ⚠️ [53.0] ملاحظة مهمة: global.* غير موثوق فيه في بيئة Vercel Serverless، لأن كل
// استدعاء (invocation) ممكن يشتغل على instance مختلفة/جديدة تماماً بدون أي تحذير
// (Cold Start / Scale-out / إعادة نشر). لذلك تم نقل حالة "وضع الصيانة" وحالة
// "المستخدمين المحظورين" بالكامل لتخزين دائم وموثوق في Supabase (راجع
// getMaintenanceMode/setMaintenanceMode و getBannedUsers/setBannedUsers أسفل).
if (!global.userState) global.userState = {};

// حد أقصى تقريبي لطول النص المجمّع قبل رفض استلام المزيد (يطابق حد GAS)
const MAX_TEXT_BUFFER_LENGTH = 30000;

// حد أقصى لعدد الأسئلة المجمّعة في جلسة /quizpdf الواحدة (حماية من حمولة ضخمة جداً)
const MAX_QUIZPDF_BUFFER = 300;

// ✨ [45.0] عدد التحليلات التقريبي الإضافي اليومي اللي بيوفره كل مفتاح مستخدم يضيفه
// (يُستخدم فقط في رسالة /addkey التوضيحية، مش قيد فعلي بيتفرض في الكود).
const APPROX_ANALYSES_PER_KEY = 20;

// ⚠️ [51.0] تم حذف MAX_USER_KEYS_PER_USER بالكامل — لا يوجد حد أقصى لعدد المفاتيح
// التي يمكن للمستخدم إضافتها بعد الآن.

// ✨ [52.0] حدود عدد الأسئلة القابل لطلبه في وضع "إنشاء بالذكاء الاصطناعي" (يطابق
// الحدود المطبّقة فعلياً داخل GAS: Math.max(1, Math.min(50, ...))).
const MIN_GENERATE_COUNT = 1;
const MAX_GENERATE_COUNT = 50;
const DEFAULT_GENERATE_COUNT = 10;

// ✨ [53.0] الحد الأدنى لعدد مفاتيح Gemini الخاصة بالمستخدم اللازمة قبل السماح له
// باستخدام ميزة "إنشاء أسئلة بالذكاء الاصطناعي" (generate mode). كان 1 مفتاح كافياً
// سابقاً، وأصبح الآن يتطلب مفتاحين على الأقل.
const MIN_USER_KEYS_FOR_GENERATE = 2;

// ✨ [جديد] أنواع MIME الخاصة بمستندات Word المدعومة، تُعامل مثل PDF تماماً (تحليل مباشر
// عبر analyze_async مع تمرير mimeType الحقيقي للـ backend بدل افتراض application/pdf).
const WORD_MIME_TYPES = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'application/msword' // .doc
];

// =========================================================
// 🛠️ دوال مساعدة (Helpers)
// =========================================================

// ✅ دالة لتنظيف النصوص من الرموز التي تكسر HTML
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ✨ دالة تنسيق الكويز (مع التنظيف ووضع الإجابة في سبويلر منفصل)
function formatQuizText(quiz) {
    let text = `<b>${escapeHtml(quiz.question)}</b>\n\n`; // سطر فارغ بعد السؤال
    const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

    // عرض الاختيارات
    quiz.options.forEach((opt, index) => {
        const letter = optionLetters[index] || (index + 1);
        text += `<b>${letter})</b> ${escapeHtml(opt)}\n\n`;
    });

    // إضافة سطر الإجابة المنفصل
    if (quiz.correctOptionId !== null && quiz.correctOptionId >= 0) {
        const correctLetter = optionLetters[quiz.correctOptionId];
        const correctText = quiz.options[quiz.correctOptionId];
        // الإجابة في سطر منفصل ومشوشة
        text += `<span class="tg-spoiler">✅ <b>الإجابة الصحيحة:</b> ${correctLetter}) ${escapeHtml(correctText)}</span>`;
    }

    if (quiz.explanation) {
        text += `\n\n<span class="tg-spoiler">💡 <b>توضيح:</b> ${escapeHtml(quiz.explanation)}</span>`;
    }
    return text;
}

// ✂️ دمج أجزاء النص المرسلة على أكثر من رسالة، مع مراعاة قطع الكلمات بين الأجزاء
function smartJoinParts(parts) {
    let result = '';
    for (let i = 0; i < parts.length; i++) {
        if (i === 0) { result = parts[i]; continue; }
        const prevChar = result.slice(-1);
        // لو الجزء السابق انتهى بمسافة/علامة ترقيم، نضيف سطر جديد بينهما
        // غير كده (يعني في المنتصف/داخل كلمة) نلزقهم على طول من غير فاصل
        const endsClean = /[\s\n.!?؟،,;:)\]}]$/.test(prevChar) || prevChar === '';
        result += endsClean ? '\n' + parts[i] : parts[i];
    }
    return result;
}

// ✨ يخفي معظم مفتاح الـ API ولا يعرض إلا أول 6 وآخر 4 خانات، عشان
// المستخدم يقدر يميّز مفاتيحه من بعض من غير ما نعرض المفتاح كامل في الشات.
function maskApiKey(key) {
    if (!key || key.length < 10) return '****';
    return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

// =========================================================
// 🗄️ دوال قاعدة البيانات (Supabase)
// =========================================================

async function setBotConfig(key, value) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/bot_config`, {
            key: key, value: value
        }, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }
        });
    } catch (e) { console.error("❌ Config Set Error:", e.message); }
}

async function getBotConfig(key) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    try {
        const res = await axios.get(`${SUPABASE_URL}/rest/v1/bot_config?key=eq.${key}`, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        return res.data?.[0]?.value || null;
    } catch (e) { return null; }
}

async function deleteBotConfig(key) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.delete(`${SUPABASE_URL}/rest/v1/bot_config?key=eq.${key}`, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
    } catch (e) { console.error("❌ Config Delete Error:", e.message); }
}

// --- إدارة مخزن نص "تحويل النص إلى أسئلة" (يعتمد على bot_config الموجودة أصلاً) ---
async function getTextBuffer(userId) {
    return await getBotConfig(`textbuf_${userId}`);
}
async function setTextBuffer(userId, value) {
    await setBotConfig(`textbuf_${userId}`, value);
}
async function clearTextBuffer(userId) {
    await deleteBotConfig(`textbuf_${userId}`);
}

// --- إدارة مخزن جلسة "/quizpdf" (تجميع كويزات محلولة لتحويلها لملف PDF مراجعة) ---
async function getQuizPdfBuffer(userId) {
    return await getBotConfig(`quizpdfbuf_${userId}`);
}
async function setQuizPdfBuffer(userId, value) {
    await setBotConfig(`quizpdfbuf_${userId}`, value);
}
async function clearQuizPdfBuffer(userId) {
    await deleteBotConfig(`quizpdfbuf_${userId}`);
}

// --- إدارة حالة "/addkey" (بانتظار المستخدم يلصق مفتاحه) ---
async function getAddKeyState(userId) {
    return await getBotConfig(`addkeybuf_${userId}`);
}
async function setAddKeyState(userId, value) {
    await setBotConfig(`addkeybuf_${userId}`, value);
}
async function clearAddKeyState(userId) {
    await deleteBotConfig(`addkeybuf_${userId}`);
}

// ✨ [52.0] إدارة حالة "الملف المعلّق" — من لحظة استلام PDF/Word/صورة وحتى تحديد
// المستخدم لكل الخيارات المطلوبة (وضع الاستخراج/الإنشاء، العناوين، عدد الأسئلة،
// التعليمات الإضافية). نفس نمط bot_config المستخدم في باقي الجلسات المؤقتة.
async function getPendingFile(userId) {
    return await getBotConfig(`pendingfile_${userId}`);
}
async function setPendingFile(userId, value) {
    await setBotConfig(`pendingfile_${userId}`, value);
}
async function clearPendingFile(userId) {
    await deleteBotConfig(`pendingfile_${userId}`);
}

// ✨ [53.0] إدارة وضع الصيانة — مخزّن بشكل دائم في Supabase (bot_config) بدل متغير
// عام (global.*) غير موثوق فيه على Vercel Serverless. يُقرأ من جديد على كل طلب.
async function getMaintenanceMode() {
    const cfg = await getBotConfig('maintenance_mode');
    return !!(cfg && cfg.enabled);
}
async function setMaintenanceMode(enabled) {
    await setBotConfig('maintenance_mode', { enabled: !!enabled });
}

// ✨ [53.0] إدارة قائمة المستخدمين المحظورين — نفس منطق التخزين الدائم أعلاه.
// القيمة المخزّنة: { ids: ["123456789", "987654321", ...] } (مصفوفة نصوص).
async function getBannedUsers() {
    const cfg = await getBotConfig('banned_users');
    return (cfg && Array.isArray(cfg.ids)) ? cfg.ids : [];
}
async function setBannedUsers(ids) {
    await setBotConfig('banned_users', { ids });
}
async function isUserBanned(userId) {
    const banned = await getBannedUsers();
    return banned.indexOf(String(userId)) !== -1;
}

// ✨ مفاتيح API الخاصة بالمستخدمين (جدول user_api_keys منفصل عن bot_config)
async function getUserApiKeysList(userId) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return [];
    try {
        const res = await axios.get(
            `${SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${userId}&is_active=eq.true&select=id,api_key,added_at&order=added_at.asc`,
            { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        return res.data || [];
    } catch (e) { console.error("❌ GetUserKeys Error:", e.message); return []; }
}

async function addUserApiKeyToDb(userId, apiKey) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return false;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/user_api_keys?on_conflict=user_id,api_key`, {
            user_id: userId, api_key: apiKey, is_active: true
        }, {
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates'
            }
        });
        return true;
    } catch (e) { console.error("❌ AddUserKey Error:", e.message); return false; }
}

async function removeUserApiKeyFromDb(id, userId) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return false;
    try {
        await axios.delete(`${SUPABASE_URL}/rest/v1/user_api_keys?id=eq.${id}&user_id=eq.${userId}`, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        return true;
    } catch (e) { console.error("❌ RemoveUserKey Error:", e.message); return false; }
}

// ✨ يتحقق من صلاحية مفتاح Gemini API فعلياً قبل حفظه، عن طريق نداء
// خفيف لـ ListModels (لا يستهلك أي كوتا توليد نصوص، فقط يتأكد إن المفتاح مقبول).
// ⚠️ [51.0] هذه الآن نقطة التحقق الوحيدة من صحة المفتاح — لا يوجد أي فلترة شكلية
// (regex) قبلها؛ أي نص يلصقه المستخدم يُمرَّر مباشرة هنا.
async function validateGeminiApiKey(apiKey) {
    try {
        const res = await axios.get(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
            { timeout: 10000 }
        );
        if (res.status === 200 && res.data && Array.isArray(res.data.models)) {
            return { valid: true };
        }
        return { valid: false, reason: 'Unexpected response from Google.' };
    } catch (e) {
        const apiMsg = e.response?.data?.error?.message || e.message;
        return { valid: false, reason: apiMsg };
    }
}

// ✨ يحوّل poll تيليجرام (type: quiz) لكائن quizData موحّد، مستخدَم في كل الأماكن
// اللي بتتعامل مع كويزات (العرض العادي، تجميع /quizpdf، إلخ) عشان شرط "لازم يكون له
// إجابة" يتطبق بنفس الطريقة في كل مكان ومفيش أي مسار بيتغاضى عنه بالغلط.
function quizPollToData(poll) {
    const quizData = {
        question: poll.question,
        options: poll.options.map(opt => opt.text),
        correctOptionId: poll.correct_option_id,
        explanation: poll.explanation || null
    };
    const hasAnswer = quizData.correctOptionId !== null && quizData.correctOptionId !== undefined && quizData.correctOptionId >= 0;
    return { quizData, hasAnswer };
}

// ✨ الرسالة الموحّدة اللي بتتبعت لما يوصل كويز بدون إجابة واضحة، سواء في المسار
// العادي أو أثناء تجميع /quizpdf — نفس الشرط ونفس التوجيه في كل مكان.
async function sendUnsolvedQuizNotice(chatId, replyToMessageId) {
    await bot.sendMessage(chatId,
        `⚠️ <b>هذا الكويز غير محلول ولا يحتوي على إجابة واضحة.</b>\n\n` +
        `البوت لا يستطيع التعرف على الإجابة الصحيحة إلا إذا وصله الكويز كنسخة يملكها هو نفسه.\n\n` +
        `👉 يرجى:\n` +
        `1️⃣ حل الكويز وتحديد الإجابة الصحيحة فيه.\n` +
        `2️⃣ إعادة توجيهه (Forward) مع تفعيل خاصية <b>"إخفاء اسم المرسل / Hide My Name"</b>.\n` +
        `3️⃣ إرساله للبوت مرة أخرى بهذه الطريقة.`,
        { reply_to_message_id: replyToMessageId, parse_mode: 'HTML' }
    );
}

async function upsertUser(user, alertIdSeen = null) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        const payload = {
            user_id: user.id,
            first_name: user.first_name,
            username: user.username || null,
            last_active: new Date().toISOString()
        };
        if (alertIdSeen) payload.seen_alert_id = alertIdSeen;

        await axios.post(`${SUPABASE_URL}/rest/v1/users`, payload, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }
        });
    } catch (e) { console.error("❌ Upsert Error:", e.message); }
}

async function getUserData(userId) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    try {
        const res = await axios.get(`${SUPABASE_URL}/rest/v1/users?user_id=eq.${userId}`, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        return res.data?.[0] || null;
    } catch (e) { return null; }
}

// ✨ FIX: يطلب return=representation عشان نقدر نرجّع الـ id بتاع السجل، ونستخدمه بعدين
// عشان نقفل نفس السجل بحالة success/failed بدل ما يفضل عالق على 'processing' للأبد.
// كمان model_used بقى null بدل الافتراضي 'gemini-2.5-flash' لأنه لسه مش معروف وقت الإنشاء.
async function logUsage(userId, fileId, fileName, count, model, status, method, errorReason = null) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    try {
        const res = await axios.post(`${SUPABASE_URL}/rest/v1/processing_logs`, {
            user_id: userId,
            file_id: fileId || null,
            file_name: fileName || 'unknown',
            status: status,
            method: method || 'vision',
            model_used: model || null,
            questions_count: parseInt(count) || 0,
            error_reason: errorReason,
            created_at: new Date().toISOString()
        }, {
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation'
            }
        });
        return res.data?.[0]?.id || null;
    } catch (e) { console.error("❌ Log Error:", e.message); return null; }
}

async function checkAndSendAlert(chatId, user) {
    const alertCfg = await getBotConfig('global_alert');
    if (!alertCfg || !alertCfg.text || !alertCfg.id) return;
    const dbUser = await getUserData(user.id);
    if (!dbUser || dbUser.seen_alert_id !== alertCfg.id) {
        await bot.sendMessage(chatId, `🔔 <b>تنويه هام:</b>\n\n${alertCfg.text}`, { parse_mode: 'HTML' });
        await upsertUser(user, alertCfg.id);
    } else {
        await upsertUser(user);
    }
}

async function getGlobalStats() {
    try {
        const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'count=exact' };
        const today = new Date(); today.setHours(0, 0, 0, 0); const todayISO = today.toISOString();
        const [uT, uA, fT, fS, tT, tS, tF, m1, m2, m3] = await Promise.all([
            axios.head(`${SUPABASE_URL}/rest/v1/users`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/users?last_active=gte.${todayISO}`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?status=eq.success`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}&status=eq.success`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}&status=neq.success`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}&model_used=eq.gemini-2.5-flash`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}&model_used=eq.gemma-3-27b-it`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}&method=eq.regex_fallback`, { headers })
        ]);
        const c = (r) => parseInt(r.headers['content-range']?.split('/')[1] || '0');
        return { users: {total: c(uT), active: c(uA)}, files: {total: c(fT), success: c(fS)}, today: {total: c(tT), success: c(tS), fail: c(tF)}, models: {m1: c(m1), m2: c(m2), m3: c(m3)} };
    } catch (e) { return null; }
}

async function getUserStats(targetId) {
    try {
        const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };
        const countHeaders = { ...headers, 'Prefer': 'count=exact' };
        const userRes = await axios.get(`${SUPABASE_URL}/rest/v1/users?user_id=eq.${targetId}`, { headers });
        if (!userRes.data || userRes.data.length === 0) return null;
        const logsRes = await axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?user_id=eq.${targetId}`, { headers: countHeaders });
        return { ...userRes.data[0], totalRequests: logsRes.headers['content-range']?.split('/')[1] || '0' };
    } catch (e) { return null; }
}

async function sendToGasAndForget(payload) {
    try { await axios.post(GAS_WEB_APP_URL, payload, { timeout: 1500 }); }
    catch (error) { if (error.code !== 'ECONNABORTED') console.error("⚠️ GAS Connection Error:", error.message); }
}

// =========================================================
// 📄 [52.0] بدء التحليل الفعلي بعد اكتمال كل اختيارات المستخدم
// =========================================================
// يُستدعى فقط بعد ما المستخدم يحدد:
//   - الوضع (extract أو generate)
//   - extractTitles (لو extract) أو questionCount + customPrompt (لو generate)
// pending يحتوي على: fileId, fileName, mimeType, sourceType, isImage,
// userName, userUsername, mode, extractTitles, questionCount, customPrompt
async function startFileAnalysis(userId, fromUser, chatId, messageId, pending) {
    const isImage = !!pending.isImage;
    const isGen = pending.mode === 'generate';
    const waitLabel = isImage ? 'الصورة' : (pending.mimeType === 'application/pdf' ? 'الملف' : 'ملف Word');
    const method = isImage ? 'image_vision' : 'url_handover';

    const logId = await logUsage(userId, pending.fileId, pending.fileName, 0, null, 'processing', method);

    try {
        await bot.editMessageText(`⏳ <b>جاري تحضير ${waitLabel}...</b>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    } catch (e) { /* الرسالة ممكن تكون اتمسحت، نتجاهل */ }

    try {
        const fileLink = await bot.getFileLink(pending.fileId);

        const processingMsg = isGen
            ? `🤖 <b>يتم إنشاء ${pending.questionCount || DEFAULT_GENERATE_COUNT} سؤال جديد بالذكاء الاصطناعي من محتوى ${waitLabel}...</b>\n\n⏳ الرجاء الانتظار، قد تستغرق العملية وقتاً حسب الحجم.`
            : `🤖 <b>يتم تحليل ${waitLabel} واستخراج الأسئلة بالذكاء الاصطناعي...</b>\n\n` +
              `⏳ الرجاء الانتظار، قد تستغرق العملية وقتاً حسب الحجم.\n` +
              (!isImage ? `⚠️ <b>تنبيه:</b> إذا استمرت معالجة الملف أكثر من 6 دقائق، فسيتم إيقاف المعالجة إجبارياً ويجب تقسيم الملف المرسل.` : '');

        await bot.editMessageText(processingMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });

        // ✨ sourceType بيوصل زي ما هو ('document' أو 'photo') عشان GAS يعرف يستخدم
        // sendDocument/sendPhoto الصح للإشعار الإداري.
        // ✨ mode/extractTitles/customPrompt/questionCount بيوصلوا لـ GAS اللي بيقرر
        // بناءً عليهم يستخدم مفاتيح المستخدم فقط (وضع generate) أو المفاتيح العامة
        // فقط (وضع extract)، وبيبني البرومبت المناسب.
        const payload = {
            action: isImage ? 'analyze_image_async' : 'analyze_async',
            fileUrl: fileLink, chatId: chatId, messageId: messageId,
            userId: userId, userName: pending.userName, userUsername: pending.userUsername,
            fileId: pending.fileId, fileName: pending.fileName, mimeType: pending.mimeType, logId: logId,
            sourceType: pending.sourceType,
            mode: isGen ? 'generate' : 'extract'
        };

        if (isGen) {
            payload.questionCount = pending.questionCount || DEFAULT_GENERATE_COUNT;
            payload.customPrompt = pending.customPrompt || '';
        } else {
            payload.extractTitles = pending.extractTitles !== false;
        }

        await sendToGasAndForget(payload);
    } catch (err) {
        console.error("❌ Error:", err.message);
        await logUsage(userId, pending.fileId, pending.fileName, 0, null, 'failed', method, err.message);
        try { await bot.editMessageText('❌ حدث خطأ.', { chat_id: chatId, message_id: messageId }); } catch (e) { /* تجاهل */ }
    }
}

// =========================================================
// 🎮 المعالج الرئيسي (Main Handler)
// =========================================================
module.exports = async (req, res) => {
    try {
        if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
        const update = await micro.json(req);

        const msg = update.message;
        const cb = update.callback_query;
        const fromUser = msg?.from || cb?.from;
        const userId = fromUser?.id ? String(fromUser.id) : null;

        // ---------------------------------------------------------
        // 👮‍♂️ أوامر الأدمن (تم استعادة القائمة الكاملة)
        // ---------------------------------------------------------
        if (userId === ADMIN_CHAT_ID && msg && msg.text) {
            const text = msg.text.trim();

            // 1. دليل الأوامر (المحسن والمفصل)
            if (text === '/adminhelp' || text === '/cmds') {
                const helpMsg = `🛠️ <b>لوحة التحكم والأوامر الإدارية:</b>\n\n` +

                                `📊 <b>الإحصائيات والتقارير:</b>\n` +
                                `• <code>/stats</code>\n` +
                                ` لعرض الإحصائيات العامة واليومية.\n\n` +
                                `• <code>/user + الآيدي</code>\n` +
                                ` مثال: <code>/user 123456789</code>\n` +
                                ` لعرض تقرير عن مستخدم معين.\n\n` +

                                `⚙️ <b>الإعدادات العامة:</b>\n` +
                                `• <code>/setwelcome + النص</code>\n` +
                                ` لتغيير رسالة الترحيب التي تظهر عند البدء.\n\n` +
                                `• <code>/setalert + النص</code>\n` +
                                ` لإرسال تنبيه عام يظهر لجميع المستخدمين مرة واحدة.\n\n` +

                                `📢 <b>البرودكاست:</b>\n` +
                                `• <code>/broadcast + النص</code>\n` +
                                ` لإرسال رسالة فورية لجميع المستخدمين المسجلين (بعد معاينة وتأكيد).\n\n` +

                                `🔧 <b>وضع الصيانة:</b>\n` +
                                `• <code>/repairon</code> : لتفعيل الصيانة (يمنع كل المستخدمين عدا الأدمن من استخدام البوت فوراً وعلى كل السيرفرات).\n` +
                                `• <code>/repairoff</code> : لإيقاف الصيانة.\n\n` +

                                `🚫 <b>حظر المستخدمين:</b>\n` +
                                `• <code>/ban USER_ID</code>\n` +
                                ` مثال: <code>/ban 123456789</code>\n` +
                                ` لحظر مستخدم بالكامل من استخدام البوت.\n\n` +
                                `• <code>/unban USER_ID</code>\n` +
                                ` لرفع الحظر عن مستخدم.\n\n` +
                                `• <code>/banlist</code>\n` +
                                ` لعرض قائمة كل المستخدمين المحظورين حالياً.\n\n` +

                                `🔑 <b>مفاتيح API (مستخدمين):</b>\n` +
                                `• <code>/mykeys</code>, <code>/addkey</code>, <code>/removekey</code>\n` +
                                ` نفس أوامر المستخدم العادي، تعمل للأدمن أيضاً على مفاتيحه الخاصة. لا يوجد حد أقصى لعدد المفاتيح.\n\n` +

                                `📄 <b>عند إرسال ملف/صورة:</b>\n` +
                                ` سيُعرض عليك اختيار "استخراج أسئلة موجودة" (يستخدم مفاتيح البوت العامة) أو "إنشاء أسئلة بالذكاء الاصطناعي" ` +
                                ` (يتطلب ${MIN_USER_KEYS_FOR_GENERATE} مفاتيح Gemini خاصة بك على الأقل).`;

                await bot.sendMessage(userId, helpMsg, { parse_mode: 'HTML' });
                return res.status(200).send('Help');
            }

            if (text === '/stats') {
                await bot.sendMessage(userId, '⏳ <b>جاري التحليل...</b>', { parse_mode: 'HTML' });
                const s = await getGlobalStats();
                if (s) {
                    const rTotal = s.files.total > 0 ? Math.round((s.files.success / s.files.total) * 100) : 0;
                    const rToday = s.today.total > 0 ? Math.round((s.today.success / s.today.total) * 100) : 0;
                    const report = `📊 <b>الإحصائيات:</b>\n\n👥 <b>المستخدمين:</b>\n• الإجمالي: <code>${s.users.total}</code>\n• النشطين اليوم: <code>${s.users.active}</code>\n\n📁 <b>الملفات:</b>\n• العدد: <code>${s.files.total}</code>\n• نسبة النجاح: <code>${rTotal}%</code>\n\n📅 <b>أداء اليوم (${s.today.total}):</b>\n• نجاح: <code>${s.today.success}</code> (${rToday}%)\n• فشل: <code>${s.today.fail}</code>\n-------------------\n🤖 <b>AI اليوم:</b>\n• Flash 2.5: <code>${s.models.m1}</code>\n• Gemma 3: <code>${s.models.m2}</code>\n• Regex: <code>${s.models.m3}</code>`;
                    await bot.sendMessage(userId, report, { parse_mode: 'HTML' });
                } else { await bot.sendMessage(userId, '❌ خطأ في الإحصائيات.'); }
                return res.status(200).send('Stats');
            }

            if (text.startsWith('/user ')) {
                const u = await getUserStats(text.split(' ')[1]);
                if (u) await bot.sendMessage(userId, `👤 <b>تقرير:</b>\n🆔 <code>${u.user_id}</code>\n📛 ${u.first_name}\n📂 ملفات: ${u.totalRequests}`, {parse_mode: 'HTML'});
                else await bot.sendMessage(userId, '❌ غير موجود.');
                return res.status(200).send('User');
            }

            if (text.startsWith('/setwelcome ')) {
                const newMsg = text.replace('/setwelcome ', '').trim();
                await setBotConfig('welcome_msg', { text: newMsg });
                await bot.sendMessage(userId, '✅ تم تحديث الترحيب.');
                return res.status(200).send('Welcome Set');
            }

            if (text.startsWith('/setalert ')) {
                const newAlert = text.replace('/setalert ', '').trim();
                const alertId = `alert_${Date.now()}`;
                await setBotConfig('global_alert', { text: newAlert, id: alertId });
                await bot.sendMessage(userId, `✅ تم نشر التنبيه (ID: ${alertId}).`);
                return res.status(200).send('Alert Set');
            }

            // ✨ /broadcast - معاينة ثم تأكيد قبل الإرسال الفعلي لكل المستخدمين
            if (text.startsWith('/broadcast ')) {
                const broadcastText = text.replace('/broadcast ', '').trim();

                if (!broadcastText) {
                    await bot.sendMessage(userId, '⚠️ اكتب نص الرسالة بعد الأمر. مثال:\n<code>/broadcast مرحباً بالجميع! 🎉</code>', { parse_mode: 'HTML' });
                    return res.status(200).send('Broadcast Empty');
                }

                await setBotConfig(`broadcast_pending_${userId}`, { text: broadcastText });

                const preview = `📢 <b>معاينة رسالة البرودكاست:</b>\n\n` +
                                 `➖➖➖➖➖➖➖➖➖➖\n${broadcastText}\n➖➖➖➖➖➖➖➖➖➖\n\n` +
                                 `⚠️ <b>سيتم إرسال هذه الرسالة فوراً لكل المستخدمين المسجلين في قاعدة البيانات.</b>\nهل أنت متأكد؟`;

                await bot.sendMessage(userId, preview, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [
                        [{ text: '✅ تأكيد الإرسال للجميع', callback_data: 'cmd_broadcast_confirm' }],
                        [{ text: '❌ إلغاء', callback_data: 'cmd_broadcast_cancel' }]
                    ] }
                });
                return res.status(200).send('Broadcast Preview');
            }

            // ✨ [53.0] وضع الصيانة الآن مخزَّن بشكل دائم في Supabase عبر setMaintenanceMode()
            // بدل global.isMaintenanceMode، فبيتطبق فوراً على كل الطلبات القادمة مهما
            // كان عددها من instances على Vercel.
            if (text === '/repairon') {
                await setMaintenanceMode(true);
                await bot.sendMessage(ADMIN_CHAT_ID, '🛠️ <b>تم تفعيل وضع الصيانة.</b>\nكل المستخدمين (عدا الأدمن) لن يتمكنوا من استخدام البوت الآن.', { parse_mode: 'HTML' });
                return res.status(200).send('ON');
            }
            if (text === '/repairoff') {
                await setMaintenanceMode(false);
                await bot.sendMessage(ADMIN_CHAT_ID, '✅ <b>تم إيقاف وضع الصيانة.</b>\nالبوت يعمل الآن بشكل طبيعي لجميع المستخدمين.', { parse_mode: 'HTML' });
                return res.status(200).send('OFF');
            }

            // ✨ [53.0] حظر مستخدم من استخدام البوت بالكامل عبر الآيدي
            if (text.startsWith('/ban ')) {
                const targetId = text.replace('/ban ', '').trim();
                if (!targetId || !/^\d+$/.test(targetId)) {
                    await bot.sendMessage(userId, '⚠️ استخدم: <code>/ban USER_ID</code>\nمثال: <code>/ban 123456789</code>', { parse_mode: 'HTML' });
                    return res.status(200).send('Ban Usage');
                }
                if (targetId === ADMIN_CHAT_ID) {
                    await bot.sendMessage(userId, '⚠️ لا يمكنك حظر نفسك (الأدمن).');
                    return res.status(200).send('Cannot Ban Admin');
                }
                const banned = await getBannedUsers();
                if (banned.indexOf(targetId) !== -1) {
                    await bot.sendMessage(userId, `⚠️ المستخدم <code>${targetId}</code> محظور بالفعل.`, { parse_mode: 'HTML' });
                } else {
                    banned.push(targetId);
                    await setBannedUsers(banned);
                    await bot.sendMessage(userId, `✅ تم حظر المستخدم <code>${targetId}</code> من استخدام البوت.`, { parse_mode: 'HTML' });
                }
                return res.status(200).send('Banned');
            }

            // ✨ [53.0] رفع الحظر عن مستخدم عبر الآيدي
            if (text.startsWith('/unban ')) {
                const targetId = text.replace('/unban ', '').trim();
                if (!targetId || !/^\d+$/.test(targetId)) {
                    await bot.sendMessage(userId, '⚠️ استخدم: <code>/unban USER_ID</code>\nمثال: <code>/unban 123456789</code>', { parse_mode: 'HTML' });
                    return res.status(200).send('Unban Usage');
                }
                let banned = await getBannedUsers();
                if (banned.indexOf(targetId) === -1) {
                    await bot.sendMessage(userId, `⚠️ المستخدم <code>${targetId}</code> غير محظور أصلاً.`, { parse_mode: 'HTML' });
                } else {
                    banned = banned.filter(id => id !== targetId);
                    await setBannedUsers(banned);
                    await bot.sendMessage(userId, `✅ تم رفع الحظر عن المستخدم <code>${targetId}</code>.`, { parse_mode: 'HTML' });
                }
                return res.status(200).send('Unbanned');
            }

            // ✨ [53.0] عرض قائمة كل المستخدمين المحظورين حالياً
            if (text === '/banlist') {
                const banned = await getBannedUsers();
                if (banned.length === 0) {
                    await bot.sendMessage(userId, '📭 لا يوجد أي مستخدم محظور حالياً.');
                } else {
                    const list = banned.map((id, i) => `${i + 1}. <code>${id}</code>`).join('\n');
                    await bot.sendMessage(userId, `🚫 <b>المستخدمون المحظورون (${banned.length}):</b>\n\n${list}`, { parse_mode: 'HTML' });
                }
                return res.status(200).send('BanList');
            }
        }

        // 🚫 [53.0] التحقق من الحظر — يُطبَّق على أي تفاعل (رسالة أو زر) من مستخدم غير
        // الأدمن، قبل أي معالجة أخرى، وقبل حتى فحص وضع الصيانة.
        if (userId && userId !== ADMIN_CHAT_ID) {
            const bannedNow = await isUserBanned(userId);
            if (bannedNow) {
                if (msg) await bot.sendMessage(msg.chat.id, '🚫 <b>تم حظرك من استخدام هذا البوت.</b>', { parse_mode: 'HTML' });
                else if (cb) await bot.answerCallbackQuery(cb.id, { text: '🚫 أنت محظور من استخدام البوت.', show_alert: true });
                return res.status(200).send('Banned User');
            }
        }

        // 🚧 [53.0] التحقق من الصيانة — بيُقرأ الآن من Supabase على كل طلب (بدل متغير
        // عام global.* اللي مش موثوق فيه على Vercel لأن كل استدعاء ممكن يشتغل على
        // instance مختلفة تماماً، فكان ممكن /repairon ميتطبقش فعلياً على كل المستخدمين).
        const maintenanceOn = await getMaintenanceMode();
        if (maintenanceOn && userId !== ADMIN_CHAT_ID) {
             if (msg) await bot.sendMessage(msg.chat.id, '⚠️ <b>عذراً، البوت في وضع الصيانة حالياً.</b>\nسنعود للعمل قريباً.', {parse_mode: 'HTML'});
             else if (cb) await bot.answerCallbackQuery(cb.id, { text: '⚠️ الصيانة مفعلة.', show_alert: true });
             return res.status(200).send('Maintenance');
        }

        // =========================================================
        // 0️⃣ أمر /start
        // =========================================================
        if (msg && msg.text && msg.text.startsWith('/start')) {
            const chatId = msg.chat.id;
            const welcomeCfg = await getBotConfig('welcome_msg');
            const welcomeText = welcomeCfg?.text ||
                `مرحباً بك ${fromUser.first_name}! 👋\n\n` +
                `📚 <b>أرسل لي ملف PDF أو Word أو صورة، وسأسألك هل تريد استخراج الأسئلة الموجودة فيه أو إنشاء أسئلة جديدة بالذكاء الاصطناعي.</b>\n\n` +
                `📝 أو استخدم الأمر /text لتحويل نص (تكتبه أو تلصقه) إلى أسئلة مباشرة.\n\n` +
                `📄 أو استخدم الأمر /quizpdf لتجميع كويزات محلولة (Quiz Polls) وتحويلها لملف PDF مراجعة.\n\n` +
                `🔑 <b>جديد:</b> أضف مفتاح Gemini API الخاص بك (مجاني) عبر /addkey. ` +
                `ميزة "إنشاء أسئلة بالذكاء الاصطناعي" <b>تتطلب ${MIN_USER_KEYS_FOR_GENERATE} مفاتيح على الأقل</b> من مفاتيحك الخاصة. ` +
                `كل مفتاح يمنحك ما يقارب ${APPROX_ANALYSES_PER_KEY} تحليل إضافي يومياً، ويمكنك إضافة أي عدد من المفاتيح. استخدم /mykeys لعرض مفاتيحك و /removekey لحذفها.`;
            await bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML' });
            await checkAndSendAlert(chatId, fromUser);
            return res.status(200).send('Start');
        }

        // =========================================================
        // 0.5️⃣ أمر /text - بدء وضع تحويل النص إلى أسئلة
        // =========================================================
        if (msg && msg.text && msg.text.startsWith('/text')) {
            const chatId = msg.chat.id;

            await clearTextBuffer(userId);
            await setTextBuffer(userId, { active: true, parts: [], promptMsgId: null });

            await bot.sendMessage(chatId,
                `📝 <b>وضع تحويل النص إلى أسئلة</b>\n\n` +
                `أرسل النص الآن (يمكنك إرساله على أكثر من رسالة متتالية لو كان طويلاً أو مقسوماً).\n` +
                `عند الانتهاء اضغط "✅ تم - استخرج الأسئلة".`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cmd_text_cancel' }]] }
                }
            );
            return res.status(200).send('Text Mode Start');
        }

        // =========================================================
        // 0.6️⃣ أمر /quizpdf - بدء جلسة تجميع كويزات محلولة لتحويلها لملف PDF مراجعة
        // =========================================================
        if (msg && msg.text && msg.text.startsWith('/quizpdf')) {
            const chatId = msg.chat.id;

            await clearQuizPdfBuffer(userId);
            await setQuizPdfBuffer(userId, { active: true, quizzes: [], promptMsgId: null });

            await bot.sendMessage(chatId,
                `📄 <b>وضع تجميع الكويزات لملف PDF مراجعة</b>\n\n` +
                `أرسل الآن الكويزات (Quiz Polls) <b>المحلولة</b> واحدة تلو الأخرى (يمكنك توجيهها/Forward).\n` +
                `⚠️ أي كويز بدون إجابة محددة سيُرفض تلقائياً وسيُطلب منك حله وإعادة إرساله.\n\n` +
                `عند الانتهاء اضغط "📄 إنشاء PDF".`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cmd_quizpdf_cancel' }]] }
                }
            );
            return res.status(200).send('QuizPDF Mode Start');
        }

        // =========================================================
        // 0.7️⃣ أمر /addkey - بدء إضافة مفتاح Gemini API الخاص بالمستخدم
        //       ⚠️ [51.0] لا يوجد أي حد أقصى لعدد المفاتيح بعد الآن.
        // =========================================================
        if (msg && msg.text && msg.text.startsWith('/addkey')) {
            const chatId = msg.chat.id;

            await setAddKeyState(userId, { active: true });

            const instructions =
`🔑 <b>أضف مفتاح Gemini API الخاص بك (مجاني)</b>

سيستخدم البوت مفتاحك الخاص حصرياً في ميزة "إنشاء أسئلة بالذكاء الاصطناعي" من محتوى الملف (وهي ميزة <b>تتطلب ${MIN_USER_KEYS_FOR_GENERATE} مفاتيح خاصة بك على الأقل</b>). أما وضع "استخراج الأسئلة الموجودة" فيستخدم مفاتيح البوت العامة دائماً ولا يحتاج مفتاحك.

📈 كل مفتاح جديد تضيفه يمنحك تقريباً <b>${APPROX_ANALYSES_PER_KEY} تحليل ملف/نص/صورة إضافي يومياً</b> ضمن ميزة "إنشاء أسئلة بالذكاء الاصطناعي". ويمكنك إضافة أي عدد تريده من المفاتيح لزيادة هذا الرصيد أكثر.

<b>خطوات الحصول على المفتاح:</b>
1️⃣ افتح الرابط: https://aistudio.google.com/apikey
2️⃣ سجّل الدخول بحساب Google الخاص بك (أي حساب Gmail).
3️⃣ اضغط زر <b>"Create API key"</b> (إنشاء مفتاح API).
4️⃣ اختر <b>"Create API key in new project"</b> (أو مشروع Google Cloud موجود لديك).
5️⃣ انسخ المفتاح الذي سيظهر (يبدأ عادة بـ <code>AQ...</code>).
6️⃣ الصق المفتاح هنا في هذه المحادثة مباشرة كرسالة نصية.
7️⃣ كرر الخطوات لإضافة مفتاح ثانٍ على الأقل (${MIN_USER_KEYS_FOR_GENERATE} مفاتيح مطلوبة لميزة الإنشاء بالذكاء الاصطناعي).

⚠️ <b>تنبيهات مهمة:</b>
• المفتاح مجاني بالكامل ضمن الحد اليومي المجاني (Free Tier) من Google.
• لا تشارك هذا المفتاح مع أي شخص آخر أبداً — فهو يتيح استخدام حصتك في Google AI Studio.
• يمكنك حذفه أو إلغاءه في أي وقت من نفس صفحة aistudio.google.com/apikey، أو من هنا عبر /removekey.
• سنتحقق من صلاحية المفتاح مباشرة عن طريق تجربته فعلياً قبل حفظه.

━━━━━━━━━━━━━━━━━━

🔑 <b>Add your own Gemini API key (it's free)</b>

The bot will use your own key(s) exclusively for the "AI-generate questions" feature, which requires <b>at least ${MIN_USER_KEYS_FOR_GENERATE} of your own keys</b>. The "extract existing questions" mode always uses the bot's shared public keys and never needs your key.

📈 Each key you add gives you roughly <b>${APPROX_ANALYSES_PER_KEY} extra file/text/image analyses per day</b> for the AI-generate feature. You can add as many keys as you like to increase this further.

<b>Steps to get your key:</b>
1️⃣ Open: https://aistudio.google.com/apikey
2️⃣ Sign in with your Google account (any Gmail account works).
3️⃣ Click <b>"Create API key"</b>.
4️⃣ Choose <b>"Create API key in new project"</b> (or an existing Google Cloud project).
5️⃣ Copy the key that appears (it usually starts with <code>AIza...</code>).
6️⃣ Paste the key here in this chat as a plain text message.
7️⃣ Repeat to add at least a second key (${MIN_USER_KEYS_FOR_GENERATE} keys are required for the AI-generate feature).

⚠️ <b>Important notes:</b>
• The key is completely free within Google's daily free tier.
• Never share this key with anyone — it grants access to your own Google AI Studio quota.
• You can revoke it anytime from aistudio.google.com/apikey, or remove it here via /removekey.
• We'll validate the key by actually testing it live with Google before saving it.

📩 <b>الآن، الصق مفتاحك هنا / Now paste your key here:</b>`;

            await bot.sendMessage(chatId, instructions, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء / Cancel', callback_data: 'cmd_addkey_cancel' }]] }
            });
            return res.status(200).send('AddKey Mode Start');
        }

        // =========================================================
        // 0.8️⃣ أمر /mykeys - عرض مفاتيح المستخدم الحالية
        // =========================================================
        if (msg && msg.text && msg.text.startsWith('/mykeys')) {
            const chatId = msg.chat.id;
            const keys = await getUserApiKeysList(userId);

            if (keys.length === 0) {
                await bot.sendMessage(chatId,
                    `📭 لا تملك أي مفاتيح API مضافة حالياً.\nاستخدم /addkey لإضافة مفتاحك الخاص (مجاني). تحتاج ${MIN_USER_KEYS_FOR_GENERATE} على الأقل لاستخدام ميزة "إنشاء أسئلة بالذكاء الاصطناعي".\n\n` +
                    `📭 You have no API keys added yet.\nUse /addkey to add your own free key. You need at least ${MIN_USER_KEYS_FOR_GENERATE} for the AI-generate feature.`
                );
                return res.status(200).send('No Keys');
            }

            const list = keys.map((k, i) => {
                const addedDate = new Date(k.added_at).toLocaleDateString('ar-EG');
                return `${i + 1}. <code>${maskApiKey(k.api_key)}</code> — ${addedDate}`;
            }).join('\n');

            const genStatus = keys.length >= MIN_USER_KEYS_FOR_GENERATE
                ? `✅ مفعّل لديك ميزة "إنشاء أسئلة بالذكاء الاصطناعي" (${keys.length}/${MIN_USER_KEYS_FOR_GENERATE}).`
                : `⚠️ تحتاج ${MIN_USER_KEYS_FOR_GENERATE - keys.length} مفتاح إضافي على الأقل لتفعيل ميزة "إنشاء أسئلة بالذكاء الاصطناعي" (${keys.length}/${MIN_USER_KEYS_FOR_GENERATE}).`;

            await bot.sendMessage(chatId,
                `🔑 <b>مفاتيحك المضافة (${keys.length}):</b>\n\n${list}\n\n` +
                `${genStatus}\n\n` +
                `📈 كل مفتاح يمنحك ~${APPROX_ANALYSES_PER_KEY} تحليل إضافي يومياً لميزة الإنشاء بالذكاء الاصطناعي.\n\n` +
                `➕ /addkey لإضافة مفتاح جديد (بدون حد أقصى)\n🗑 /removekey لحذف مفتاح`,
                { parse_mode: 'HTML' }
            );
            return res.status(200).send('My Keys');
        }

        // =========================================================
        // 0.9️⃣ أمر /removekey - حذف أحد مفاتيح المستخدم
        // =========================================================
        if (msg && msg.text && msg.text.startsWith('/removekey')) {
            const chatId = msg.chat.id;
            const keys = await getUserApiKeysList(userId);

            if (keys.length === 0) {
                await bot.sendMessage(chatId, '📭 لا تملك أي مفاتيح لحذفها.\n📭 You have no keys to remove.');
                return res.status(200).send('No Keys');
            }

            const buttons = keys.map((k) => ([{ text: `🗑 ${maskApiKey(k.api_key)}`, callback_data: `cmd_removekey_${k.id}` }]));
            buttons.push([{ text: '❌ إلغاء / Cancel', callback_data: 'cmd_removekey_cancel' }]);

            await bot.sendMessage(chatId,
                '🗑 <b>اختر المفتاح الذي تريد حذفه:</b>\n🗑 <b>Select the key you want to remove:</b>',
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
            );
            return res.status(200).send('Remove Key Prompt');
        }

        // =========================================================
        // 1️⃣ استلام الملفات (PDF أو Word أو صورة مرسلة كملف)
        //     ⚠️ [52.0] لا يتم استدعاء GAS هنا مباشرة بعد الآن — يتم فقط تخزين
        //     بيانات الملف وعرض اختيار الوضع (استخراج / إنشاء بالذكاء الاصطناعي).
        // =========================================================
        if (msg && msg.document) {
            const chatId = msg.chat.id;
            const fileId = msg.document.file_id;
            const fileName = msg.document.file_name;
            const docMimeType = msg.document.mime_type || '';
            const userName = `${fromUser.first_name} ${fromUser.last_name || ''}`.trim();

            const isPdf = docMimeType === 'application/pdf';
            const isWordDoc = WORD_MIME_TYPES.indexOf(docMimeType) !== -1;
            const isImage = docMimeType.startsWith('image/');

            // ✨ الآن نقبل PDF أو Word (.docx/.doc) أو أي صورة مرسلة كملف
            if (!isPdf && !isWordDoc && !isImage) {
                await bot.sendMessage(chatId, '❌ <b>البوت يدعم ملفات PDF أو Word (docx) أو الصور فقط.</b>', {parse_mode: 'HTML'});
                return res.status(200).send('OK');
            }

            await checkAndSendAlert(chatId, fromUser);

            await clearPendingFile(userId);
            await setPendingFile(userId, {
                fileId, fileName, mimeType: docMimeType, sourceType: 'document', isImage,
                userName, userUsername: fromUser.username, step: 'choose_mode'
            });

            await bot.sendMessage(chatId,
                `📄 <b>كيف تريد التعامل مع هذا الملف؟</b>\n\n` +
                `📤 <b>استخراج الأسئلة الموجودة:</b> يسحب البوت الأسئلة الموجودة فعلياً في الملف مع إجاباتها المحددة (تظليل/علامة/جدول إجابات).\n\n` +
                `🤖 <b>إنشاء أسئلة بالذكاء الاصطناعي:</b> يقرأ البوت محتوى الملف وينشئ أسئلة اختيار من متعدد جديدة بنفسه ويحدد إجاباتها من نفس المحتوى (يتطلب ${MIN_USER_KEYS_FOR_GENERATE} مفاتيح Gemini API خاصة بك على الأقل).`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [
                        [{ text: '📤 استخراج أسئلة موجودة', callback_data: 'cmd_filemode_extract' }],
                        [{ text: '🤖 إنشاء أسئلة بالذكاء الاصطناعي', callback_data: 'cmd_filemode_generate' }],
                        [{ text: '❌ إلغاء', callback_data: 'cmd_filecancel' }]
                    ] }
                }
            );
        }

        // =========================================================
        // 1.5️⃣ استلام الصور المضغوطة (Telegram photo, بدون document)
        //     ⚠️ [52.0] نفس منطق الـ document أعلاه — نعرض اختيار الوضع أولاً.
        // =========================================================
        else if (msg && msg.photo && msg.photo.length > 0) {
            const chatId = msg.chat.id;
            // آخر عنصر في المصفوفة = أعلى دقة متاحة
            const bestPhoto = msg.photo[msg.photo.length - 1];
            const fileId = bestPhoto.file_id;
            const fileName = `photo_${Date.now()}.jpg`;
            const mimeType = 'image/jpeg';
            const userName = `${fromUser.first_name} ${fromUser.last_name || ''}`.trim();

            await checkAndSendAlert(chatId, fromUser);

            await clearPendingFile(userId);
            await setPendingFile(userId, {
                fileId, fileName, mimeType, sourceType: 'photo', isImage: true,
                userName, userUsername: fromUser.username, step: 'choose_mode'
            });

            await bot.sendMessage(chatId,
                `🖼️ <b>كيف تريد التعامل مع هذه الصورة؟</b>\n\n` +
                `📤 <b>استخراج الأسئلة الموجودة:</b> يسحب البوت الأسئلة الموجودة فعلياً في الصورة مع إجاباتها المحددة.\n\n` +
                `🤖 <b>إنشاء أسئلة بالذكاء الاصطناعي:</b> يقرأ البوت محتوى الصورة وينشئ أسئلة اختيار من متعدد جديدة بنفسه ويحدد إجاباتها (يتطلب ${MIN_USER_KEYS_FOR_GENERATE} مفاتيح Gemini API خاصة بك على الأقل).`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [
                        [{ text: '📤 استخراج أسئلة موجودة', callback_data: 'cmd_filemode_extract' }],
                        [{ text: '🤖 إنشاء أسئلة بالذكاء الاصطناعي', callback_data: 'cmd_filemode_generate' }],
                        [{ text: '❌ إلغاء', callback_data: 'cmd_filecancel' }]
                    ] }
                }
            );
        }

        // =========================================================
        // 2️⃣ التعامل مع الكويزات (Polls)
        // =========================================================
        else if (msg && msg.poll) {
            const poll = msg.poll;
            const chatId = msg.chat.id;

            if (poll.type !== 'quiz') {
                return res.status(200).send('OK');
            }

            const { quizData, hasAnswer } = quizPollToData(poll);

            // ✨ الكويز خام (بدون حل) — مرفوض دائماً بغض النظر عن وجود جلسة /quizpdf نشطة أو لا.
            // بدل السماح للمستخدم يحدد الإجابة يدوياً (السلوك القديم)، البوت يطلب من المستخدم
            // إعادة حل الكويز وإرساله مرة أخرى مع تفعيل خاصية "إخفاء اسم المرسل" عند التوجيه
            // (Forward)، لأن هذا يجعل تيليجرام يرسل الكويز كنسخة جديدة يملكها البوت فعلياً،
            // فتظهر correct_option_id تلقائياً ويقدر البوت يتعرف على الإجابة الصحيحة بنفسه.
            if (!hasAnswer) {
                await sendUnsolvedQuizNotice(chatId, msg.message_id);
                return res.status(200).send('OK');
            }

            // ✨ لو فيه جلسة /quizpdf نشطة، الكويز المحلول بينضاف لمخزن الجلسة بدل عرضه
            // مباشرة — وهيتحول لملف PDF مراجعة لما المستخدم يضغط "📄 إنشاء PDF".
            const qpdfBuffer = await getQuizPdfBuffer(userId);
            if (qpdfBuffer && qpdfBuffer.active) {
                if (qpdfBuffer.quizzes.length >= MAX_QUIZPDF_BUFFER) {
                    await bot.sendMessage(chatId,
                        `⚠️ وصلت للحد الأقصى لعدد الأسئلة في الجلسة (${MAX_QUIZPDF_BUFFER}). اضغط "📄 إنشاء PDF" الآن لإنشاء الملف مما تم تجميعه حتى الآن.`,
                        { reply_markup: { inline_keyboard: [
                            [{ text: '📄 إنشاء PDF', callback_data: 'cmd_quizpdf_done' }],
                            [{ text: '❌ إلغاء', callback_data: 'cmd_quizpdf_cancel' }]
                        ] } }
                    );
                    return res.status(200).send('QuizPDF Buffer Full');
                }

                qpdfBuffer.quizzes.push(quizData);

                // إخفاء أزرار البرومبت السابق لتفادي تكرار الأزرار على الشاشة
                if (qpdfBuffer.promptMsgId) {
                    try {
                        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: qpdfBuffer.promptMsgId });
                    } catch (e) { /* تجاهل لو الرسالة اتمسحت أو مالهاش أزرار */ }
                }

                const promptMsg = await bot.sendMessage(chatId,
                    `✅ تم إضافة السؤال (الإجمالي: <b>${qpdfBuffer.quizzes.length}</b>).\n` +
                    `أرسل المزيد أو اضغط "📄 إنشاء PDF" للإنتهاء.`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [
                            [{ text: '📄 إنشاء PDF', callback_data: 'cmd_quizpdf_done' }],
                            [{ text: '❌ إلغاء', callback_data: 'cmd_quizpdf_cancel' }]
                        ] }
                    }
                );

                qpdfBuffer.promptMsgId = promptMsg.message_id;
                await setQuizPdfBuffer(userId, qpdfBuffer);
                return res.status(200).send('QuizPDF Item Added');
            }

            // مفيش جلسة /quizpdf نشطة — السلوك العادي: عرض الكويز المحلول مباشرة
            const formattedText = formatQuizText(quizData);
            await bot.sendMessage(chatId, formattedText, {
                reply_to_message_id: msg.message_id,
                parse_mode: 'HTML'
            });
        }

        // =========================================================
        // 2.5️⃣ استقبال أجزاء النص (وضع تحويل النص إلى أسئلة)، مفتاح API،
        //       أو خطوات "الملف المعلّق" (عدد الأسئلة المخصص / التعليمات الإضافية)
        //       ⚠️ [51.0] لا يوجد فحص شكلي (regex) على مفتاح API — يُمرَّر
        //       أي نص يلصقه المستخدم مباشرة لـ validateGeminiApiKey().
        // =========================================================
        else if (msg && msg.text && !msg.text.startsWith('/')) {
            const chatId = msg.chat.id;

            // ✨ أولوية لوضع إضافة مفتاح API الشخصي، لو نشط — يُفحص قبل أي
            // وضع آخر لأن المستخدم غالباً سيلصق المفتاح كرسالة نصية واحدة فقط.
            const addKeyState = await getAddKeyState(userId);
            if (addKeyState && addKeyState.active) {
                const candidateKey = msg.text.trim();
                await clearAddKeyState(userId);

                const waitMsg = await bot.sendMessage(chatId, '⏳ جاري التحقق من المفتاح... / Validating your key...');

                const existingKeys = await getUserApiKeysList(userId);

                if (existingKeys.some(k => k.api_key === candidateKey)) {
                    await bot.editMessageText(
                        '⚠️ هذا المفتاح مضاف بالفعل ضمن مفاتيحك.\n⚠️ This key is already in your list.',
                        { chat_id: chatId, message_id: waitMsg.message_id }
                    );
                    return res.status(200).send('Duplicate Key');
                }

                // ⚠️ [51.0] لا يوجد حد أقصى لعدد المفاتيح، ولا فحص شكل مسبق — ننتقل
                // مباشرة لاختبار المفتاح فعلياً عبر Google API.
                const validation = await validateGeminiApiKey(candidateKey);

                if (!validation.valid) {
                    await bot.editMessageText(
                        `❌ <b>المفتاح غير صالح.</b>\nالسبب: <code>${escapeHtml(validation.reason || 'unknown')}</code>\n\n` +
                        `تأكد من نسخ المفتاح كاملاً من aistudio.google.com/apikey بدون مسافات إضافية، ثم أعد المحاولة عبر /addkey.\n\n` +
                        `❌ <b>Invalid key.</b>\nReason: <code>${escapeHtml(validation.reason || 'unknown')}</code>\n\n` +
                        `Make sure you copied the full key from aistudio.google.com/apikey with no extra spaces, then try /addkey again.`,
                        { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'HTML' }
                    );
                    return res.status(200).send('Invalid Key');
                }

                const saved = await addUserApiKeyToDb(userId, candidateKey);
                if (!saved) {
                    await bot.editMessageText(
                        '❌ حدث خطأ أثناء حفظ المفتاح. حاول لاحقاً.\n❌ Error saving the key. Please try again later.',
                        { chat_id: chatId, message_id: waitMsg.message_id }
                    );
                    return res.status(200).send('Save Error');
                }

                const newCount = existingKeys.length + 1;
                const genNote = newCount >= MIN_USER_KEYS_FOR_GENERATE
                    ? `\n\n🤖 ميزة "إنشاء أسئلة بالذكاء الاصطناعي" أصبحت متاحة لك الآن (${newCount}/${MIN_USER_KEYS_FOR_GENERATE}).`
                    : `\n\n⚠️ تحتاج ${MIN_USER_KEYS_FOR_GENERATE - newCount} مفتاح إضافي على الأقل لتفعيل ميزة "إنشاء أسئلة بالذكاء الاصطناعي" (${newCount}/${MIN_USER_KEYS_FOR_GENERATE}).`;

                await bot.editMessageText(
                    `✅ <b>تم إضافة مفتاحك بنجاح!</b> (<code>${maskApiKey(candidateKey)}</code>)\n` +
                    `لديك الآن ${newCount} مفاتيح، بما يقارب ${newCount * APPROX_ANALYSES_PER_KEY} تحليل إضافي يومياً لميزة الإنشاء بالذكاء الاصطناعي.${genNote}\n\n` +
                    `✅ <b>Key added successfully!</b> (<code>${maskApiKey(candidateKey)}</code>)\n` +
                    `You now have ${newCount} keys, roughly ${newCount * APPROX_ANALYSES_PER_KEY} extra AI-generate analyses/day.`,
                    { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'HTML' }
                );
                return res.status(200).send('Key Added');
            }

            // ✨ [52.0] خطوات "الملف المعلّق" التي تنتظر رسالة نصية من المستخدم:
            // إدخال عدد أسئلة مخصص، أو تعليمات إضافية لوضع "إنشاء بالذكاء الاصطناعي".
            const pendingFileState = await getPendingFile(userId);

            if (pendingFileState && pendingFileState.step === 'ask_count_custom') {
                const raw = msg.text.trim();
                const n = parseInt(raw, 10);

                if (isNaN(n) || n < 1) {
                    await bot.sendMessage(chatId, `⚠️ من فضلك أرسل رقم صحيح بين ${MIN_GENERATE_COUNT} و ${MAX_GENERATE_COUNT}.`);
                    return res.status(200).send('Invalid Count');
                }

                pendingFileState.questionCount = Math.max(MIN_GENERATE_COUNT, Math.min(MAX_GENERATE_COUNT, n));
                pendingFileState.step = 'ask_prompt';
                await setPendingFile(userId, pendingFileState);

                await bot.sendMessage(chatId,
                    `✏️ <b>عدد الأسئلة: ${pendingFileState.questionCount}</b>\n\n` +
                    `اكتب الآن أي تعليمات إضافية تريدها للذكاء الاصطناعي (نوع الأسئلة، الصعوبة، اللغة، التركيز على موضوع معين...)، ` +
                    `أو أرسل كلمة "تخطي" للمتابعة بدون تعليمات إضافية.`,
                    { parse_mode: 'HTML' }
                );
                return res.status(200).send('Count Received');
            }

            if (pendingFileState && pendingFileState.step === 'ask_prompt') {
                const raw = msg.text.trim();
                const customPrompt = (raw.toLowerCase() === 'skip' || raw === 'تخطي') ? '' : raw;

                pendingFileState.customPrompt = customPrompt;
                await clearPendingFile(userId);

                const waitMsg = await bot.sendMessage(chatId, '⏳ <b>جاري البدء...</b>', { parse_mode: 'HTML' });
                await startFileAnalysis(userId, fromUser, chatId, waitMsg.message_id, pendingFileState);
                return res.status(200).send('Generate Prompt Received');
            }

            const buffer = await getTextBuffer(userId);

            if (buffer && buffer.active) {
                const currentCombined = smartJoinParts(buffer.parts);

                // 📏 حماية من تضخم النص أكثر من اللازم
                if (currentCombined.length >= MAX_TEXT_BUFFER_LENGTH) {
                    await bot.sendMessage(chatId,
                        `⚠️ وصلت للحد الأقصى للطول (${MAX_TEXT_BUFFER_LENGTH} حرف). اضغط "تم" الآن لاستخراج الأسئلة مما تم إرساله حتى الآن.`,
                        { reply_markup: { inline_keyboard: [
                            [{ text: '✅ تم - استخرج الأسئلة', callback_data: 'cmd_text_done' }],
                            [{ text: '❌ إلغاء', callback_data: 'cmd_text_cancel' }]
                        ] } }
                    );
                    return res.status(200).send('Text Buffer Full');
                }

                buffer.parts.push(msg.text);
                const combinedLength = smartJoinParts(buffer.parts).length;

                // إخفاء أزرار البرومبت السابق لتفادي تكرار الأزرار على الشاشة
                if (buffer.promptMsgId) {
                    try {
                        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: buffer.promptMsgId });
                    } catch (e) { /* تجاهل لو الرسالة اتمسحت أو مالهاش أزرار */ }
                }

                const promptMsg = await bot.sendMessage(chatId,
                    `✏️ تم استلام جزء (${msg.text.length} حرف) — الإجمالي: <b>${combinedLength}</b> حرف.\n` +
                    `أرسل المزيد أو اضغط "تم" للاستخراج.`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ تم - استخرج الأسئلة', callback_data: 'cmd_text_done' }],
                                [{ text: '❌ إلغاء', callback_data: 'cmd_text_cancel' }]
                            ]
                        }
                    }
                );

                buffer.promptMsgId = promptMsg.message_id;
                await setTextBuffer(userId, buffer);
                return res.status(200).send('Text Part Received');
            }
            // لو مفيش سيشن نشطة، لا تفعل شيء (سلوك افتراضي كما كان)
        }

        // =========================================================
        // 3️⃣ الأزرار (Callbacks)
        // =========================================================
        else if (cb) {
            const chatId = cb.message.chat.id;
            const messageId = cb.message.message_id;
            const data = cb.data;

            // إلغاء وضع تحويل النص إلى أسئلة
            if (data === 'cmd_text_cancel') {
                await clearTextBuffer(userId);
                await bot.answerCallbackQuery(cb.id, { text: '❌ تم الإلغاء.' });
                await bot.editMessageText('❌ تم إلغاء عملية تحويل النص.', { chat_id: chatId, message_id: messageId });
            }

            // إنهاء استلام النص وبدء الاستخراج
            else if (data === 'cmd_text_done') {
                const buffer = await getTextBuffer(userId);

                if (!buffer || !buffer.active || !buffer.parts || buffer.parts.length === 0) {
                    await bot.answerCallbackQuery(cb.id, { text: '⚠️ لا يوجد نص محفوظ.', show_alert: true });
                    return res.status(200).send('OK');
                }

                const fullText = smartJoinParts(buffer.parts);
                await clearTextBuffer(userId);

                await bot.answerCallbackQuery(cb.id, { text: '🚀 جاري التحليل...' });
                await bot.editMessageText(`⏳ <b>جاري تحليل النص (${fullText.length} حرف) بالذكاء الاصطناعي...</b>`, {
                    chat_id: chatId, message_id: messageId, parse_mode: 'HTML'
                });

                const userName = `${fromUser.first_name} ${fromUser.last_name || ''}`.trim();
                const logId = await logUsage(userId, null, 'Text Input', 0, null, 'processing', 'text_extraction');

                await sendToGasAndForget({
                    action: 'analyze_text_async',
                    userId: userId,
                    chatId: chatId,
                    userName: userName,
                    userUsername: fromUser.username,
                    text: fullText,
                    logId: logId
                });
            }

            // إلغاء جلسة تجميع /quizpdf
            else if (data === 'cmd_quizpdf_cancel') {
                await clearQuizPdfBuffer(userId);
                await bot.answerCallbackQuery(cb.id, { text: '❌ تم الإلغاء.' });
                await bot.editMessageText('❌ تم إلغاء عملية تجميع الكويزات.', { chat_id: chatId, message_id: messageId });
            }

            // إنهاء التجميع وطلب إنشاء ملف الـ PDF من GAS
            else if (data === 'cmd_quizpdf_done') {
                const qpdfBuffer = await getQuizPdfBuffer(userId);

                if (!qpdfBuffer || !qpdfBuffer.active || !qpdfBuffer.quizzes || qpdfBuffer.quizzes.length === 0) {
                    await bot.answerCallbackQuery(cb.id, { text: '⚠️ لا توجد أسئلة محفوظة.', show_alert: true });
                    return res.status(200).send('OK');
                }

                const collectedQuizzes = qpdfBuffer.quizzes;
                await clearQuizPdfBuffer(userId);

                await bot.answerCallbackQuery(cb.id, { text: '🚀 جاري إنشاء الملف...' });
                await bot.editMessageText(`⏳ <b>جاري إنشاء ملف PDF مراجعة يحتوي على ${collectedQuizzes.length} سؤال...</b>`, {
                    chat_id: chatId, message_id: messageId, parse_mode: 'HTML'
                });

                const userName = `${fromUser.first_name} ${fromUser.last_name || ''}`.trim();

                await sendToGasAndForget({
                    action: 'generate_quiz_pdf',
                    userId: userId,
                    chatId: chatId,
                    userName: userName,
                    userUsername: fromUser.username,
                    quizzes: collectedQuizzes
                });
            }

            // ✨ إلغاء وضع إضافة مفتاح API
            else if (data === 'cmd_addkey_cancel') {
                await clearAddKeyState(userId);
                await bot.answerCallbackQuery(cb.id, { text: '❌ تم الإلغاء.' });
                await bot.editMessageText('❌ تم إلغاء إضافة المفتاح.\n❌ Cancelled adding the key.', { chat_id: chatId, message_id: messageId });
            }

            // ✨ إلغاء عملية حذف المفتاح
            else if (data === 'cmd_removekey_cancel') {
                await bot.answerCallbackQuery(cb.id, { text: '❌ تم الإلغاء.' });
                await bot.editMessageText('❌ تم الإلغاء.\n❌ Cancelled.', { chat_id: chatId, message_id: messageId });
            }

            // ✨ حذف مفتاح محدد (مع التحقق من الملكية عبر user_id في الاستعلام)
            else if (data.startsWith('cmd_removekey_')) {
                const keyId = data.replace('cmd_removekey_', '');
                const removed = await removeUserApiKeyFromDb(keyId, userId);
                if (removed) {
                    await bot.answerCallbackQuery(cb.id, { text: '✅ تم الحذف.' });
                    await bot.editMessageText('✅ تم حذف المفتاح بنجاح.\n✅ Key removed successfully.', { chat_id: chatId, message_id: messageId });
                } else {
                    await bot.answerCallbackQuery(cb.id, { text: '❌ فشل الحذف.', show_alert: true });
                }
            }

            // =========================================================
            // ✨ [52.0] أزرار اختيار وضع الملف المعلّق (extract / generate)
            // =========================================================

            // 📤 اختيار وضع "استخراج أسئلة موجودة" -> نسأل عن العناوين
            else if (data === 'cmd_filemode_extract') {
                const pending = await getPendingFile(userId);
                if (!pending || !pending.fileId) {
                    await bot.answerCallbackQuery(cb.id, { text: '⚠️ انتهت صلاحية هذا الطلب، أعد إرسال الملف.', show_alert: true });
                    return res.status(200).send('OK');
                }

                pending.mode = 'extract';
                pending.step = 'choose_titles';
                await setPendingFile(userId, pending);

                await bot.answerCallbackQuery(cb.id);
                await bot.editMessageText(
                    '📌 هل تريد أن يستخرج البوت أيضاً عناوين الأقسام/الفصول (Section Titles) الموجودة في الملف؟',
                    {
                        chat_id: chatId, message_id: messageId,
                        reply_markup: { inline_keyboard: [
                            [{ text: '✅ نعم، استخرج العناوين', callback_data: 'cmd_titles_yes' }],
                            [{ text: '🚫 لا، الأسئلة فقط', callback_data: 'cmd_titles_no' }],
                            [{ text: '❌ إلغاء', callback_data: 'cmd_filecancel' }]
                        ] }
                    }
                );
            }

            // 🤖 اختيار وضع "إنشاء أسئلة بالذكاء الاصطناعي" -> نتحقق من وجود مفاتيح خاصة كافية أولاً
            else if (data === 'cmd_filemode_generate') {
                const pending = await getPendingFile(userId);
                if (!pending || !pending.fileId) {
                    await bot.answerCallbackQuery(cb.id, { text: '⚠️ انتهت صلاحية هذا الطلب، أعد إرسال الملف.', show_alert: true });
                    return res.status(200).send('OK');
                }

                // ✨ [53.0] يتطلب الآن MIN_USER_KEYS_FOR_GENERATE مفتاح على الأقل (وليس
                // مفتاحاً واحداً فقط كما كان سابقاً).
                const userKeys = await getUserApiKeysList(userId);
                if (userKeys.length < MIN_USER_KEYS_FOR_GENERATE) {
                    await clearPendingFile(userId);
                    await bot.answerCallbackQuery(cb.id, { text: `🔑 تحتاج ${MIN_USER_KEYS_FOR_GENERATE} مفاتيح Gemini على الأقل.`, show_alert: true });
                    await bot.editMessageText(
                        `🔑 <b>ميزة "إنشاء أسئلة بالذكاء الاصطناعي" تتطلب إضافة ${MIN_USER_KEYS_FOR_GENERATE} مفاتيح Gemini API على الأقل الخاصة بك (مجانية).</b>\n\n` +
                        `لديك حالياً <code>${userKeys.length}</code> من ${MIN_USER_KEYS_FOR_GENERATE} مفاتيح مطلوبة.\n` +
                        `استخدم الأمر /addkey لإضافة مفتاح إضافي، ثم أعد إرسال الملف مرة أخرى.`,
                        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
                    );
                    return res.status(200).send('OK');
                }

                pending.mode = 'generate';
                pending.step = 'ask_count';
                await setPendingFile(userId, pending);

                await bot.answerCallbackQuery(cb.id);
                await bot.editMessageText(
                    '🔢 <b>كم عدد الأسئلة التي تريد إنشاءها؟</b>',
                    {
                        chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [
                            [{ text: '5', callback_data: 'cmd_qcount_5' }, { text: '10', callback_data: 'cmd_qcount_10' }, { text: '15', callback_data: 'cmd_qcount_15' }],
                            [{ text: '20', callback_data: 'cmd_qcount_20' }, { text: '30', callback_data: 'cmd_qcount_30' }, { text: '🔢 عدد مخصص', callback_data: 'cmd_qcount_custom' }],
                            [{ text: '❌ إلغاء', callback_data: 'cmd_filecancel' }]
                        ] }
                    }
                );
            }

            // ✅/🚫 تحديد إن كان استخراج العناوين مطلوباً -> نبدأ التحليل فوراً
            else if (data === 'cmd_titles_yes' || data === 'cmd_titles_no') {
                const pending = await getPendingFile(userId);
                if (!pending || !pending.fileId) {
                    await bot.answerCallbackQuery(cb.id, { text: '⚠️ انتهت صلاحية هذا الطلب، أعد إرسال الملف.', show_alert: true });
                    return res.status(200).send('OK');
                }

                pending.extractTitles = (data === 'cmd_titles_yes');
                await clearPendingFile(userId);

                await bot.answerCallbackQuery(cb.id, { text: '🚀 جاري البدء...' });
                await startFileAnalysis(userId, fromUser, chatId, messageId, pending);
            }

            // 🔢 اختيار عدد أسئلة جاهز (زر) -> ننتقل مباشرة لطلب التعليمات الإضافية
            else if (/^cmd_qcount_\d+$/.test(data)) {
                const pending = await getPendingFile(userId);
                if (!pending || !pending.fileId) {
                    await bot.answerCallbackQuery(cb.id, { text: '⚠️ انتهت صلاحية هذا الطلب، أعد إرسال الملف.', show_alert: true });
                    return res.status(200).send('OK');
                }

                const count = parseInt(data.replace('cmd_qcount_', ''), 10);
                pending.questionCount = Math.max(MIN_GENERATE_COUNT, Math.min(MAX_GENERATE_COUNT, count));
                pending.step = 'ask_prompt';
                await setPendingFile(userId, pending);

                await bot.answerCallbackQuery(cb.id);
                await bot.editMessageText(
                    `✏️ <b>عدد الأسئلة: ${pending.questionCount}</b>\n\n` +
                    `اكتب الآن أي تعليمات إضافية تريدها للذكاء الاصطناعي (نوع الأسئلة، الصعوبة، اللغة، التركيز على موضوع معين...)، ` +
                    `أو أرسل كلمة "تخطي" للمتابعة بدون تعليمات إضافية.`,
                    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
                );
            }

            // 🔢 طلب عدد مخصص -> ننتظر رسالة نصية برقم من المستخدم
            else if (data === 'cmd_qcount_custom') {
                const pending = await getPendingFile(userId);
                if (!pending || !pending.fileId) {
                    await bot.answerCallbackQuery(cb.id, { text: '⚠️ انتهت صلاحية هذا الطلب، أعد إرسال الملف.', show_alert: true });
                    return res.status(200).send('OK');
                }

                pending.step = 'ask_count_custom';
                await setPendingFile(userId, pending);

                await bot.answerCallbackQuery(cb.id);
                await bot.editMessageText(
                    `🔢 اكتب عدد الأسئلة المطلوب (رقم بين ${MIN_GENERATE_COUNT} و ${MAX_GENERATE_COUNT}):`,
                    { chat_id: chatId, message_id: messageId }
                );
            }

            // ❌ إلغاء معالجة الملف المعلّق في أي خطوة
            else if (data === 'cmd_filecancel') {
                await clearPendingFile(userId);
                await bot.answerCallbackQuery(cb.id, { text: '❌ تم الإلغاء.' });
                await bot.editMessageText('❌ تم إلغاء معالجة الملف.', { chat_id: chatId, message_id: messageId });
            }

            // --- أزرار إرسال GAS ---
            else if (data.startsWith('cmd_send')) {
                const parts = data.split('|');
                const count = parts[1];
                const model = parts[2];
                const uniqueKey = parts[3];
                const targetRaw = parts[4];

                // ✅ التعرف على وضع النص المشوش (Spoiler)
                const closePolls = targetRaw.includes('close');
                const spoilerMode = targetRaw.includes('spoiler');

                if (targetRaw.includes('here')) {
                    let modeText = "";
                    if (closePolls) modeText = " (وحلها)";
                    if (spoilerMode) modeText = " (نص مشوش)";

                    await bot.answerCallbackQuery(cb.id, { text: `🚀 جاري البدء${modeText}...` });
                    await bot.sendMessage(chatId, `⚡ <b>جاري إرسال ${count} سؤال...</b>`, {parse_mode: 'HTML'});

                    await logUsage(userId, null, 'Quiz', count, model, 'success', 'quiz_send');

                    // تمرير spoilerMode إلى GAS
                    await sendToGasAndForget({
                        action: 'execute_send',
                        userId: userId,
                        targetChatId: chatId,
                        chatType: 'private',
                        sessionKey: uniqueKey,
                        closePolls: closePolls,
                        spoilerMode: spoilerMode
                    });
                }
            }

            // ✨ تأكيد إرسال البرودكاست
            else if (data === 'cmd_broadcast_confirm') {
                if (userId !== ADMIN_CHAT_ID) { await bot.answerCallbackQuery(cb.id); return res.status(200).send('OK'); }

                const pending = await getBotConfig(`broadcast_pending_${userId}`);
                if (!pending || !pending.text) {
                    await bot.answerCallbackQuery(cb.id, { text: '⚠️ لا توجد رسالة برودكاست معلقة (ربما انتهت صلاحيتها).', show_alert: true });
                    return res.status(200).send('OK');
                }

                await deleteBotConfig(`broadcast_pending_${userId}`);
                await bot.answerCallbackQuery(cb.id, { text: '🚀 جاري بدء الإرسال...' });
                await bot.editMessageText(
                    '🚀 <b>تم بدء إرسال البرودكاست لكل المستخدمين...</b>\nسيصلك تقرير بالنتيجة عند الانتهاء.',
                    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
                );

                await sendToGasAndForget({
                    action: 'broadcast_async',
                    adminChatId: chatId,
                    text: pending.text
                });
            }

            // ✨ إلغاء البرودكاست
            else if (data === 'cmd_broadcast_cancel') {
                if (userId !== ADMIN_CHAT_ID) { await bot.answerCallbackQuery(cb.id); return res.status(200).send('OK'); }

                await deleteBotConfig(`broadcast_pending_${userId}`);
                await bot.answerCallbackQuery(cb.id, { text: '❌ تم الإلغاء.' });
                await bot.editMessageText('❌ تم إلغاء عملية البرودكاست.', { chat_id: chatId, message_id: messageId });
            }
        }

    } catch (e) { console.error("💥 General Error:", e.message); }
    res.status(200).send('OK');
};
