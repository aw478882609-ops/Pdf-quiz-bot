// =========================================================
// 🎮 Vercel Controller - Version 34.0 (URL-Based Handover)
// Features: Sends File URL to GAS | No Size Limits | Light Payload
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

if (!global.userState) global.userState = {};
if (global.isMaintenanceMode === undefined) global.isMaintenanceMode = false;

// --- دوال المساعدة (Supabase & GAS) ---
async function upsertUser(user) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        await axios.post(`${SUPABASE_URL}/rest/v1/users`, {
            telegram_id: user.id,
            full_name: `${user.first_name} ${user.last_name || ''}`.trim(),
            username: user.username || null,
            last_active: new Date().toISOString()
        }, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' } });
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
        }, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' } });
    } catch (e) { console.error("Supabase Log Error:", e.message); }
}

async function sendToGasAndForget(payload) {
    try {
        // لم نعد نحتاج مهلة طويلة لأن البيانات المرسلة صغيرة جداً (مجرد رابط)
        await axios.post(GAS_WEB_APP_URL, payload, { timeout: 1000 });
    } catch (error) {
        if (error.code !== 'ECONNABORTED' && !error.message.includes('timeout')) {
            console.error("GAS Connection Error:", error.message);
        }
    }
}

// --- المعالج الرئيسي ---
module.exports = async (req, res) => {
    try {
        if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
        const update = await micro.json(req);

        const msg = update.message;
        const cb = update.callback_query;
        const fromUser = msg?.from || cb?.from;
        const userId = fromUser?.id ? String(fromUser.id) : null;

        // وضع الصيانة
        if (msg && msg.text && userId === ADMIN_CHAT_ID) {
            if (msg.text.trim() === '/repairon') { global.isMaintenanceMode = true; await bot.sendMessage(ADMIN_CHAT_ID, '🛠️ ON'); return res.status(200).send('ON'); }
            if (msg.text.trim() === '/repairoff') { global.isMaintenanceMode = false; await bot.sendMessage(ADMIN_CHAT_ID, '✅ OFF'); return res.status(200).send('OFF'); }
        }
        if (global.isMaintenanceMode && userId !== ADMIN_CHAT_ID) {
             if (msg) await bot.sendMessage(msg.chat.id, '⚠️ الصيانة مفعلة.');
             else if (cb) await bot.answerCallbackQuery(cb.id, { text: '⚠️ الصيانة مفعلة.', show_alert: true });
             return res.status(200).send('Maintenance');
        }

        // 1️⃣ استلام الملف (PDF)
        if (msg && msg.document) {
            const chatId = msg.chat.id;
            const fileId = msg.document.file_id;
            const userName = `${fromUser.first_name} ${fromUser.last_name || ''}`.trim();
            
            if (msg.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '❌ <b>ملفات PDF فقط.</b>', {parse_mode: 'HTML'}); 
                return res.status(200).send('OK');
            }

            await upsertUser(fromUser);
            await logUsage(userId, 0, 'file_upload', 'processing_url');

            const waitMsg = await bot.sendMessage(chatId, '⏳ <b>جاري تحويل الملف للمعالجة...</b>', {parse_mode: 'HTML'});

            try {
                // 🔥 التغيير الجوهري: نحصل على الرابط ونرسله لـ GAS ليقوم هو بالتحميل
                const fileLink = await bot.getFileLink(fileId);

                await bot.editMessageText('🤖 <b>يتم الآن التحميل والتحليل بواسطة Google...</b>\n\n🚀 هذه الطريقة أسرع للملفات الكبيرة.', { 
                    chat_id: chatId, 
                    message_id: waitMsg.message_id, 
                    parse_mode: 'HTML' 
                });
                
                // إرسال الرابط فقط (Payload خفيف جداً)
                await sendToGasAndForget({
                    action: 'analyze_async',
                    fileUrl: fileLink, // 👈 نرسل الرابط بدلاً من الملف
                    chatId: chatId,
                    userId: userId,
                    userName: userName,
                    userUsername: fromUser.username,
                    fileId: fileId
                });

            } catch (err) {
                console.error("PDF Link Error:", err);
                await bot.sendMessage(chatId, '❌ حدث خطأ أثناء تجهيز الملف.');
            }
        }

        // 2️⃣ الأزرار (Callback Queries)
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
                    await logUsage(userId, count, model, 'executed');

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
