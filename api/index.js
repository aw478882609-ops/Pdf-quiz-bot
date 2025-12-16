// ==== كود Vercel الكامل (api/index.js) - Version 12.0 (Controller Only) ====

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

// إعدادات البوت
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL; // رابط مشروع GAS

// ذاكرة مؤقتة (Global Cache) لحفظ النصوص ريثما يختار المستخدم الوجهة
if (!global.userState) {
    global.userState = {};
}

// وضع الصيانة
if (global.isMaintenanceMode === undefined) {
    global.isMaintenanceMode = false;
}

// دالة مساعدة لإرسال البيانات إلى Google Apps Script
// نستخدم timeout قصير (1000ms) لأننا لا نريد انتظار انتهاء GAS من التحليل (الذي يستغرق دقائق)
// نريد فقط التأكد من أن GAS استلم الطلب.
async function sendToGasAndForget(payload) {
    try {
        await axios.post(GAS_WEB_APP_URL, payload, { timeout: 1500 });
        console.log("✅ Request sent to GAS");
    } catch (error) {
        // نتجاهل خطأ Timeout لأن هذا هو المطلوب (أن نغلق الاتصال بسرعة)
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            console.log("✅ Request sent to GAS (Connection closed early as planned)");
        } else {
            console.error("❌ Failed to send to GAS:", error.message);
        }
    }
}

module.exports = async (req, res) => {
    try {
        if (req.method !== 'POST') {
            return res.status(405).send('Method Not Allowed');
        }
        const body = await micro.json(req);
        
        // التعامل مع التحديثات (Updates)
        const update = body;

        // =========================================================
        // 🔧 أوامر الصيانة (للأدمن فقط)
        // =========================================================
        if (update.message && update.message.text) {
            const userId = String(update.message.from.id);
            const text = update.message.text.trim();
            if (userId === ADMIN_CHAT_ID) {
                if (text === '/repairon') {
                    global.isMaintenanceMode = true;
                    await bot.sendMessage(userId, '🛠️ تم تفعيل وضع الصيانة.');
                    return res.status(200).send('Maintenance ON');
                }
                if (text === '/repairoff') {
                    global.isMaintenanceMode = false;
                    await bot.sendMessage(userId, '✅ تم إيقاف وضع الصيانة.');
                    return res.status(200).send('Maintenance OFF');
                }
            }
        }

        // 🚧 فحص وضع الصيانة
        if (global.isMaintenanceMode && String(update.message?.from?.id) !== ADMIN_CHAT_ID) {
            if (update.message) await bot.sendMessage(update.message.chat.id, '⚠️ البوت في وضع الصيانة حالياً.');
            return res.status(200).send('Maintenance Active');
        }

        // =========================================================
        // 1️⃣ استلام ملف PDF واستخراج النص
        // =========================================================
        if (update.message && update.message.document) {
            const chatId = update.message.chat.id;
            const fileId = update.message.document.file_id;
            const mimeType = update.message.document.mime_type;
            const fileSize = update.message.document.file_size;

            // التحقق من الصيغة والحجم (أقل من 20 ميجا لضمان سرعة التحميل)
            if (mimeType !== 'application/pdf') {
                await bot.sendMessage(chatId, '❌ يرجى إرسال ملف PDF فقط.');
                return res.status(200).send('OK');
            }
            if (fileSize > 20 * 1024 * 1024) {
                await bot.sendMessage(chatId, '❌ حجم الملف كبير جداً (أكبر من 20MB).');
                return res.status(200).send('OK');
            }

            const processingMsg = await bot.sendMessage(chatId, '⏳ جاري تحميل الملف واستخراج النص...');

            try {
                // تحميل الملف
                const fileLink = await bot.getFileLink(fileId);
                const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                
                // استخراج النص
                const pdfData = await pdf(Buffer.from(response.data));
                const extractedText = pdfData.text;

                // التحقق من وجود نص
                if (!extractedText || extractedText.trim().length < 50) {
                    await bot.deleteMessage(chatId, processingMsg.message_id);
                    await bot.sendMessage(chatId, '❌ النص في الملف قصير جداً أو عبارة عن صور (Scanned PDF). يرجى إرسال ملف يحتوي على نصوص قابلة للنسخ.');
                } else {
                    // ✅ تم الاستخراج بنجاح -> حفظ في الذاكرة المؤقتة
                    global.userState[chatId] = { 
                        text: extractedText,
                        fileName: update.message.document.file_name
                    };

                    await bot.deleteMessage(chatId, processingMsg.message_id);
                    
                    const keyboard = {
                        inline_keyboard: [
                            [{ text: 'إرسال هنا 📤', callback_data: 'send_here' }],
                            [{ text: 'إرسال لقناة 📢', callback_data: 'send_to_channel' }]
                        ]
                    };

                    await bot.sendMessage(chatId, 
                        `✅ تم استخراج النص بنجاح!\n📏 الطول: ${extractedText.length} حرف.\n\nالآن اختر أين تريد إرسال الأسئلة بعد التحليل:`, 
                        { reply_markup: keyboard }
                    );
                }

            } catch (error) {
                console.error("PDF Error:", error);
                await bot.deleteMessage(chatId, processingMsg.message_id);
                await bot.sendMessage(chatId, '❌ حدث خطأ أثناء قراءة الملف. تأكد أن الملف سليم.');
            }
        }

        // =========================================================
        // 2️⃣ التعامل مع الأزرار (اختيار الوجهة)
        // =========================================================
        else if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;
            const data = cb.data;
            const user = cb.from;

            // التحقق من وجود النص في الذاكرة
            if (!global.userState[chatId] || !global.userState[chatId].text) {
                await bot.answerCallbackQuery(cb.id, { text: '⚠️ انتهت الجلسة، يرجى إرسال الملف مرة أخرى.', show_alert: true });
                return res.status(200).send('OK');
            }

            if (data === 'send_here') {
                await bot.answerCallbackQuery(cb.id);
                
                // إرسال رسالة انتظار سيتم تحديثها لاحقاً بواسطة GAS
                const statusMsg = await bot.sendMessage(chatId, '🚀 تم إرسال البيانات للسيرفر الرئيسي (GAS)...\n⏳ سيبدأ التحليل والإرسال تلقائياً خلال لحظات.');
                
                // إعداد البيانات لـ GAS
                const payload = {
                    action: 'analyze_and_send',
                    text: global.userState[chatId].text,
                    targetChatId: chatId,
                    originalChatId: chatId,
                    chatType: 'private',
                    closePolls: false, // افتراضي
                    userName: `${user.first_name} ${user.last_name || ''}`.trim(),
                    userId: user.id,
                    messageId: statusMsg.message_id // نرسل رقم الرسالة ليقوم GAS بتحديثها
                };

                // إرسال للـ Backend (بدون انتظار طويل)
                await sendToGasAndForget(payload);

                // تنظيف الذاكرة
                delete global.userState[chatId];
            } 
            else if (data === 'send_to_channel') {
                await bot.answerCallbackQuery(cb.id);
                global.userState[chatId].step = 'awaiting_channel_id';
                await bot.sendMessage(chatId, '📝 أرسل الآن معرف القناة أو المجموعة (ID) التي تريد الإرسال إليها:\nمثال: -100123456789');
            }
        }

        // =========================================================
        // 3️⃣ استلام معرف القناة (إذا اختار المستخدم ذلك)
        // =========================================================
        else if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();
            const user = update.message.from;

            // إذا كان المستخدم في خطوة انتظار القناة
            if (global.userState[chatId] && global.userState[chatId].step === 'awaiting_channel_id') {
                const targetId = text;

                // تحقق بسيط من صحة المعرف
                if (!targetId.startsWith('-100') && !targetId.startsWith('@')) {
                    await bot.sendMessage(chatId, '⚠️ معرف غير صالح. يجب أن يبدأ بـ -100 للأرقام أو @ للمعلقات العامة.');
                    return res.status(200).send('OK');
                }

                // إرسال رسالة تأكيد
                const statusMsg = await bot.sendMessage(chatId, `🚀 تم توجيه الطلب للقناة (${targetId})...\n⏳ سيبدأ السيرفر بالتحليل والإرسال هناك.`);

                const payload = {
                    action: 'analyze_and_send',
                    text: global.userState[chatId].text,
                    targetChatId: targetId,
                    originalChatId: chatId, // التقارير ترسل هنا
                    chatType: 'channel',
                    closePolls: false,
                    userName: `${user.first_name} ${user.last_name || ''}`.trim(),
                    userId: user.id,
                    messageId: statusMsg.message_id
                };

                await sendToGasAndForget(payload);
                delete global.userState[chatId];
            }
        }

    } catch (error) {
        console.error("General Vercel Error:", error);
    }

    res.status(200).send('OK');
};
