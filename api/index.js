// =========================================================
// 🎮 Vercel Controller - Version 44.3 (Clean Layout + Spoiler)
// Features: Spaced Options | Separate Spoiler Answer Line
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

// =========================================================
// 🛠️ دوال مساعدة (Helpers)
// =========================================================

// ✨ دالة تنسيق الكويز (تم التعديل: مسافات وسطر منفصل للإجابة)
function formatQuizText(quiz) {
    let text = `<b>${quiz.question}</b>\n\n`; // سطر فارغ بعد السؤال
    const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    
    // عرض الاختيارات مع سطر فارغ بين كل اختيار
    quiz.options.forEach((opt, index) => {
        const letter = optionLetters[index] || (index + 1);
        text += `<b>${letter})</b> ${opt}\n\n`; // \n\n تضمن وجود سطر فارغ
    });

    // إضافة سطر الإجابة المنفصل (يظهر فقط إذا كان هناك حل)
    if (quiz.correctOptionId !== null && quiz.correctOptionId >= 0) {
        const correctLetter = optionLetters[quiz.correctOptionId];
        const correctText = quiz.options[quiz.correctOptionId];
        
        // 🔥 الإجابة في سطر منفصل ومشوشة بالكامل
        text += `<span class="tg-spoiler">✅ <b>الإجابة الصحيحة:</b> ${correctLetter}) ${correctText}</span>`;
    }

    if (quiz.explanation) {
        text += `\n\n<span class="tg-spoiler">💡 <b>توضيح:</b> ${quiz.explanation}</span>`;
    }
    
    return text;
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
        // 👮‍♂️ أوامر الأدمن
        // ---------------------------------------------------------
        if (userId === ADMIN_CHAT_ID && msg && msg.text) {
            const text = msg.text.trim();
            if (text === '/adminhelp' || text === '/cmds') {
                const helpMsg = `🛠️ <b>لوحة التحكم:</b>\n` +
                                `• <code>/stats</code> الإحصائيات\n` +
                                `• <code>/user [ID]</code> تقرير مستخدم\n` +
                                `• <code>/setwelcome</code> تغيير الترحيب\n` +
                                `• <code>/setalert</code> نشر تنبيه\n` +
                                `• <code>/repairon</code> | <code>/repairoff</code> الصيانة`;
                await bot.sendMessage(userId, helpMsg, { parse_mode: 'HTML' });
                return res.status(200).send('Help');
            }
            if (text === '/stats') {
                await bot.sendMessage(userId, '⏳ <b>جاري التحليل...</b>', { parse_mode: 'HTML' });
                const s = await getGlobalStats();
                if (s) {
                    const rTotal = s.files.total > 0 ? Math.round((s.files.success / s.files.total) * 100) : 0;
                    const report = `📊 <b>الإحصائيات:</b>\n\n👥 <b>المستخدمين:</b> ${s.users.total}\n📁 <b>الملفات:</b> ${s.files.total} (${rTotal}%)\n📅 <b>اليوم:</b> ${s.today.total}`;
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
                await bot.sendMessage(userId, `✅ تم نشر التنبيه.`);
                return res.status(200).send('Alert Set');
            }
            if (text === '/repairon') { global.isMaintenanceMode = true; await bot.sendMessage(ADMIN_CHAT_ID, '🛠️ ON'); return res.status(200).send('ON'); }
            if (text === '/repairoff') { global.isMaintenanceMode = false; await bot.sendMessage(ADMIN_CHAT_ID, '✅ OFF'); return res.status(200).send('OFF'); }
        }

        // 🚧 التحقق من الصيانة
        if (global.isMaintenanceMode && userId !== ADMIN_CHAT_ID) {
             if (msg) await bot.sendMessage(msg.chat.id, '⚠️ <b>البوت في وضع الصيانة.</b>', {parse_mode: 'HTML'}); 
             else if (cb) await bot.answerCallbackQuery(cb.id, { text: '⚠️ الصيانة مفعلة.', show_alert: true });
             return res.status(200).send('Maintenance');
        }

        // =========================================================
        // 0️⃣ أمر /start
        // =========================================================
        if (msg && msg.text && msg.text.startsWith('/start')) {
            const chatId = msg.chat.id;
            const welcomeCfg = await getBotConfig('welcome_msg');
            const welcomeText = welcomeCfg?.text || `مرحباً بك ${fromUser.first_name}! 👋\n\n📚 <b>أرسل لي ملف PDF وسأقوم بتحليله.</b>`;
            await bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML' });
            await checkAndSendAlert(chatId, fromUser);
            return res.status(200).send('Start');
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
                const processingMsg = `🤖 <b>يتم تحليل الملف...</b>\n⚠️ إذا استمرت المعالجة أكثر من 6 دقائق، يرجى تقسيم الملف.`;
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

            // أزرار إرسال GAS
            else if (data.startsWith('cmd_send')) {
                const parts = data.split('|');
                const count = parts[1]; const model = parts[2]; const uniqueKey = parts[3]; const targetRaw = parts[4]; const closePolls = targetRaw.includes('close'); 

                if (targetRaw.includes('here')) {
                    const modeText = closePolls ? " (وحلها)" : "";
                    await bot.answerCallbackQuery(cb.id, { text: `🚀 جاري البدء${modeText}...` });
                    await bot.sendMessage(chatId, `⚡ <b>جاري إرسال ${count} سؤال...</b>`, {parse_mode: 'HTML'});
                    await logUsage(userId, null, 'Quiz', count, model, 'success', 'quiz_send');
                    await sendToGasAndForget({
                        action: 'execute_send', userId: userId, targetChatId: chatId,
                        chatType: 'private', sessionKey: uniqueKey, closePolls: closePolls
                    });
                } 
            }
        }

    } catch (e) { console.error("💥 General Error:", e.message); }
    res.status(200).send('OK');
};
