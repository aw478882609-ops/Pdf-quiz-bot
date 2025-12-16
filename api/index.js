// =========================================================
// 🎮 Vercel Controller - Version 25.0 (Admin Fix & Debug)
// Features: Correct Admin Detection in Maintenance | Logs
// =========================================================

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

// ⚙️ الإعدادات
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// 🧠 الذاكرة المؤقتة
if (!global.userState) global.userState = {};
if (global.isMaintenanceMode === undefined) global.isMaintenanceMode = false;

// =========================================================
// 🗄️ دوال Supabase
// =========================================================
async function upsertUser(user) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/users`, {
            telegram_id: user.id,
            full_name: `${user.first_name} ${user.last_name || ''}`.trim(),
            username: user.username || null,
            last_active: new Date().toISOString()
        }, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' } });
    } catch (e) { console.error("Supabase Error:", e.message); }
}

async function logUsage(userId, count, model, status = 'success') {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/usage_logs`, {
            telegram_id: userId, questions_count: parseInt(count), model: model, status: status, created_at: new Date().toISOString()
        }, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' } });
    } catch (e) {}
}

// =========================================================
// ⚡ دالة الاتصال بـ GAS
// =========================================================
async function sendToGasAndForget(payload) {
    console.log(`📡 [Vercel -> GAS] Sending action: ${payload.action} for User: ${payload.userId}`);
    try {
        // نستخدم timeout قصير
        await axios.post(GAS_WEB_APP_URL, payload, { timeout: 2000 });
        console.log("✅ [Vercel] Data sent to GAS.");
    } catch (error) {
        if (error.code !== 'ECONNABORTED' && !error.message.includes('timeout')) {
            console.error("❌ [Vercel Error] Connection to GAS failed:", error.message);
        } else {
            console.log("✅ [Vercel] Handed off to GAS (Async).");
        }
    }
}

// =========================================================
// 🎮 المعالج الرئيسي
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

        // 🛠️ أوامر الصيانة (للأدمن حصراً)
        if (msg && msg.text && userId === ADMIN_CHAT_ID) {
            const txt = msg.text.trim();
            if (txt === '/repairon') { 
                global.isMaintenanceMode = true; 
                await bot.sendMessage(ADMIN_CHAT_ID, '🛠️ <b>تم تفعيل وضع الصيانة.</b>\n(أنت كأدمن يمكنك الاستخدام، الآخرون لا)', {parse_mode: 'HTML'}); 
                return res.status(200).send('ON'); 
            }
            if (txt === '/repairoff') { 
                global.isMaintenanceMode = false; 
                await bot.sendMessage(ADMIN_CHAT_ID, '✅ <b>تم إيقاف وضع الصيانة.</b>', {parse_mode: 'HTML'}); 
                return res.status(200).send('OFF'); 
            }
        }

        // 🚧 التحقق من الصيانة (الآن يعمل بشكل صحيح مع الأزرار)
        if (global.isMaintenanceMode && userId !== ADMIN_CHAT_ID) {
             const chatId = msg?.chat?.id || cb?.message?.chat?.id;
             if (chatId && !cb) { // نرد برسالة فقط إذا لم يكن زر (لتجنب التنبيهات المزعجة)
                 await bot.sendMessage(chatId, '⚠️ <b>البوت في وضع الصيانة حالياً.</b>', {parse_mode: 'HTML'});
             } else if (cb) {
                 await bot.answerCallbackQuery(cb.id, { text: '⚠️ البوت في الصيانة.', show_alert: true });
             }
             return res.status(200).send('Maintenance Block');
        }

        // =========================================================
        // 1️⃣ استلام الملف (PDF)
        // =========================================================
        if (msg && msg.document) {
            const chatId = msg.chat.id;
            const fileId = msg.document.file_id;
            
            if (msg.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '❌ PDF Only.'); return res.status(200).send('OK');
            }

            // تسجيل وإرسال
            await upsertUser(fromUser);
            await logUsage(userId, 0, 'file_upload', 'processing');
            
            const waitMsg = await bot.sendMessage(chatId, '⏳ جاري المعالجة...');

            try {
                const fileLink = await bot.getFileLink(fileId);
                const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                const pdfData = await pdf(Buffer.from(response.data));
                const text = pdfData.text;

                if (!text || text.length < 50) {
                    await bot.sendMessage(chatId, '❌ ملف غير مقروء.');
                } else {
                    await bot.editMessageText('🤖 جاري التحليل (AI)...', { chat_id: chatId, message_id: waitMsg.message_id });
                    
                    await sendToGasAndForget({
                        action: 'analyze_async',
                        text: text,
                        chatId: chatId,
                        userId: userId,
                        userName: fromUser.first_name,
                        fileId: fileId
                    });
                }
            } catch (err) {
                console.error(err);
                await bot.sendMessage(chatId, '❌ خطأ في الملف.');
            }
        }

        // =========================================================
        // 2️⃣ الأزرار (Callback Query)
        // =========================================================
        else if (cb) {
            const chatId = cb.message.chat.id;
            const data = cb.data; 

            if (data.startsWith('cmd_send')) {
                const parts = data.split('|');
                const count = parts[1];
                const model = parts[2];
                const uniqueKey = parts[3];
                const target = parts[4];

                if (target === 'here') {
                    await bot.answerCallbackQuery(cb.id, { text: '🚀 جاري التنفيذ...' });
                    await bot.sendMessage(chatId, `⚡ <b>جاري إرسال ${count} سؤال...</b>`, {parse_mode: 'HTML'});
                    await logUsage(userId, count, model, 'executed');

                    await sendToGasAndForget({
                        action: 'execute_send',
                        userId: userId,
                        targetChatId: chatId,
                        chatType: 'private',
                        sessionKey: uniqueKey
                    });
                } 
                else if (target === 'chan') {
                    global.userState[userId] = { step: 'awaiting_channel', count, model, sessionKey: uniqueKey };
                    await bot.answerCallbackQuery(cb.id);
                    await bot.sendMessage(chatId, '📝 أرسل معرف القناة:');
                }
            }
        }

        // =========================================================
        // 3️⃣ معرف القناة
        // =========================================================
        else if (msg && msg.text && global.userState[userId]?.step === 'awaiting_channel') {
             const chatId = msg.chat.id;
             const text = msg.text.trim();
             const { count, model, sessionKey } = global.userState[userId];

             await bot.sendMessage(chatId, `🚀 توجيه للقناة...`);
             await logUsage(userId, count, model, 'executed_channel');

             await sendToGasAndForget({
                action: 'execute_send',
                userId: userId,
                targetChatId: text,
                chatType: 'channel',
                sessionKey: sessionKey
            });
            delete global.userState[userId];
        }

    } catch (e) { console.error("Vercel Error:", e); }
    res.status(200).send('OK');
};
