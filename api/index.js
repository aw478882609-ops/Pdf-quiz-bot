// =========================================================
// 🎮 Vercel Controller - Version 30.0 (Updated for Instant Solve)
// Features: Send & Solve Support | Full User Info | Supabase | Async Trigger
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
// ملاحظة: في بيئة Vercel (Serverless) هذه الذاكرة قد تُمسح عند إعادة تشغيل الحاويات،
// لكنها كافية لعملية "انتظار معرف القناة" التي تستغرق ثواني.
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
    // نستخدم Timeout قصير جداً (1500ms)
    // الهدف: تسليم البيانات لـ GAS وإغلاق اتصال Vercel فوراً
    // GAS سيكمل العمل في الخلفية
    try {
        await axios.post(GAS_WEB_APP_URL, payload, { timeout: 1500 });
    } catch (error) {
        // نتجاهل أخطاء الوقت (Timeout) لأن هذا هو المطلوب
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

        // 🕵️ استخراج معرف المستخدم بشكل صحيح (سواء كان رسالة أو زر)
        const msg = update.message;
        const cb = update.callback_query;
        const fromUser = msg?.from || cb?.from;
        const userId = fromUser?.id ? String(fromUser.id) : null;

        // 🛠️ إدارة وضع الصيانة (للأدمن فقط)
        if (msg && msg.text && userId === ADMIN_CHAT_ID) {
            const txt = msg.text.trim();
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

        // 🚧 التحقق من الصيانة (يمنع المستخدمين، يسمح للأدمن)
        if (global.isMaintenanceMode && userId !== ADMIN_CHAT_ID) {
             const chatId = msg?.chat?.id || cb?.message?.chat?.id;
             
             // نرد برسالة إذا كانت محادثة، ونرد بتنبيه منبثق إذا كان زر
             if (chatId && !cb) {
                 await bot.sendMessage(chatId, '⚠️ <b>عذراً، البوت في وضع الصيانة حالياً.</b>', {parse_mode: 'HTML'});
             } else if (cb) {
                 await bot.answerCallbackQuery(cb.id, { text: '⚠️ البوت في وضع الصيانة.', show_alert: true });
             }
             return res.status(200).send('Maintenance Active');
        }

        // =========================================================
        // 1️⃣ استلام الملف (PDF Handling)
        // =========================================================
        if (msg && msg.document) {
            const chatId = msg.chat.id;
            const fileId = msg.document.file_id;
            const userName = `${fromUser.first_name} ${fromUser.last_name || ''}`.trim();
            
            if (msg.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '❌ <b>ملفات PDF فقط.</b>', {parse_mode: 'HTML'}); 
                return res.status(200).send('OK');
            }

            // A. تسجيل المستخدم
            await upsertUser(fromUser);

            // B. تسجيل العملية (Status: Processing)
            await logUsage(userId, 0, 'file_upload', 'processing');

            const waitMsg = await bot.sendMessage(chatId, '⏳ <b>جاري استلام الملف...</b>', {parse_mode: 'HTML'});

            try {
                // C. استخراج النص
                const fileLink = await bot.getFileLink(fileId);
                const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                const pdfData = await pdf(Buffer.from(response.data));
                const text = pdfData.text;

                if (!text || text.length < 50) {
                    await bot.sendMessage(chatId, '❌ <b>الملف لا يحتوي على نص قابل للقراءة.</b>', {parse_mode: 'HTML'});
                } else {
                    await bot.editMessageText('🤖 <b>يتم الآن التحليل بواسطة الذكاء الاصطناعي...</b>\n\n✨ ستظهر النتائج تلقائياً خلال دقائق.', { 
                        chat_id: chatId, 
                        message_id: waitMsg.message_id, 
                        parse_mode: 'HTML' 
                    });
                    
                    // D. إرسال لـ GAS (Async Payload)
                    await sendToGasAndForget({
                        action: 'analyze_async',
                        text: text,
                        chatId: chatId,
                        userId: userId,
                        userName: userName,
                        userUsername: fromUser.username, // إرسال المعرف لتقارير الأدمن
                        fileId: fileId // لتمكين GAS من إرسال الملف للأدمن عند الفشل
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
        else if (cb) {
            const chatId = cb.message.chat.id;
            const data = cb.data; 

            // تحليل البيانات من الزر (تم إنشاؤه بواسطة GAS)
            // الصيغة المتوقعة: cmd_send | count | model | uniqueKey | target
            // target قد يكون: 'here', 'here_close', 'chan', 'chan_close'
            
            if (data.startsWith('cmd_send')) {
                const parts = data.split('|');
                const count = parts[1];
                const model = parts[2];
                const uniqueKey = parts[3]; // 🔥 المفتاح الفريد
                const targetRaw = parts[4]; // الهدف الخام

                // ✅ استخراج منطق الإغلاق (Send & Solve)
                const closePolls = targetRaw.includes('close'); 
                const target = targetRaw.replace('_close', ''); // توحيد الهدف ليصبح 'here' أو 'chan'

                if (target === 'here') {
                    // رسالة تفاعلية بسيطة
                    const modeText = closePolls ? " (وحلها)" : "";
                    await bot.answerCallbackQuery(cb.id, { text: `🚀 جاري البدء${modeText}...` });
                    await bot.sendMessage(chatId, `⚡ <b>جاري إرسال ${count} سؤال...</b>`, {parse_mode: 'HTML'});

                    // تسجيل الاستهلاك
                    await logUsage(userId, count, model, 'executed');

                    // إرسال أمر التنفيذ لـ GAS
                    await sendToGasAndForget({
                        action: 'execute_send',
                        userId: userId,
                        targetChatId: chatId,
                        chatType: 'private',
                        sessionKey: uniqueKey, // 👈 تمرير المفتاح
                        closePolls: closePolls // 👈 تمرير خيار الإغلاق الفوري
                    });
                } 
                else if (target === 'chan') {
                    // تخزين الحالة مؤقتاً
                    global.userState[userId] = { 
                        step: 'awaiting_channel', 
                        count, model, 
                        sessionKey: uniqueKey,
                        closePolls: closePolls // 👈 حفظ خيار الإغلاق
                    };
                    await bot.answerCallbackQuery(cb.id);
                    await bot.sendMessage(chatId, '📝 <b>أرسل معرف القناة أو المجموعة الآن:</b>\nمثال: @ChannelName', {parse_mode: 'HTML'});
                }
            }
        }

        // =========================================================
        // 3️⃣ استلام معرف القناة
        // =========================================================
        else if (msg && msg.text && global.userState[userId]?.step === 'awaiting_channel') {
             const chatId = msg.chat.id;
             const text = msg.text.trim();
             
             // استرجاع البيانات المحفوظة بما فيها closePolls
             const { count, model, sessionKey, closePolls } = global.userState[userId];

             // التحقق البسيط
             if (!text.startsWith('@') && !text.startsWith('-100')) {
                await bot.sendMessage(chatId, '⚠️ معرف غير صالح (يجب أن يبدأ بـ @ أو -100).');
                return res.status(200).send('OK');
             }

             const modeText = closePolls ? " (وضع الحل الفوري)" : "";
             await bot.sendMessage(chatId, `🚀 <b>جاري التوجيه للقناة (${text})${modeText}...</b>`, {parse_mode: 'HTML'});
             
             // تسجيل الاستهلاك
             await logUsage(userId, count, model, 'executed_channel');

             // تنفيذ عبر GAS
             await sendToGasAndForget({
                action: 'execute_send',
                userId: userId,
                targetChatId: text,
                chatType: 'channel',
                sessionKey: sessionKey,
                closePolls: closePolls // 👈 تمرير خيار الإغلاق
            });
            
            // مسح الحالة
            delete global.userState[userId];
        }

    } catch (e) { console.error("General Error:", e); }
    
    // إنهاء الطلب دائماً بـ 200 لتجنب إعادة المحاولة من تيليجرام
    res.status(200).send('OK');
};
