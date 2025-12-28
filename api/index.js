// =========================================================
// 🎮 Vercel Controller - Version 38.0 (Stats & Schema Update)
// Features: Admin Stats | User Lookup | New DB Schema Support
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

// ✅ تسجيل أو تحديث بيانات المستخدم
async function upsertUser(user) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/users`, {
            user_id: user.id, // تم تحديث الاسم ليطابق السكيما الجديدة
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
    } catch (e) { console.error("Supabase User Error:", e.message); }
}

// ✅ تسجيل العمليات في الجدول الجديد public.processing_logs
async function logUsage(userId, fileId, fileName, count, model, status, method, errorReason = null) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/processing_logs`, {
            user_id: userId,
            file_id: fileId || null,
            file_name: fileName || 'unknown',
            status: status,
            method: method || 'vision', // vision or text
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
    } catch (e) { console.error("Supabase Log Error:", e.message); }
}

// ✅ جلب إحصائيات عامة (للأدمن)
async function getGlobalStats() {
    try {
        const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };
        
        // 1. عدد المستخدمين الكلي
        const usersRes = await axios.head(`${SUPABASE_URL}/rest/v1/users`, { headers, params: { select: 'count' } });
        const totalUsers = usersRes.headers['content-range'] ? usersRes.headers['content-range'].split('/')[1] : 0;

        // 2. عدد الملفات الناجحة
        const logsSuccess = await axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?status=eq.success`, { headers, params: { select: 'count' } });
        const totalSuccess = logsSuccess.headers['content-range'] ? logsSuccess.headers['content-range'].split('/')[1] : 0;

        // 3. عدد الملفات الفاشلة
        const logsFail = await axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?status=neq.success`, { headers, params: { select: 'count' } });
        const totalFail = logsFail.headers['content-range'] ? logsFail.headers['content-range'].split('/')[1] : 0;

        return { totalUsers, totalSuccess, totalFail };
    } catch (e) { return null; }
}

// ✅ جلب إحصائيات مستخدم محدد (للأدمن)
async function getUserStats(targetId) {
    try {
        const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

        // بيانات المستخدم
        const userRes = await axios.get(`${SUPABASE_URL}/rest/v1/users?user_id=eq.${targetId}`, { headers });
        if (!userRes.data || userRes.data.length === 0) return null;
        const user = userRes.data[0];

        // عدد محاولاته
        const logsRes = await axios.head(`${SUPABASE_URL}/rest/v1/processing_logs?user_id=eq.${targetId}`, { headers, params: { select: 'count' } });
        const totalRequests = logsRes.headers['content-range'] ? logsRes.headers['content-range'].split('/')[1] : 0;

        return { ...user, totalRequests };
    } catch (e) { return null; }
}

// ✅ دالة الإرسال لـ GAS
async function sendToGasAndForget(payload) {
    try {
        await axios.post(GAS_WEB_APP_URL, payload, { timeout: 1500 });
    } catch (error) {
        if (error.code !== 'ECONNABORTED' && !error.message.includes('timeout')) {
            console.error("GAS Connection Error:", error.message);
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
        // 👮‍♂️ أوامر الأدمن (Statistics)
        // ---------------------------------------------------------
        if (userId === ADMIN_CHAT_ID && msg && msg.text) {
            const text = msg.text.trim();

            // 1. الإحصائيات العامة (/stats)
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
                    await bot.sendMessage(userId, '❌ حدث خطأ أثناء جلب الإحصائيات.');
                }
                return res.status(200).send('Stats Sent');
            }

            // 2. إحصائيات مستخدم محدد (/user 123456)
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
                    await bot.sendMessage(userId, '❌ لم يتم العثور على هذا المستخدم في قاعدة البيانات.');
                }
                return res.status(200).send('User Stats Sent');
            }
            
            // أوامر الصيانة (كما هي)
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
        // 1️⃣ استلام الملف (PDF - URL Based)
        // =========================================================
        if (msg && msg.document) {
            const chatId = msg.chat.id;
            const fileId = msg.document.file_id;
            const fileName = msg.document.file_name; // اسم الملف للتسجيل
            const userName = `${fromUser.first_name} ${fromUser.last_name || ''}`.trim();
            
            if (msg.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '❌ <b>ملفات PDF فقط.</b>', {parse_mode: 'HTML'}); 
                return res.status(200).send('OK');
            }

            // A. تسجيل المستخدم
            await upsertUser(fromUser);

            // B. تسجيل بدء العملية في الجدول الجديد
            await logUsage(userId, fileId, fileName, 0, null, 'processing', 'url_handover');

            const waitMsg = await bot.sendMessage(chatId, '⏳ <b>جاري تحويل الملف للمعالجة...</b>', {parse_mode: 'HTML'});

            try {
                // إرسال الرابط لـ GAS ليقوم بالتحميل
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
                    fileName: fileName // إرسال اسم الملف أيضاً
                });

            } catch (err) {
                console.error("PDF Link Error:", err);
                await logUsage(userId, fileId, fileName, 0, null, 'failed', 'url_handover', err.message);
                await bot.sendMessage(chatId, '❌ حدث خطأ أثناء تجهيز الملف.');
            }
        }

        // =========================================================
        // 2️⃣ التعامل مع الأزرار (Callback Queries)
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
                    
                    // تحديث السجل بأن العملية تمت (Executed)
                    // ملاحظة: هنا نرسل fileName كـ null لأنه غير متوفر في الـ callback، ويمكن تحسينه لاحقاً
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

    } catch (e) { console.error("General Error:", e); }
    res.status(200).send('OK');
};
