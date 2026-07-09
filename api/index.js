// =========================================================
// 🎮 Vercel Controller - Version 45.0 (Text-to-Quiz Added)
// Features: Detailed Admin Help | HTML Escaping | Spoiler Mode | Text-to-Quiz Extraction
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
if (!global.userState) global.userState = {};
if (global.isMaintenanceMode === undefined) global.isMaintenanceMode = false;

// حد أقصى تقريبي لطول النص المجمّع قبل رفض استلام المزيد (يطابق حد GAS)
const MAX_TEXT_BUFFER_LENGTH = 30000;

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

async function logUsage(userId, fileId, fileName, count, model, status, method, errorReason = null) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/processing_logs`, {
            user_id: userId,
            file_id: fileId || null,
            file_name: fileName || 'unknown',
            status: status,
            method: method || 'vision',
            model_used: model || 'gemini-2.5-flash',
            questions_count: parseInt(count) || 0,
            error_reason: errorReason,
            created_at: new Date().toISOString()
        }, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' }
        });
    } catch (e) { console.error("❌ Log Error:", e.message); }
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

                                `🔧 <b>وضع الصيانة:</b>\n` +
                                `• <code>/repairon</code> : لتفعيل الصيانة.\n` +
                                `• <code>/repairoff</code> : لإيقاف الصيانة.`;

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

            if (text === '/repairon') { global.isMaintenanceMode = true; await bot.sendMessage(ADMIN_CHAT_ID, '🛠️ ON'); return res.status(200).send('ON'); }
            if (text === '/repairoff') { global.isMaintenanceMode = false; await bot.sendMessage(ADMIN_CHAT_ID, '✅ OFF'); return res.status(200).send('OFF'); }
        }

        // 🚧 التحقق من الصيانة
        if (global.isMaintenanceMode && userId !== ADMIN_CHAT_ID) {
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
                `📚 <b>أرسل لي ملف PDF وسأقوم بتحليله واستخراج الأسئلة منه.</b>\n\n` +
                `📝 أو استخدم الأمر /text لتحويل نص (تكتبه أو تلصقه) إلى أسئلة مباشرة.`;
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
        // 1️⃣ استلام الملفات (PDF)
        // =========================================================
        if (msg && msg.document) {
            const chatId = msg.chat.id;
            const fileId = msg.document.file_id;
            const fileName = msg.document.file_name;
            const userName = `${fromUser.first_name} ${fromUser.last_name || ''}`.trim();

            if (msg.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '❌ <b>ملفات PDF فقط.</b>', {parse_mode: 'HTML'}); return res.status(200).send('OK');
            }

            await checkAndSendAlert(chatId, fromUser);
            await logUsage(userId, fileId, fileName, 0, null, 'processing', 'url_handover');
            const waitMsg = await bot.sendMessage(chatId, '⏳ <b>جاري تحضير الملف...</b>', {parse_mode: 'HTML'});

            try {
                const fileLink = await bot.getFileLink(fileId);
                const processingMsg = `🤖 <b>يتم تحليل الملف واستخراج الأسئلة بالذكاء الاصطناعي...</b>\n\n` +
                                      `⏳ الرجاء الانتظار، قد تستغرق العملية وقتاً حسب حجم الملف.\n` +
                                      `⚠️ <b>تنبيه:</b> إذا استمرت معالجة الملف أكثر من 6 دقائق، فسيتم إيقاف المعالجة إجبارياً ويجب تقسيم الملف المرسل.`;
                await bot.editMessageText(processingMsg, { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'HTML' });

                await sendToGasAndForget({
                    action: 'analyze_async', fileUrl: fileLink, chatId: chatId, messageId: waitMsg.message_id,
                    userId: userId, userName: userName, userUsername: fromUser.username, fileId: fileId, fileName: fileName
                });
            } catch (err) {
                console.error("❌ Error:", err.message);
                await logUsage(userId, fileId, fileName, 0, null, 'failed', 'url_handover', err.message);
                await bot.editMessageText('❌ حدث خطأ.', { chat_id: chatId, message_id: waitMsg.message_id });
            }
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

            const quizData = {
                question: poll.question,
                options: poll.options.map(opt => opt.text),
                correctOptionId: poll.correct_option_id,
                explanation: poll.explanation || null
            };

            // الحالة A: الكويز يحتوي على حل
            if (quizData.correctOptionId !== null && quizData.correctOptionId >= 0) {
                const formattedText = formatQuizText(quizData);
                await bot.sendMessage(chatId, formattedText, {
                    reply_to_message_id: msg.message_id,
                    parse_mode: 'HTML'
                });
            }
            // الحالة B: الكويز خام (بدون حل)
            else {
                if (!global.userState[userId]) global.userState[userId] = {};
                if (!global.userState[userId].pending_polls) global.userState[userId].pending_polls = {};

                const previewText = formatQuizText({ ...quizData, correctOptionId: null });
                const promptText = `${previewText}\n👇 *يرجى تحديد الإجابة الصحيحة يدوياً:*`;

                const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
                const keyboardButtons = quizData.options.map((option, index) => ({
                    text: optionLetters[index] || (index + 1),
                    callback_data: `poll_answer_${index}`
                }));

                const rows = [];
                for (let i = 0; i < keyboardButtons.length; i += 5) rows.push(keyboardButtons.slice(i, i + 5));

                const interactiveMessage = await bot.sendMessage(chatId, promptText, {
                    parse_mode: 'HTML',
                    reply_to_message_id: msg.message_id,
                    reply_markup: { inline_keyboard: rows }
                });

                global.userState[userId].pending_polls[interactiveMessage.message_id] = quizData;
            }
        }

        // =========================================================
        // 2.5️⃣ استقبال أجزاء النص (وضع تحويل النص إلى أسئلة)
        // =========================================================
        else if (msg && msg.text && !msg.text.startsWith('/')) {
            const chatId = msg.chat.id;
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

            // أزرار الكويز اليدوي
            if (data.startsWith('poll_answer_')) {
                if (!global.userState[userId] || !global.userState[userId].pending_polls || !global.userState[userId].pending_polls[messageId]) {
                    await bot.answerCallbackQuery(cb.id, { text: '⚠️ انتهت الصلاحية.', show_alert: true });
                    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
                    return res.status(200).send('OK');
                }

                const poll_data = global.userState[userId].pending_polls[messageId];
                poll_data.correctOptionId = parseInt(data.split('_')[2], 10);

                const formattedText = formatQuizText(poll_data);

                await bot.editMessageText(formattedText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML'
                });

                delete global.userState[userId].pending_polls[messageId];
                await bot.answerCallbackQuery(cb.id, { text: '✅ تم الحفظ!' });
            }

            // إلغاء وضع تحويل النص إلى أسئلة
            else if (data === 'cmd_text_cancel') {
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
                await logUsage(userId, null, 'Text Input', 0, null, 'processing', 'text_extraction');

                await sendToGasAndForget({
                    action: 'analyze_text_async',
                    userId: userId,
                    chatId: chatId,
                    userName: userName,
                    userUsername: fromUser.username,
                    text: fullText
                });
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
        }

    } catch (e) { console.error("💥 General Error:", e.message); }
    res.status(200).send('OK');
};
