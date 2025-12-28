// =========================================================
// 🎮 Vercel Controller - Version 40.0 (Advanced Stats)
// Features: Detailed Dashboard | Daily Performance | AI Dist
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

async function upsertUser(user) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/users`, {
            user_id: user.id,
            first_name: user.first_name,
            username: user.username || null,
            last_active: new Date().toISOString()
        }, {
            headers: { 
                'apikey': SUPABASE_KEY, 
                'Authorization': `Bearer ${SUPABASE_KEY}`, 
                'Content-Type': 'application/json', 
                'Prefer': 'resolution=merge-duplicates' 
            }
        });
    } catch (e) { console.error("❌ Supabase Upsert Error:", e.response?.data || e.message); }
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
            headers: { 
                'apikey': SUPABASE_KEY, 
                'Authorization': `Bearer ${SUPABASE_KEY}`, 
                'Content-Type': 'application/json' 
            }
        });
    } catch (e) { console.error("❌ Supabase Log Usage Error:", e.response?.data || e.message); }
}

// ✅ [تحديث] دالة جلب الإحصائيات التفصيلية
async function getGlobalStats() {
    try {
        const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'count=exact' };
        
        // حساب تاريخ بداية اليوم (Midnight)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayISO = today.toISOString();

        // تنفيذ الطلبات بشكل متوازي للسرعة
        const [
            totalUsersRes,
            activeUsersTodayRes,
            totalLogsRes,
            totalSuccessRes,
            logsTodayRes,
            successTodayRes,
            failTodayRes,
            flash25TodayRes,
            gemma3TodayRes,
            regexTodayRes
        ] = await Promise.all([
            // 1. المستخدمين
            axios.head(`${SUPABASE_URL}/rest/v1/users`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/users?last_active=gte.${todayISO}`, { headers }),
            
            // 2. الملفات الكلية
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?status=eq.success`, { headers }),

            // 3. أداء اليوم
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}&status=eq.success`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}&status=neq.success`, { headers }),

            // 4. توزيع النماذج (اليوم)
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}&model_used=eq.gemini-2.5-flash`, { headers }),
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}&model_used=eq.gemma-3`, { headers }), // افتراضي
            axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?created_at=gte.${todayISO}&method=eq.regex_fallback`, { headers }) // افتراضي
        ]);

        // استخراج الأرقام
        const getCount = (res) => parseInt(res.headers['content-range']?.split('/')[1] || '0');

        const stats = {
            users: {
                total: getCount(totalUsersRes),
                activeToday: getCount(activeUsersTodayRes)
            },
            files: {
                total: getCount(totalLogsRes),
                successTotal: getCount(totalSuccessRes)
            },
            today: {
                total: getCount(logsTodayRes),
                success: getCount(successTodayRes),
                fail: getCount(failTodayRes)
            },
            models: {
                flash25: getCount(flash25TodayRes),
                gemma3: getCount(gemma3TodayRes),
                regex: getCount(regexTodayRes)
            }
        };

        return stats;
    } catch (e) { 
        console.error("❌ Stats Error:", e.response?.status, e.message);
        return null; 
    }
}

// ✅ دالة جلب إحصائيات مستخدم محدد
async function getUserStats(targetId) {
    try {
        const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };
        const countHeaders = { ...headers, 'Prefer': 'count=exact' };

        const userRes = await axios.get(`${SUPABASE_URL}/rest/v1/users?user_id=eq.${targetId}`, { headers });
        if (!userRes.data || userRes.data.length === 0) return null;
        const user = userRes.data[0];

        const logsRes = await axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?user_id=eq.${targetId}`, { headers: countHeaders });
        const totalRequests = logsRes.headers['content-range'] ? logsRes.headers['content-range'].split('/')[1] : '0';

        return { ...user, totalRequests };
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

            if (text === '/stats') {
                await bot.sendMessage(userId, '⏳ <b>جاري تحليل البيانات...</b>', { parse_mode: 'HTML' });
                
                const s = await getGlobalStats();
                
                if (s) {
                    // حساب النسب المئوية
                    const totalSuccessRate = s.files.total > 0 ? Math.round((s.files.successTotal / s.files.total) * 100) : 0;
                    const todaySuccessRate = s.today.total > 0 ? Math.round((s.today.success / s.today.total) * 100) : 0;

                    const report = `📊 <b>الإحصائيات العامة للبوت:</b>\n\n` +
                                   `👥 <b>المستخدمين:</b>\n` +
                                   `• الإجمالي: <code>${s.users.total}</code>\n` +
                                   `• النشطين اليوم: <code>${s.users.activeToday}</code>\n\n` +
                                   
                                   `📁 <b>الملفات (الكلي):</b>\n` +
                                   `• العدد: <code>${s.files.total}</code>\n` +
                                   `• نسبة النجاح: <code>${totalSuccessRate}%</code>\n\n` +

                                   `📅 <b>أداء اليوم (${s.today.total} ملف):</b>\n` +
                                   `• نجاح: <code>${s.today.success}</code> (${todaySuccessRate}%)\n` +
                                   `• فشل: <code>${s.today.fail}</code>\n` +
                                   `-------------------\n` +
                                   `🤖 <b>توزيع الذكاء الاصطناعي (اليوم):</b>\n` +
                                   `• ⚡ Flash 2.5: <code>${s.models.flash25}</code>\n` +
                                   `• 🛡️ Gemma 3: <code>${s.models.gemma3}</code>\n` +
                                   `• 🧩 Regex Fallback: <code>${s.models.regex}</code>`;
                                   
                    await bot.sendMessage(userId, report, { parse_mode: 'HTML' });
                } else {
                    await bot.sendMessage(userId, '❌ حدث خطأ أثناء جلب الإحصائيات.');
                }
                return res.status(200).send('Stats Sent');
            }

            if (text.startsWith('/user ')) {
                const targetId = text.split(' ')[1];
                if (!targetId) return await bot.sendMessage(userId, '⚠️ أرسل الآيدي: /user 123');

                const u = await getUserStats(targetId);
                if (u) {
                    const joined = new Date(u.joined_at).toLocaleDateString('ar-EG');
                    const active = new Date(u.last_active).toLocaleString('ar-EG');
                    await bot.sendMessage(userId, 
                        `👤 <b>تقرير المستخدم:</b>\n🆔 <code>${u.user_id}</code>\n📛 ${u.first_name}\n📂 ملفات: ${u.totalRequests}\n📅 انضم: ${joined}\n⌚ نشط: ${active}`, 
                        { parse_mode: 'HTML' }
                    );
                } else {
                    await bot.sendMessage(userId, '❌ المستخدم غير موجود.');
                }
                return res.status(200).send('User Stats');
            }
            
            if (text === '/repairon') { global.isMaintenanceMode = true; await bot.sendMessage(ADMIN_CHAT_ID, '🛠️ ON'); return res.status(200).send('ON'); }
            if (text === '/repairoff') { global.isMaintenanceMode = false; await bot.sendMessage(ADMIN_CHAT_ID, '✅ OFF'); return res.status(200).send('OFF'); }
        }

        // 🚧 التحقق من الصيانة
        if (global.isMaintenanceMode && userId !== ADMIN_CHAT_ID) {
             if (msg) await bot.sendMessage(msg.chat.id, '⚠️ البوت في وضع الصيانة.');
             else if (cb) await bot.answerCallbackQuery(cb.id, { text: '⚠️ الصيانة مفعلة.', show_alert: true });
             return res.status(200).send('Maintenance');
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
                await bot.sendMessage(chatId, '❌ <b>ملفات PDF فقط.</b>', {parse_mode: 'HTML'}); 
                return res.status(200).send('OK');
            }

            await upsertUser(fromUser);
            await logUsage(userId, fileId, fileName, 0, null, 'processing', 'url_handover');

            const waitMsg = await bot.sendMessage(chatId, '⏳ <b>جاري تحويل الملف للمعالجة...</b>', {parse_mode: 'HTML'});

            try {
                const fileLink = await bot.getFileLink(fileId);
                await bot.editMessageText('🤖 <b>يتم الآن التحميل والتحليل بواسطة Google...</b>\n\n🚀 هذه الطريقة أسرع للملفات الكبيرة.', { 
                    chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'HTML' 
                });
                
                await sendToGasAndForget({
                    action: 'analyze_async', fileUrl: fileLink, chatId: chatId, userId: userId,
                    userName: userName, userUsername: fromUser.username, fileId: fileId, fileName: fileName
                });

            } catch (err) {
                console.error("❌ PDF Error:", err.message);
                await logUsage(userId, fileId, fileName, 0, null, 'failed', 'url_handover', err.message);
                await bot.sendMessage(chatId, '❌ حدث خطأ أثناء تجهيز الملف.');
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
                const count = parts[1];
                const model = parts[2];
                const uniqueKey = parts[3]; 
                const targetRaw = parts[4]; 
                const closePolls = targetRaw.includes('close'); 

                if (targetRaw.includes('here')) {
                    const modeText = closePolls ? " (وحلها)" : "";
                    await bot.answerCallbackQuery(cb.id, { text: `🚀 جاري البدء${modeText}...` });
                    await bot.sendMessage(chatId, `⚡ <b>جاري إرسال ${count} سؤال...</b>`, {parse_mode: 'HTML'});
                    
                    // تسجيل نجاح العملية واسم النموذج المستخدم فعلياً
                    // نفترض هنا أن model القادم من GAS هو اسم النموذج (مثل gemini-2.5-flash)
                    await logUsage(userId, null, 'Quiz Execution', count, model, 'success', 'quiz_send');

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
