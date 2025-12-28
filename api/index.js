// =========================================================
// 🎮 Vercel Controller - Version 39.0 (Debug Stats)
// Features: Fix Supabase Count | Error Logging to Vercel
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
    } catch (e) { 
        // تسجيل الخطأ في Vercel Logs
        console.error("❌ Supabase Upsert Error:", e.response?.data || e.message); 
    }
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
    } catch (e) { 
        console.error("❌ Supabase Log Usage Error:", e.response?.data || e.message); 
    }
}

// ✅ [تعديل] دالة جلب الإحصائيات العامة مع اللوجات الصحيحة
async function getGlobalStats() {
    try {
        // 🔥 إضافة 'Prefer': 'count=exact' ضروري لجلب العدد
        const headers = { 
            'apikey': SUPABASE_KEY, 
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'count=exact' 
        };
        
        console.log("📊 Fetching Global Stats..."); // يظهر في Logs

        // 1. عدد المستخدمين الكلي
        const usersRes = await axios.head(`${SUPABASE_URL}/rest/v1/users`, { headers });
        const totalUsers = usersRes.headers['content-range'] ? usersRes.headers['content-range'].split('/')[1] : '0';

        // 2. عدد الملفات الناجحة
        const logsSuccess = await axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?status=eq.success`, { headers });
        const totalSuccess = logsSuccess.headers['content-range'] ? logsSuccess.headers['content-range'].split('/')[1] : '0';

        // 3. عدد الملفات الفاشلة
        const logsFail = await axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?status=neq.success`, { headers });
        const totalFail = logsFail.headers['content-range'] ? logsFail.headers['content-range'].split('/')[1] : '0';

        console.log(`Stats Result: Users=${totalUsers}, Success=${totalSuccess}, Fail=${totalFail}`);

        return { totalUsers, totalSuccess, totalFail };
    } catch (e) { 
        // 🔥 تسجيل تفاصيل الخطأ كاملة لمعرفة السبب
        console.error("❌ Stats Error:", e.response?.status, e.response?.statusText, e.response?.data || e.message);
        return null; 
    }
}

// ✅ [تعديل] دالة جلب إحصائيات مستخدم محدد
async function getUserStats(targetId) {
    try {
        const headers = { 
            'apikey': SUPABASE_KEY, 
            'Authorization': `Bearer ${SUPABASE_KEY}`
        };
        const countHeaders = { ...headers, 'Prefer': 'count=exact' };

        // بيانات المستخدم
        const userRes = await axios.get(`${SUPABASE_URL}/rest/v1/users?user_id=eq.${targetId}`, { headers });
        if (!userRes.data || userRes.data.length === 0) return null;
        const user = userRes.data[0];

        // عدد محاولاته (HEAD request)
        const logsRes = await axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?user_id=eq.${targetId}`, { headers: countHeaders });
        const totalRequests = logsRes.headers['content-range'] ? logsRes.headers['content-range'].split('/')[1] : '0';

        return { ...user, totalRequests };
    } catch (e) { 
        console.error("❌ User Stats Error:", e.response?.data || e.message);
        return null; 
    }
}

async function sendToGasAndForget(payload) {
    try {
        await axios.post(GAS_WEB_APP_URL, payload, { timeout: 1500 });
    } catch (error) {
        if (error.code !== 'ECONNABORTED' && !error.message.includes('timeout')) {
            console.error("⚠️ GAS Connection Error:", error.message);
        }
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
        // 👮‍♂️ أوامر الأدمن
        // ---------------------------------------------------------
        if (userId === ADMIN_CHAT_ID && msg && msg.text) {
            const text = msg.text.trim();

            if (text === '/stats') {
                await bot.sendMessage(userId, '⏳ <b>جاري جلب البيانات...</b>', { parse_mode: 'HTML' });
                
                const stats = await getGlobalStats();
                
                if (stats) {
                    const report = `📊 <b>الإحصائيات العامة للبوت:</b>\n\n` +
                                   `👥 <b>عدد المستخدمين:</b> <code>${stats.totalUsers}</code>\n` +
                                   `✅ <b>عمليات ناجحة:</b> <code>${stats.totalSuccess}</code>\n` +
                                   `❌ <b>عمليات فاشلة:</b> <code>${stats.totalFail}</code>\n` +
                                   `📅 <b>التاريخ:</b> ${new Date().toLocaleDateString('ar-EG')}`;
                    await bot.sendMessage(userId, report, { parse_mode: 'HTML' });
                } else {
                    // في حالة الفشل، رسالة توضح أن الخطأ تم تسجيله
                    await bot.sendMessage(userId, '❌ حدث خطأ أثناء جلب الإحصائيات.\nراجع Vercel Logs لمعرفة السبب.');
                }
                return res.status(200).send('Stats Sent');
            }

            if (text.startsWith('/user ')) {
                const targetId = text.split(' ')[1];
                if (!targetId) return await bot.sendMessage(userId, '⚠️ يجب كتابة الآيدي. مثال:\n/user 123456789');

                const uStats = await getUserStats(targetId);
                if (uStats) {
                    const joinedDate = new Date(uStats.joined_at).toLocaleDateString('ar-EG');
                    const lastActive = new Date(uStats.last_active).toLocaleString('ar-EG');
                    
                    const report = `👤 <b>تقرير المستخدم:</b>\n\n` +
                                   `🆔 <b>الآيدي:</b> <code>${uStats.user_id}</code>\n` +
                                   `📛 <b>الاسم:</b> ${uStats.first_name}\n` +
                                   `📧 <b>المعرف:</b> @${uStats.username || 'بدون'}\n` +
                                   `📅 <b>انضم منذ:</b> ${joinedDate}\n` +
                                   `⌚ <b>آخر نشاط:</b> ${lastActive}\n` +
                                   `📂 <b>عدد الملفات المرسلة:</b> ${uStats.totalRequests}`;
                    await bot.sendMessage(userId, report, { parse_mode: 'HTML' });
                } else {
                    await bot.sendMessage(userId, '❌ لم يتم العثور على بيانات (أو حدث خطأ، راجع اللوجات).');
                }
                return res.status(200).send('User Stats Sent');
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
            // تسجيل مبدئي للعملية
            await logUsage(userId, fileId, fileName, 0, null, 'processing', 'url_handover');

            const waitMsg = await bot.sendMessage(chatId, '⏳ <b>جاري تحويل الملف للمعالجة...</b>', {parse_mode: 'HTML'});

            try {
                const fileLink = await bot.getFileLink(fileId);

                await bot.editMessageText('🤖 <b>يتم الآن التحميل والتحليل بواسطة Google...</b>\n\n🚀 هذه الطريقة أسرع للملفات الكبيرة.', { 
                    chat_id: chatId, 
                    message_id: waitMsg.message_id, 
                    parse_mode: 'HTML' 
                });
                
                await sendToGasAndForget({
                    action: 'analyze_async',
                    fileUrl: fileLink,
                    chatId: chatId,
                    userId: userId,
                    userName: userName,
                    userUsername: fromUser.username,
                    fileId: fileId,
                    fileName: fileName
                });

            } catch (err) {
                console.error("❌ PDF Handover Error:", err.message); // Log
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
                    
                    // تحديث الحالة لـ success في السجل
                    await logUsage(userId, null, 'Quiz Execution', count, model, 'success', 'quiz_send');

                    await sendToGasAndForget({
                        action: 'execute_send',
                        userId: userId,
                        targetChatId: chatId,
                        chatType: 'private',
                        sessionKey: uniqueKey,
                        closePolls: closePolls
                    });
                } 
            }
        }

    } catch (e) { 
        // تسجيل الأخطاء العامة في Vercel
        console.error("💥 General Vercel Error:", e.message); 
    }
    res.status(200).send('OK');
};
