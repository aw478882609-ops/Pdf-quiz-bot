// ==== كود Vercel الكامل (api/index.js) - Version 19.0 (Controller + Supabase) ====

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

// ⚙️ الإعدادات (Environment Variables)
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

// 🗄️ إعدادات Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// 🧠 الذاكرة المؤقتة (لإدارة القنوات وحالة الصيانة)
if (!global.userState) global.userState = {};
if (global.isMaintenanceMode === undefined) global.isMaintenanceMode = false;

// =========================================================
// 🗄️ دوال Supabase
// =========================================================

// تسجيل أو تحديث بيانات المستخدم
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
        console.log(`✅ User ${user.id} logged.`);
    } catch (e) { console.error("Supabase User Error:", e.message); }
}

// تسجيل الاستهلاك (Logs)
async function logUsage(userId, questionCount, modelName, status = 'success') {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/usage_logs`, {
            telegram_id: userId,
            questions_count: parseInt(questionCount) || 0,
            model: modelName || 'unknown',
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
// ⚡ دالة الإرسال السريع لـ GAS (Fire & Forget)
// =========================================================
async function sendToGasAndForget(payload) {
    // نستخدم Timeout قصير جداً (1.5 ثانية)
    // الهدف: تسليم البيانات لـ GAS وإغلاق اتصال Vercel فوراً
    try {
        await axios.post(GAS_WEB_APP_URL, payload, { timeout: 1500 });
    } catch (error) {
        // نتجاهل أخطاء الوقت (Timeout) لأن هذا متوقع ومطلوب
        if (error.code !== 'ECONNABORTED' && !error.message.includes('timeout')) {
            console.error("❌ GAS Connection Error:", error.message);
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

        // 🛠️ فحص أوامر الصيانة (للأدمن فقط)
        if (update.message && update.message.text && String(update.message.from.id) === ADMIN_CHAT_ID) {
            if (update.message.text === '/repairon') { 
                global.isMaintenanceMode = true; 
                await bot.sendMessage(ADMIN_CHAT_ID, '🛠️ Maintenance Mode: ON'); 
                return res.send('ON'); 
            }
            if (update.message.text === '/repairoff') { 
                global.isMaintenanceMode = false; 
                await bot.sendMessage(ADMIN_CHAT_ID, '✅ Maintenance Mode: OFF'); 
                return res.send('OFF'); 
            }
        }

        // منع الاستخدام أثناء الصيانة
        if (global.isMaintenanceMode && String(update.message?.from?.id) !== ADMIN_CHAT_ID) {
             if(update.message) await bot.sendMessage(update.message.chat.id, '⚠️ البوت في وضع الصيانة حالياً للتحديث.'); 
             return res.send('Maintenance');
        }

        // =========================================================
        // 1️⃣ استلام الملف (PDF)
        // =========================================================
        if (update.message && update.message.document) {
            const chatId = update.message.chat.id;
            const fileId = update.message.document.file_id;
            const user = update.message.from;
            const userName = `${user.first_name} ${user.last_name || ''}`.trim();
            
            if (update.message.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '❌ يرجى إرسال ملفات PDF فقط.'); 
                return res.send('OK');
            }

            // A. تسجيل المستخدم فوراً في Supabase
            await upsertUser(user);

            // B. تسجيل محاولة رفع ملف (بعدد أسئلة 0 مبدئياً)
            await logUsage(user.id, 0, 'file_upload', 'processing');

            const msg = await bot.sendMessage(chatId, '⏳ تم استلام الملف.. جاري استخراج النص والتحليل...');

            // C. استخراج النص وإرساله لـ GAS
            try {
                const fileLink = await bot.getFileLink(fileId);
                const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                const pdfData = await pdf(Buffer.from(response.data));
                const text = pdfData.text;

                if (!text || text.length < 50) {
                    await bot.sendMessage(chatId, '❌ الملف لا يحتوي على نص قابل للقراءة (ربما يكون صوراً).');
                } else {
                    // D. إبلاغ المستخدم وتحويل المهمة لـ GAS
                    await bot.editMessageText('🤖 تم إرسال النص للذكاء الاصطناعي...\n✨ ستصلك النتائج والأزرار تلقائياً خلال دقيقة.', { chat_id: chatId, message_id: msg.message_id });
                    
                    // نرسل البيانات لـ GAS (بما في ذلك fileId لتقرير الأدمن)
                    await sendToGasAndForget({
                        action: 'analyze_async',
                        text: text,
                        chatId: chatId,
                        userId: user.id,
                        userName: userName,
                        fileId: fileId // 👈 هام جداً لكي يرسل GAS الملف للأدمن
                    });
                }
            } catch (err) {
                console.error("PDF Error:", err);
                await bot.sendMessage(chatId, '❌ حدث خطأ أثناء معالجة الملف.');
            }
        }

        // =========================================================
        // 2️⃣ التعامل مع الأزرار (Callbacks)
        // =========================================================
        else if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;
            const data = cb.data; 
            const userId = cb.from.id;

            // البيانات تأتي من GAS بالصيغة: cmd_send|count|model|target
            
            if (data.startsWith('cmd_send')) {
                const parts = data.split('|');
                const count = parts[1];
                const model = parts[2];
                const target = parts[3];

                if (target === 'here') {
                    await bot.answerCallbackQuery(cb.id, { text: '🚀 تم البدء...' });
                    await bot.sendMessage(chatId, `⏳ جاري إرسال ${count} سؤال الآن...`);

                    // A. تسجيل الاستهلاك الفعلي في Supabase
                    await logUsage(userId, count, model, 'executed');

                    // B. أمر التنفيذ لـ GAS
                    await sendToGasAndForget({
                        action: 'execute_send',
                        userId: userId,
                        targetChatId: chatId,
                        chatType: 'private'
                    });
                } 
                else if (target === 'chan') {
                    // حفظ الحالة لانتظار معرف القناة
                    global.userState[userId] = { step: 'awaiting_channel', count, model };
                    await bot.answerCallbackQuery(cb.id);
                    await bot.sendMessage(chatId, '📝 أرسل معرف القناة (ID) أو المعرف العام (@channel) الآن:');
                }
            }
        }

        // =========================================================
        // 3️⃣ استلام معرف القناة (إذا اختار المستخدم ذلك)
        // =========================================================
        else if (update.message && update.message.text) {
             const userId = update.message.from.id;
             const chatId = update.message.chat.id;
             const text = update.message.text.trim();

             if (global.userState[userId] && global.userState[userId].step === 'awaiting_channel') {
                 const { count, model } = global.userState[userId];
                 
                 await bot.sendMessage(chatId, `🚀 تم التوجيه للقناة (${text})...`);
                 
                 // تسجيل الاستهلاك
                 await logUsage(userId, count, model, 'executed_channel');

                 // أمر التنفيذ لـ GAS
                 await sendToGasAndForget({
                    action: 'execute_send',
                    userId: userId,
                    targetChatId: text, // معرف القناة
                    chatType: 'channel'
                });
                
                // مسح الحالة
                delete global.userState[userId];
             }
        }

    } catch (e) { console.error("General Error:", e); }
    
    // إنهاء الطلب فوراً (Important for Vercel)
    res.status(200).send('OK');
};
