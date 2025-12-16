// =========================================================
// 🎮 Vercel Controller - Version 24.0 (Final Integration)
// Features: Unique Session Key Support | Supabase | Async Trigger
// =========================================================

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
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

// 🧠 الذاكرة المؤقتة (Global State)
if (!global.userState) global.userState = {};
if (global.isMaintenanceMode === undefined) global.isMaintenanceMode = false;

// =========================================================
// 🗄️ دوال قاعدة البيانات (Supabase)
// =========================================================

async function upsertUser(user) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/users`, {
            telegram_id: user.id,
            full_name: `${user.first_name} ${user.last_name || ''}`.trim(),
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

async function logUsage(userId, count, model, status = 'success') {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/usage_logs`, {
            telegram_id: userId,
            questions_count: parseInt(count) || 0,
            model: model || 'unknown',
            status: status,
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

// =========================================================
// ⚡ دالة الإرسال لـ GAS (Fire & Forget)
// =========================================================
async function sendToGasAndForget(payload) {
    // نستخدم Timeout قصير جداً (1500ms) لضمان عدم انتظار Vercel للتحليل الطويل
    try {
        await axios.post(GAS_WEB_APP_URL, payload, { timeout: 1500 });
    } catch (error) {
        // نتجاهل أخطاء التايم أوت لأن هذا هو المطلوب (إرسال وإغلاق)
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

        // 🛠️ أوامر الصيانة (Admin Only)
        if (update.message && update.message.text && String(update.message.from.id) === ADMIN_CHAT_ID) {
            const txt = update.message.text.trim();
            if (txt === '/repairon') { 
                global.isMaintenanceMode = true; 
                await bot.sendMessage(ADMIN_CHAT_ID, '🛠️ <b>تم تفعيل وضع الصيانة.</b>', {parse_mode: 'HTML'}); 
                return res.status(200).send('ON'); 
            }
            if (txt === '/repairoff') { 
                global.isMaintenanceMode = false; 
                await bot.sendMessage(ADMIN_CHAT_ID, '✅ <b>تم إيقاف وضع الصيانة.</b>', {parse_mode: 'HTML'}); 
                return res.status(200).send('OFF'); 
            }
        }

        // فحص الصيانة للمستخدمين
        if (global.isMaintenanceMode && String(update.message?.from?.id) !== ADMIN_CHAT_ID) {
             if(update.message) await bot.sendMessage(update.message.chat.id, '⚠️ <b>عذراً، البوت في وضع الصيانة حالياً.</b>', {parse_mode: 'HTML'}); 
             return res.status(200).send('Maintenance');
        }

        // =========================================================
        // 1️⃣ استلام الملف (PDF Handling)
        // =========================================================
        if (update.message && update.message.document) {
            const chatId = update.message.chat.id;
            const fileId = update.message.document.file_id;
            const user = update.message.from;
            const userName = `${user.first_name} ${user.last_name || ''}`.trim();
            
            if (update.message.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '❌ <b>يرجى إرسال ملفات PDF فقط.</b>', {parse_mode: 'HTML'}); 
                return res.status(200).send('OK');
            }

            // A. تسجيل المستخدم فوراً
            await upsertUser(user);

            // B. تسجيل العملية في Supabase (حالة Processing)
            await logUsage(user.id, 0, 'file_upload', 'processing');

            const msg = await bot.sendMessage(chatId, '⏳ <b>جاري استلام الملف...</b>', {parse_mode: 'HTML'});

            try {
                // C. استخراج النص
                const fileLink = await bot.getFileLink(fileId);
                const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                const pdfData = await pdf(Buffer.from(response.data));
                const text = pdfData.text;

                if (!text || text.length < 50) {
                    await bot.sendMessage(chatId, '❌ <b>الملف لا يحتوي على نص قابل للقراءة.</b>', {parse_mode: 'HTML'});
                } else {
                    await bot.editMessageText('🤖 <b>يتم الآن التحليل بواسطة الذكاء الاصطناعي...</b>\n\n✨ ستظهر النتائج تلقائياً عند الانتهاء.', { 
                        chat_id: chatId, 
                        message_id: msg.message_id, 
                        parse_mode: 'HTML' 
                    });
                    
                    // D. إرسال لـ GAS (Async)
                    // نرسل fileId ليستخدمه GAS في تقرير الفشل للأدمن
                    await sendToGasAndForget({
                        action: 'analyze_async',
                        text: text,
                        chatId: chatId,
                        userId: user.id,
                        userName: userName,
                        fileId: fileId 
                    });
                }
            } catch (err) {
                console.error("PDF Error:", err);
                await bot.sendMessage(chatId, '❌ حدث خطأ أثناء قراءة الملف.');
            }
        }

        // =========================================================
        // 2️⃣ التعامل مع الأزرار (Callback Queries)
        // =========================================================
        else if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;
            const data = cb.data; 
            const userId = cb.from.id;

            // تحليل البيانات من الزر (التي أنشأها GAS)
            // الصيغة: cmd_send | count | model | uniqueKey | target
            
            if (data.startsWith('cmd_send')) {
                const parts = data.split('|');
                const count = parts[1];
                const model = parts[2];
                const uniqueKey = parts[3]; // 🔥 المفتاح الفريد للجلسة
                const target = parts[4];

                if (target === 'here') {
                    await bot.answerCallbackQuery(cb.id, { text: '🚀 جاري البدء...' });
                    await bot.sendMessage(chatId, `⚡ <b>جاري إرسال ${count} سؤال...</b>`, {parse_mode: 'HTML'});

                    // تسجيل الاستهلاك (Status: Executed)
                    await logUsage(userId, count, model, 'executed');

                    // إرسال أمر التنفيذ لـ GAS مع المفتاح الفريد
                    await sendToGasAndForget({
                        action: 'execute_send',
                        userId: userId,
                        targetChatId: chatId,
                        chatType: 'private',
                        sessionKey: uniqueKey // 👈 تمرير المفتاح
                    });
                } 
                else if (target === 'chan') {
                    // تخزين الحالة مؤقتاً لانتظار معرف القناة
                    global.userState[userId] = { 
                        step: 'awaiting_channel', 
                        count, model, 
                        sessionKey: uniqueKey // 👈 تخزين المفتاح
                    };
                    await bot.answerCallbackQuery(cb.id);
                    await bot.sendMessage(chatId, '📝 <b>أرسل معرف القناة أو المجموعة الآن:</b>', {parse_mode: 'HTML'});
                }
            }
        }

        // =========================================================
        // 3️⃣ استلام معرف القناة
        // =========================================================
        else if (update.message && update.message.text) {
             const userId = update.message.from.id;
             const chatId = update.message.chat.id;
             const text = update.message.text.trim();

             if (global.userState[userId] && global.userState[userId].step === 'awaiting_channel') {
                 const { count, model, sessionKey } = global.userState[userId];
                 
                 // التحقق البسيط
                 if (!text.startsWith('@') && !text.startsWith('-100')) {
                    await bot.sendMessage(chatId, '⚠️ معرف غير صالح (يجب أن يبدأ بـ @ أو -100).');
                    return res.status(200).send('OK');
                 }

                 await bot.sendMessage(chatId, `🚀 <b>جاري التوجيه للقناة (${text})...</b>`, {parse_mode: 'HTML'});
                 
                 // تسجيل الاستهلاك
                 await logUsage(userId, count, model, 'executed_channel');

                 // إرسال أمر التنفيذ لـ GAS
                 await sendToGasAndForget({
                    action: 'execute_send',
                    userId: userId,
                    targetChatId: text,
                    chatType: 'channel',
                    sessionKey: sessionKey // 👈 تمرير المفتاح
                });
                
                delete global.userState[userId];
             }
        }

    } catch (e) { console.error("General Error:", e); }
    
    // إنهاء الطلب دائماً
    res.status(200).send('OK');
};
