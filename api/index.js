// =========================================================
// 🎮 Vercel Controller - Version 20.0 (Full & Uncut)
// Features: Supabase Logging | Async GAS Trigger | Maintenance Mode
// =========================================================

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

// ⚙️ تحميل المتغيرات البيئية
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

// إعدادات Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// 🧠 الذاكرة المؤقتة (للحفاظ على حالة القنوات ووضع الصيانة)
// نستخدم global للحفاظ على البيانات بين الطلبات في بيئة Serverless (قدر الإمكان)
if (!global.userState) global.userState = {};
if (global.isMaintenanceMode === undefined) global.isMaintenanceMode = false;

// =========================================================
// 🗄️ دوال Supabase (Database Layer)
// =========================================================

/**
 * تسجيل أو تحديث بيانات المستخدم في جدول users
 */
async function upsertUser(user) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    
    try {
        const payload = {
            telegram_id: user.id,
            full_name: `${user.first_name} ${user.last_name || ''}`.trim(),
            username: user.username || null,
            last_active: new Date().toISOString()
        };

        await axios.post(`${SUPABASE_URL}/rest/v1/users`, payload, {
            headers: { 
                'apikey': SUPABASE_KEY, 
                'Authorization': `Bearer ${SUPABASE_KEY}`, 
                'Content-Type': 'application/json', 
                'Prefer': 'resolution=merge-duplicates' // تحديث إذا كان موجوداً
            }
        });
        console.log(`✅ [Supabase] User ${user.id} synced.`);
    } catch (e) { 
        console.error("❌ [Supabase Error] Upsert User:", e.message); 
    }
}

/**
 * تسجيل سجل الاستخدام في جدول usage_logs
 */
async function logUsage(userId, questionCount, modelName, status = 'success') {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    
    try {
        const payload = {
            telegram_id: userId,
            questions_count: parseInt(questionCount) || 0,
            model: modelName || 'unknown',
            status: status,
            created_at: new Date().toISOString()
        };

        await axios.post(`${SUPABASE_URL}/rest/v1/usage_logs`, payload, {
            headers: { 
                'apikey': SUPABASE_KEY, 
                'Authorization': `Bearer ${SUPABASE_KEY}`, 
                'Content-Type': 'application/json' 
            }
        });
        console.log(`✅ [Supabase] Usage logged: ${status}`);
    } catch (e) { 
        console.error("❌ [Supabase Error] Log Usage:", e.message); 
    }
}

// =========================================================
// ⚡ دالة الاتصال بـ Google Apps Script (Fire & Forget)
// =========================================================

/**
 * ترسل البيانات لـ GAS وتغلق الاتصال فوراً لتجنب انتظار الرد
 */
async function sendToGasAndForget(payload) {
    // نستخدم Timeout قصير جداً (1500ms)
    // الهدف هو التأكد من خروج الطلب من Vercel، ولا يهمنا استقبال الرد هنا
    // لأن GAS سيرسل الرد مباشرة للمستخدم عبر Telegram API
    try {
        await axios.post(GAS_WEB_APP_URL, payload, { timeout: 1500 });
        console.log("🚀 [GAS] Payload sent.");
    } catch (error) {
        // نتجاهل أخطاء الوقت (ECONNABORTED) لأن هذا هو السلوك المطلوب
        if (error.code !== 'ECONNABORTED' && !error.message.includes('timeout')) {
            console.error("❌ [GAS Error] Connection failed:", error.message);
        } else {
            console.log("🚀 [GAS] Payload sent (Connection closed early).");
        }
    }
}

// =========================================================
// 🎮 المعالج الرئيسي (Main Request Handler)
// =========================================================
module.exports = async (req, res) => {
    try {
        // التحقق من طريقة الطلب
        if (req.method !== 'POST') {
            return res.status(405).send('Method Not Allowed');
        }

        // قراءة محتوى الطلب (Update Object)
        const update = await micro.json(req);

        // ---------------------------------------------------------
        // 🛠️ إدارة وضع الصيانة (Maintenance Mode) - للأدمن فقط
        // ---------------------------------------------------------
        if (update.message && update.message.text) {
            const userId = String(update.message.from.id);
            const text = update.message.text.trim();

            if (userId === ADMIN_CHAT_ID) {
                if (text === '/repairon') {
                    global.isMaintenanceMode = true;
                    await bot.sendMessage(ADMIN_CHAT_ID, '🔴 <b>تم تفعيل وضع الصيانة.</b>\nلن يتم استقبال ملفات جديدة.', {parse_mode: 'HTML'});
                    return res.status(200).send('Maintenance ON');
                }
                if (text === '/repairoff') {
                    global.isMaintenanceMode = false;
                    await bot.sendMessage(ADMIN_CHAT_ID, '🟢 <b>تم إيقاف وضع الصيانة.</b>\nالبوت يعمل الآن بشكل طبيعي.', {parse_mode: 'HTML'});
                    return res.status(200).send('Maintenance OFF');
                }
            }
        }

        // منع المستخدمين العاديين أثناء الصيانة
        if (global.isMaintenanceMode && String(update.message?.from?.id) !== ADMIN_CHAT_ID) {
            if (update.message) {
                await bot.sendMessage(update.message.chat.id, '⚠️ <b>عذراً، البوت في وضع الصيانة حالياً.</b>\nيرجى المحاولة لاحقاً.', {parse_mode: 'HTML'});
            }
            return res.status(200).send('Maintenance Active');
        }

        // =========================================================
        // 1️⃣ استلام الملفات (PDF Handling)
        // =========================================================
        if (update.message && update.message.document) {
            const chatId = update.message.chat.id;
            const fileId = update.message.document.file_id;
            const user = update.message.from;
            const userName = `${user.first_name} ${user.last_name || ''}`.trim();
            const mimeType = update.message.document.mime_type;

            // التحقق من نوع الملف
            if (mimeType !== 'application/pdf') {
                await bot.sendMessage(chatId, '❌ يرجى إرسال ملفات بصيغة <b>PDF</b> فقط.', {parse_mode: 'HTML'});
                return res.status(200).send('OK');
            }

            // A. تسجيل المستخدم في Supabase
            await upsertUser(user);

            // B. تسجيل محاولة المعالجة (Status: Processing)
            await logUsage(user.id, 0, 'file_upload', 'processing');

            // إرسال رسالة انتظار
            const processingMsg = await bot.sendMessage(chatId, '⏳ <b>جاري استلام الملف واستخراج النص...</b>', {parse_mode: 'HTML'});

            try {
                // C. تحميل الملف واستخراج النص
                const fileLink = await bot.getFileLink(fileId);
                const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                const pdfData = await pdf(Buffer.from(response.data));
                const extractedText = pdfData.text;

                // التحقق من صحة النص
                if (!extractedText || extractedText.trim().length < 50) {
                    await bot.sendMessage(chatId, '❌ <b>لم يتم العثور على نص كافٍ.</b>\nتأكد أن الملف ليس عبارة عن صور (Scanned PDF).', {parse_mode: 'HTML'});
                } else {
                    // D. تحديث الرسالة وتحويل المهمة لـ GAS
                    await bot.editMessageText('🤖 <b>يتم الآن التحليل بواسطة الذكاء الاصطناعي...</b>\n\n✨ ستصلك النتائج والأزرار تلقائياً خلال لحظات.', { 
                        chat_id: chatId, 
                        message_id: processingMsg.message_id,
                        parse_mode: 'HTML'
                    });
                    
                    // إرسال Payload إلى GAS (Async)
                    // نرسل fileId لتمكين GAS من إرسال الملف للأدمن في حال الفشل
                    const gasPayload = {
                        action: 'analyze_async',
                        text: extractedText,
                        chatId: chatId,
                        userId: user.id,
                        userName: userName,
                        fileId: fileId 
                    };

                    await sendToGasAndForget(gasPayload);
                }

            } catch (err) {
                console.error("❌ [PDF Processing Error]", err);
                await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء قراءة الملف. يرجى المحاولة مرة أخرى.');
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

            // تحليل البيانات القادمة من الزر (التي أنشأها GAS)
            // الصيغة المتوقعة: cmd_send|count|model|target
            
            if (data.startsWith('cmd_send')) {
                const parts = data.split('|');
                const count = parts[1]; // عدد الأسئلة
                const model = parts[2]; // اسم النموذج المختصر
                const target = parts[3]; // الوجهة (here او chan)

                if (target === 'here') {
                    // الرد الفوري لتجنب التحميل المستمر للزر
                    await bot.answerCallbackQuery(cb.id, { text: '🚀 جاري بدء الإرسال...' });
                    
                    await bot.sendMessage(chatId, `⚡ <b>جاري إرسال ${count} سؤال بسرعة قصوى...</b>`, {parse_mode: 'HTML'});

                    // A. تسجيل الاستهلاك الفعلي في Supabase (Status: Executed)
                    await logUsage(userId, count, model, 'executed');

                    // B. إرسال أمر التنفيذ لـ GAS
                    const executionPayload = {
                        action: 'execute_send',
                        userId: userId,
                        targetChatId: chatId,
                        chatType: 'private'
                    };

                    await sendToGasAndForget(executionPayload);
                } 
                else if (target === 'chan') {
                    // حفظ البيانات مؤقتاً لانتظار معرف القناة
                    global.userState[userId] = { 
                        step: 'awaiting_channel_id', 
                        count: count, 
                        model: model 
                    };

                    await bot.answerCallbackQuery(cb.id);
                    await bot.sendMessage(chatId, '📝 <b>أرسل معرف القناة أو المجموعة الآن:</b>\nمثال: @ChannelName أو -100123456789', {parse_mode: 'HTML'});
                }
            }
        }

        // =========================================================
        // 3️⃣ استلام معرف القناة (User Input)
        // =========================================================
        else if (update.message && update.message.text) {
             const userId = update.message.from.id;
             const chatId = update.message.chat.id;
             const text = update.message.text.trim();

             // التحقق مما إذا كان المستخدم في خطوة انتظار معرف القناة
             if (global.userState[userId] && global.userState[userId].step === 'awaiting_channel_id') {
                 const { count, model } = global.userState[userId];
                 
                 // التحقق البسيط من صيغة المعرف
                 if (!text.startsWith('@') && !text.startsWith('-100')) {
                     await bot.sendMessage(chatId, '⚠️ <b>معرف غير صالح.</b> يرجى التأكد من المعرف وإعادة المحاولة.', {parse_mode: 'HTML'});
                     return res.status(200).send('OK');
                 }

                 await bot.sendMessage(chatId, `🚀 <b>جاري توجيه الأسئلة للقناة (${text})...</b>`, {parse_mode: 'HTML'});
                 
                 // A. تسجيل الاستهلاك (Status: Executed Channel)
                 await logUsage(userId, count, model, 'executed_channel');

                 // B. إرسال أمر التنفيذ لـ GAS
                 const executionPayload = {
                    action: 'execute_send',
                    userId: userId,
                    targetChatId: text, // معرف القناة المستهدف
                    chatType: 'channel'
                };

                await sendToGasAndForget(executionPayload);
                
                // تنظيف الحالة
                delete global.userState[userId];
             }
        }

    } catch (error) {
        console.error("💥 [General Error]", error);
    }
    
    // إنهاء الطلب دائماً بـ 200 OK لتيليجرام
    res.status(200).send('OK');
};
