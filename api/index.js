// =========================================================
// 🎮 Vercel Controller - Version 44.0 (Better Help Message)
// Features: Enhanced Admin Help | Maintenance | Updates
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

// دوال الإحصائيات
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

            // 1. دليل الأوامر (المحسن)
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
            const welcomeText = welcomeCfg?.text || `مرحباً بك ${fromUser.first_name}! 👋\n\n📚 <b>أرسل لي ملف PDF وسأقوم بتحليله.</b>`;
            await bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML' });
            await checkAndSendAlert(chatId, fromUser);
            return res.status(200).send('Start');
        }

        // =========================================================
        // 1️⃣ استلام الملف
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

                await bot.editMessageText(processingMsg, { 
                    chat_id: chatId, 
                    message_id: waitMsg.message_id, 
                    parse_mode: 'HTML' 
                });
                
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
        // 2️⃣ الأزرار
        // =========================================================
        else if (cb) {
            const chatId = cb.message.chat.id;
            const data = cb.data; 
            if (data.startsWith('cmd_send')) {
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
