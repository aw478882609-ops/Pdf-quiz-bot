// ==== بداية كود Vercel الكامل (api/index.js) - Version 17.0 (Maintenance Notify + No Custom Timeout) ====

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');
const { createClient } = require('@supabase/supabase-js');

// تهيئة البوت
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
const userState = {};

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// تهيئة Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; 
const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
});

// دالة مساعدة للتأخير
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =================================================================
// 🗄️ دوال قاعدة البيانات (Supabase Helpers)
// =================================================================

async function registerUser(user) {
    if (!user || !user.id) return;
    const { error } = await supabase
        .from('users')
        .upsert({
            user_id: user.id,
            first_name: user.first_name || '',
            username: user.username || '',
            last_active: new Date().toISOString()
        }, { onConflict: 'user_id' });
    if (error) console.error("Register Error:", error.message);
}

async function checkMaintenanceMode() {
    try {
        const { data } = await supabase.from('bot_config').select('value').eq('key', 'maintenance_mode').single();
        return data?.value === true;
    } catch (e) { return false; }
}

async function setMaintenanceMode(status) {
    await supabase.from('bot_config').upsert({ key: 'maintenance_mode', value: status });
}

async function logProcessing(data) {
    try {
        await supabase.from('processing_logs').insert({
            user_id: data.userId,
            file_id: data.fileId,
            status: data.status,
            method: data.method,
            model_used: data.modelUsed || null,
            questions_count: data.questionsCount || 0,
            processing_time_ms: data.timeMs || 0,
            error_reason: data.errorReason || null
        });
    } catch (e) { console.error("Logging Error:", e.message); }
}

async function getGlobalStats() {
    const today = new Date().toISOString().split('T')[0];
    const getCount = async (table, filter = null) => {
        let query = supabase.from(table).select('*', { count: 'exact', head: true });
        if (filter) query = filter(query);
        const { count } = await query;
        return count || 0;
    };

    const totalUsers = await getCount('users');
    const activeToday = await getCount('users', q => q.gte('last_active', today));
    const totalFiles = await getCount('processing_logs');
    const totalSuccess = await getCount('processing_logs', q => q.eq('status', 'success'));
    const filesToday = await getCount('processing_logs', q => q.gte('created_at', today));
    const successToday = await getCount('processing_logs', q => q.gte('created_at', today).eq('status', 'success'));
    const aiFlashToday = await getCount('processing_logs', q => q.gte('created_at', today).eq('model_used', 'gemini-2.5-flash'));
    const aiGemmaToday = await getCount('processing_logs', q => q.gte('created_at', today).eq('model_used', 'gemma-3-27b-it'));
    const regexToday = await getCount('processing_logs', q => q.gte('created_at', today).ilike('method', '%regex%'));
    const failedToday = filesToday - successToday;
    
    const successRateTotal = totalFiles > 0 ? ((totalSuccess / totalFiles) * 100).toFixed(1) : 0;
    const successRateToday = filesToday > 0 ? ((successToday / filesToday) * 100).toFixed(1) : 0;

    return `📊 **الإحصائيات العامة:**\n\n` +
           `👥 المستخدمين: ${totalUsers} (نشط اليوم: ${activeToday})\n` +
           `📁 الملفات الكلية: ${totalFiles} (نجاح: ${successRateTotal}%)\n\n` +
           `📅 **اليوم:**\n` +
           `• معالجة: ${filesToday}\n` +
           `• نجاح: ${successToday} (${successRateToday}%)\n` +
           `• فشل: ${failedToday}\n` +
           `----------------\n` +
           `🤖 **التوزيع:**\n` +
           `Flash: ${aiFlashToday} | Gemma: ${aiGemmaToday} | Regex: ${regexToday}`;
}

async function getUserStats(targetId) {
    const { data: user } = await supabase.from('users').select('*').eq('user_id', targetId).single();
    if (!user) return `❌ المستخدم غير موجود.`;

    const getCount = async (filter = null) => {
        let query = supabase.from('processing_logs').select('*', { count: 'exact', head: true }).eq('user_id', targetId);
        if (filter) query = filter(query);
        const { count } = await query;
        return count || 0;
    };

    const total = await getCount();
    const success = await getCount(q => q.eq('status', 'success'));
    const failed = total - success;
    const rate = total > 0 ? ((success / total) * 100).toFixed(1) : 0;

    return `👤 **تقرير المستخدم:**\n${user.first_name} (${user.username || 'No User'})\nID: \`${user.user_id}\`\n\n📂 **الملفات:**\n• الكل: ${total}\n• نجاح: ${success}\n• فشل: ${failed}\n• النسبة: ${rate}%`;
}

// =================================================================
// 🔔 دالة الإشعار للأدمن
// =================================================================
async function sendAdminNotification(status, user, fileId, details = '', method = 'غير محدد ❓') {
  if (String(user.id) === ADMIN_CHAT_ID) return;
  if (!ADMIN_CHAT_ID) return;

  const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  const userUsername = user.username ? `@${user.username}` : 'لا يوجد';
   
  let captionText = `🔔 إشعار معالجة ملف 🔔\n\n`;
  captionText += `الحالة: ${status}\n`;
  captionText += `🛠️ الطريقة: ${method}\n\n`; 
  captionText += `👤 المستخدم: ${userName} (${userUsername})\n`;
  captionText += `🆔 ID: ${user.id}\n\n`;
   
  if (details) {
    captionText += `📝 تفاصيل:\n${details}\n`;
  }

  try {
    // إذا لم يكن هناك fileId (مثل حالة الصيانة)، نرسل رسالة نصية فقط
    if (fileId) {
        await bot.sendDocument(ADMIN_CHAT_ID, fileId, { caption: captionText });
    } else {
        await bot.sendMessage(ADMIN_CHAT_ID, `🚨 تنبيه إداري:\n\n${captionText}`);
    }
  } catch (error) {
    console.error("Admin Notify Error:", error.message);
    try { await bot.sendMessage(ADMIN_CHAT_ID, captionText); } catch (e) {}
  }
}

// =================================================================
// ⚙️ المعالج الرئيسي (Main Handler)
// =================================================================
module.exports = async (req, res) => {
    try {
        if (req.method !== 'POST') {
            return res.status(405).send('Method Not Allowed');
        }
        const body = await micro.json(req);
        const update = body;

        // 🛡️ حماية التكرار بالوقت
        if (update.message && update.message.date) {
            const timeDiff = Math.floor(Date.now() / 1000) - update.message.date;
            if (timeDiff > 20) return res.status(200).send('Stale request ignored.');
        }

        // تسجيل المستخدم
        if (update.message && update.message.from) {
            await registerUser(update.message.from);
        }

        // --- أوامر الأدمن ---
        if (update.message && update.message.text) {
            const text = update.message.text.trim();
            const userId = String(update.message.from.id);

            if (userId === ADMIN_CHAT_ID) {
                if (text === '/repairon') {
                    await setMaintenanceMode(true);
                    await bot.sendMessage(userId, '🔴 تم تفعيل وضع الصيانة.');
                    return res.status(200).send('Maintenance ON');
                }
                if (text === '/repairoff') {
                    await setMaintenanceMode(false);
                    await bot.sendMessage(userId, '🟢 تم إيقاف وضع الصيانة.');
                    return res.status(200).send('Maintenance OFF');
                }
                if (text === '/stats') {
                    const statsMsg = await getGlobalStats();
                    await bot.sendMessage(userId, statsMsg, { parse_mode: 'Markdown' });
                    return res.status(200).send('Stats Sent');
                }
                if (text.startsWith('/user ')) {
                    const targetId = text.split(' ')[1];
                    if (targetId) {
                        const userReport = await getUserStats(targetId);
                        await bot.sendMessage(userId, userReport, { parse_mode: 'Markdown' });
                    }
                    return res.status(200).send('User Report Sent');
                }
            }
        }

        // --- فحص وضع الصيانة ---
        const isMaintenance = await checkMaintenanceMode();
        const userId = update.message ? String(update.message.from.id) : null;

        if (isMaintenance && userId !== ADMIN_CHAT_ID) {
            if (update.message) {
                // إبلاغ المستخدم
                await bot.sendMessage(update.message.chat.id, '⚠️ البوت في وضع الصيانة حالياً للتحديثات.\n\nيرجى المحاولة لاحقاً. ⏳');
                
                // 🔥 تنبيه الأدمن بمحاولة الوصول
                if (update.message.document) {
                    await sendAdminNotification(
                        'محاولة في الصيانة 🚧', 
                        update.message.from, 
                        null, // لا نرسل الملف للأدمن لتوفير الباندويث
                        'تم منع المستخدم من المعالجة لأن وضع الصيانة مفعل.', 
                        'Maintenance Block'
                    );
                }
            }
            if (update.callback_query) {
                await bot.answerCallbackQuery(update.callback_query.id, { text: '⚠️ البوت في الصيانة.', show_alert: true });
            }
            return res.status(200).send('Maintenance Mode Active');
        }

        // 1️⃣ معالجة ملفات PDF
        if (update.message && update.message.document) {
            const message = update.message;
            const chatId = message.chat.id;
            const user = message.from;
            const fileId = message.document.file_id;
            const uniqueRequestId = `${fileId}_${update.update_id}`;
            const startTime = Date.now();

            // منع التكرار اللحظي
            if (!global.processingFiles) global.processingFiles = new Set();
            if (global.processingFiles.has(uniqueRequestId)) {
                await bot.sendMessage(chatId, '⚙️ الملف قيد المعالجة بالفعل، انتظر قليلاً...');
                return res.status(200).send('Duplicate ignored.');
            }
            global.processingFiles.add(uniqueRequestId);

            let adminNotificationStatus = '';
            let adminNotificationDetails = '';
            let extractionMethodReport = 'جاري التحليل...'; 
            
            let logData = {
                userId: user.id,
                fileId: fileId,
                status: 'pending',
                method: 'unknown',
                modelUsed: null,
                questionsCount: 0,
                timeMs: 0,
                errorReason: null
            };

            const VERCEL_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB
            if (message.document.file_size > VERCEL_LIMIT_BYTES) {
                await bot.sendMessage(chatId, `⚠️ حجم الملف كبير (${(message.document.file_size / 1024 / 1024).toFixed(2)} MB). الحد الأقصى 10 MB.`);
                adminNotificationStatus = 'ملف مرفوض 🐘';
                adminNotificationDetails = 'السبب: تجاوز الحجم المسموح.';
                logData.status = 'rejected_size';
                logData.errorReason = 'File too large';
                await logProcessing(logData);
                global.processingFiles.delete(uniqueRequestId);
            } else if (message.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '⚠️ يرجى إرسال ملف بصيغة PDF فقط.');
                adminNotificationStatus = 'ملف مرفوض 📄';
                adminNotificationDetails = `السبب: الصيغة ${message.document.mime_type} غير مدعومة.`;
                logData.status = 'rejected_type';
                logData.errorReason = 'Not a PDF';
                await logProcessing(logData);
                global.processingFiles.delete(uniqueRequestId);
            } else {
                const waitingMsg = await bot.sendMessage(chatId, '⏳ استلمت الملف.. جاري التحميل والتحليل..');
                let patienceTimer = null;

                try {
                    const fileLink = await bot.getFileLink(fileId);
                    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                    const pdfData = await pdf(Buffer.from(response.data));
                    console.log(`📏 Chars: ${pdfData.text.length}`);

                    patienceTimer = setTimeout(async () => {
                        try { await bot.sendMessage(chatId, '✋ الملف دسم! ما زلت أعمل عليه، شكراً لصبرك 🌹'); } catch (e) {}
                    }, 120000); 

                    // ✅✅✅ إلغاء مؤقت الـ 295 ثانية - الاستدعاء المباشر ✅✅✅
                    // الآن البوت سيستمر حتى ينهي Vercel حياته قسراً (Execution Timeout)
                    const extractionResult = await extractQuestions(pdfData.text);
                    
                    clearTimeout(patienceTimer);

                    const questions = extractionResult.questions;
                    extractionMethodReport = extractionResult.method; 
                    adminNotificationDetails = extractionResult.adminDetails || 'تفاصيل غير متوفرة'; 

                    // تحديث بيانات السجل
                    logData.method = extractionResult.method;
                    logData.questionsCount = questions.length;
                    logData.timeMs = Date.now() - startTime;
                    
                    if (extractionResult.method.includes('Flash 2.5')) logData.modelUsed = 'gemini-2.5-flash';
                    else if (extractionResult.method.includes('Gemma 3')) logData.modelUsed = 'gemma-3-27b-it';
                    else if (extractionResult.method.includes('Regex')) logData.method = 'regex';

                    if (questions.length > 0) {
                        userState[user.id] = { questions: questions };
                        const keyboard = {
                            inline_keyboard: [
                                [{ text: 'إرسال هنا 📤', callback_data: 'send_here' }],
                                [{ text: 'إرسال وإغلاق هنا 🔒', callback_data: 'send_and_close_here'}],
                                [{ text: 'إرسال لقناة/مجموعة 📢', callback_data: 'send_to_channel' }]
                            ]
                        };
                        
                       const successMsg = `✅ تم العثور على ${questions.length} سؤالًا.\n\n` +
                                          `🧠 المعالج: ${extractionMethodReport}\n\n` +
                                          `اختر وجهة الإرسال:`;
                       
                        try { await bot.deleteMessage(chatId, waitingMsg.message_id); } catch(e){}

                        await bot.sendMessage(chatId, successMsg, { parse_mode: 'Markdown', reply_markup: keyboard });
                        adminNotificationStatus = 'نجاح ✅';
                        logData.status = 'success';

                    } else {
                        try { await bot.deleteMessage(chatId, waitingMsg.message_id); } catch(e){}
                        
                        logData.status = 'failed';

                        // 🛑 التعامل مع النصوص القصيرة
                        if (extractionResult.failureReport === "SHORT_TEXT") {
                            const shortTextMsg = 
                                `❌ **عذراً، لم أجد نصوصاً كافية في هذا الملف!**\n\n` +
                                `يبدو أن الملف يحتوي على **صور ممسوحة ضوئياً (Scanned)** أو نصوص غير قابلة للنسخ.\n\n` +
                                `💡 **الحل:** تأكد أنك تستطيع تحديد ونسخ النص من الملف بنفسك قبل إرساله.`;
                            
                            await bot.sendMessage(chatId, shortTextMsg, { parse_mode: 'Markdown' });
                            
                            adminNotificationStatus = 'فشل (نص قصير/صور) 🖼️';
                            logData.errorReason = 'Short Text (<50 chars) - Scanned PDF?';
                            logData.status = 'rejected_content';
                        } else {
                            const failMessage = `❌ لم أتمكن من استخراج أسئلة.\n\n` +
                                                `📋 التقرير:\n` + 
                                                `➖ ${extractionMethodReport}`; 
                            await bot.sendMessage(chatId, failMessage);
                            adminNotificationStatus = 'فشل (0 أسئلة) ❌';
                            logData.errorReason = extractionResult.adminDetails || 'No questions found';
                        }
                    }

                } catch (error) {
                    console.error("Error:", error);
                    if (patienceTimer) clearTimeout(patienceTimer);
                    try { await bot.deleteMessage(chatId, waitingMsg.message_id); } catch(e){}

                    logData.status = 'failed';
                    logData.timeMs = Date.now() - startTime;

                    await bot.sendMessage(chatId, '⚠️ حدث خطأ تقني أثناء المعالجة.');
                    adminNotificationStatus = 'فشل (Error) 💥';
                    extractionMethodReport = 'Error (خطأ تقني) 💥';
                    adminNotificationDetails = error.message;
                    logData.errorReason = error.message;
                    logData.method = 'error';
                    
                } finally {
                    await logProcessing(logData);
                    global.processingFiles.delete(uniqueRequestId);
                }
            }

            if (adminNotificationStatus) {
                await sendAdminNotification(adminNotificationStatus, user, fileId, adminNotificationDetails, extractionMethodReport);
            }
        }

        // 2️⃣ التعامل مع الاختبارات (Polls)
        else if (update.message && update.message.poll) {
            const message = update.message;
            const poll = message.poll;
            if (poll.type !== 'quiz') return res.status(200).send('OK');

            const chatId = message.chat.id;
            const userId = message.from.id;
            const quizData = {
                question: poll.question,
                options: poll.options.map(opt => opt.text),
                correctOptionId: poll.correct_option_id,
                explanation: poll.explanation || null
            };

            if (message.forward_date) {
                if (quizData.correctOptionId !== null && quizData.correctOptionId >= 0) {
                    const formattedText = formatQuizText(quizData);
                    await bot.sendMessage(chatId, formattedText, { reply_to_message_id: message.message_id });
                } else {
                    if (!userState[userId] || !userState[userId].pending_polls) {
                        userState[userId] = { pending_polls: {} };
                    }
                    const previewText = formatQuizText({ ...quizData, correctOptionId: null });
                    const promptText = `${previewText}\n\n*يرجى تحديد الإجابة الصحيحة:*`;
                    const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
                    const keyboardButtons = quizData.options.map((option, index) => ({
                        text: optionLetters[index] || (index + 1),
                        callback_data: `poll_answer_${index}`
                    }));
                    const interactiveMessage = await bot.sendMessage(chatId, promptText, {
                        parse_mode: 'Markdown',
                        reply_to_message_id: message.message_id,
                        reply_markup: { inline_keyboard: [keyboardButtons] }
                    });
                    userState[userId].pending_polls[interactiveMessage.message_id] = quizData;
                }
            } else {
                if (quizData.correctOptionId !== null && quizData.correctOptionId >= 0) {
                    const formattedText = formatQuizText(quizData);
                    await bot.sendMessage(chatId, formattedText);
                } else {
                    await bot.sendMessage(chatId, "⚠️ هذا الاختبار لا يحتوي على إجابة صحيحة.");
                }
            }
        }

        // 3️⃣ التعامل مع الأزرار (Callbacks)
        else if (update.callback_query) {
             const callbackQuery = update.callback_query;
             const userId = callbackQuery.from.id;
             const chatId = callbackQuery.message.chat.id;
             const messageId = callbackQuery.message.message_id;
             const data = callbackQuery.data;
             const gasWebAppUrl = process.env.GAS_WEB_APP_URL;
 
             if (data.startsWith('poll_answer_')) {
                 if (!userState[userId] || !userState[userId].pending_polls || !userState[userId].pending_polls[messageId]) {
                     await bot.answerCallbackQuery(callbackQuery.id, { text: 'الجلسة انتهت.', show_alert: true });
                     return res.status(200).send('OK');
                 }
                 const poll_data = userState[userId].pending_polls[messageId];
                 poll_data.correctOptionId = parseInt(data.split('_')[2], 10);
                 const formattedText = formatQuizText(poll_data);
                 await bot.editMessageText(formattedText, { chat_id: chatId, message_id: messageId });
                 delete userState[userId].pending_polls[messageId];
                 await bot.answerCallbackQuery(callbackQuery.id);
             }
             else {
                 if (!userState[userId] || !userState[userId].questions) {
                     await bot.answerCallbackQuery(callbackQuery.id, { text: 'انتهت الجلسة، أعد الإرسال.', show_alert: true });
                     return res.status(200).send('OK');
                 }
                 if (!gasWebAppUrl) {
                     await bot.editMessageText('⚠️ خطأ: رابط الخادم غير موجود.', { chat_id: chatId, message_id: messageId });
                     return res.status(200).send('OK');
                 }
                 
                 if (data === 'send_here' || data === 'send_and_close_here') {
                     const { questions } = userState[userId];
                     const shouldClose = data === 'send_and_close_here';
                     const payload = { questions, targetChatId: chatId, originalChatId: chatId, startIndex: 0, chatType: 'private', closePolls: shouldClose };
                     axios.post(gasWebAppUrl, payload).catch(err => console.error("GAS Error:", err.message));
                     await bot.answerCallbackQuery(callbackQuery.id);
                     await bot.editMessageText(`✅ تم الإرسال (${questions.length} سؤال).`, { chat_id: chatId, message_id: messageId });
                     delete userState[userId];
                 } else if (data === 'send_to_channel') {
                     userState[userId].awaiting = 'channel_id';
                     await bot.answerCallbackQuery(callbackQuery.id);
                     await bot.editMessageText('أرسل معرف القناة/المجموعة (ID) الآن.', { chat_id: chatId, message_id: messageId });
                 } else if (data.startsWith('confirm_send')) {
                     if (userState[userId] && userState[userId].awaiting === 'send_confirmation') {
                         const { questions, targetChatId, targetChatTitle, chatType } = userState[userId];
                         const shouldClose = data.endsWith('_and_close');
                         const payload = { questions, targetChatId, originalChatId: chatId, startIndex: 0, chatType, closePolls: shouldClose };
                         axios.post(gasWebAppUrl, payload).catch(err => console.error("GAS Error:", err.message));
                         await bot.answerCallbackQuery(callbackQuery.id);
                         await bot.editMessageText(`✅ تم الإرسال إلى "${targetChatTitle}".`, { chat_id: chatId, message_id: messageId });
                         delete userState[userId];
                     }
                 } else if (data === 'cancel_send') {
                     await bot.answerCallbackQuery(callbackQuery.id);
                     await bot.editMessageText('❌ تم الإلغاء.', { chat_id: chatId, message_id: messageId });
                     delete userState[userId];
                 }
             }
        }
        
        // 4️⃣ التعامل مع الرسائل النصية
        else if (update.message && update.message.text) {
            const message = update.message;
            const chatId = message.chat.id;
            const text = message.text;
            const userId = message.from.id;

            if (['/repairon', '/repairoff', '/stats'].includes(text) || text.startsWith('/user')) return res.status(200).send('OK');

            if (text.toLowerCase() === '/help') {
                const fileId = 'BQACAgQAAxkBAAE72dRo2-EHmbty7PivB2ZsIz1WKkAXXgAC5BsAAtF24VLmLAPbHKW4IDYE';
                await bot.sendDocument(chatId, fileId, { caption: 'دليل الاستخدام 📖' });
            }
            else if (userState[userId] && userState[userId].awaiting === 'channel_id') {
                 const targetChatId = text.trim();
                 try {
                     const chatInfo = await bot.getChat(targetChatId);
                     const botMember = await bot.getChatMember(targetChatId, (await bot.getMe()).id);
                     let canProceed = false;
                     if (['administrator', 'creator'].includes(botMember.status) && botMember.can_post_messages) {
                         canProceed = true;
                     }
                     if (canProceed) {
                         userState[userId] = {
                             ...userState[userId],
                             awaiting: 'send_confirmation',
                             targetChatId: chatInfo.id,
                             targetChatTitle: chatInfo.title,
                             chatType: chatInfo.type
                         };
                         const confirmationKeyboard = { 
                             inline_keyboard: [
                                 [{ text: '✅ إرسال', callback_data: 'confirm_send' }],
                                 [{ text: '🔒 إرسال وإغلاق', callback_data: 'confirm_send_and_close' }],
                                 [{ text: '❌ إلغاء', callback_data: 'cancel_send' }]
                             ] 
                         };
                         await bot.sendMessage(chatId, `الهدف: ${chatInfo.title}\nعدد الأسئلة: ${userState[userId].questions.length}\nهل تؤكد الإرسال؟`, { reply_markup: confirmationKeyboard });
                     } else {
                         await bot.sendMessage(chatId, `⚠️ البوت ليس مشرفاً أو لا يملك صلاحية النشر.`);
                     }
                 } catch (error) {
                     await bot.sendMessage(chatId, '❌ فشل! تأكد من المعرف وصلاحيات البوت.');
                 }
            }
        }
    } catch (error) {
        console.error("General error:", error);
    }
    res.status(200).send('OK');
};

// =================================================================
// ✨✨ === منطق الاستخراج الذكي === ✨✨
// =================================================================

async function extractQuestions(text) {
    let questions = [];
    let failureReason = '';

    // 1️⃣ الذكاء الاصطناعي
    if (text && text.trim().length > 50) {
        console.log("Attempting AI extraction...");
        try {
            const aiResult = await extractWithAI(text);
            return { 
                questions: aiResult.questions, 
                method: `AI 🤖 (${aiResult.modelDisplay})`,
                adminDetails: `✅ النجاح باستخدام:\n- النموذج: ${aiResult.modelDisplay}\n- المفتاح: Key #${aiResult.keyIndex}`
            };
        } catch (error) {
            console.error("AI failed completely.");
            failureReason = error.message.replace("Report: ", "");
        }
    } else {
        // نص قصير
        return { 
            questions: [], 
            method: 'مرفوض (صور/قصير)',
            failureReport: 'SHORT_TEXT',
            adminDetails: 'تم رفض الملف: نص قصير جداً (<50 حرف). غالباً صور ممسوحة (Scanned PDF).'
        };
    }

    // 2️⃣ Regex
    console.log("Falling back to Regex...");
    try {
        questions = extractWithRegex(text);
        if (questions.length > 0) {
            return { 
                questions: questions, 
                method: `Regex 🧩 (فشل AI: ${failureReason})`,
                adminDetails: `⚠️ تم استخدام Regex.\nسبب فشل AI: ${failureReason}`
            };
        }
    } catch (e) { console.error("Regex failed:", e); }

    return { 
        questions: [], 
        method: 'فشل تام ❌',
        adminDetails: `❌ فشل الجميع.\nAI: ${failureReason}\nRegex: Failed`
    };
}

async function extractWithAI(text) {
    const keysRaw = process.env.GEMINI_API_KEY || '';
    const keys = keysRaw.split(',').map(k => k.trim()).filter(k => k);
    
    if (keys.length === 0) throw new Error("Report: No Keys");

    const modelsToTry = [
        { 
            id: 'gemini-2.5-flash', 
            apiVersion: 'v1', 
            displayText: 'Flash 2.5 (الأساسي - الأقوى 🚀)' 
        },
        { 
            id: 'gemma-3-27b-it', 
            apiVersion: 'v1beta', 
            displayText: 'Gemma 3 (الاحتياطي - الأضعف 🛡️)' 
        }
    ];

    const prompt = `
    Analyze the following text and extract all multiple-choice questions.
    For each question, provide:
    1. The question number as a string (e.g., "1", "Q2", "٣"), if it exists.
    2. The full question text.
    3. A list of all possible options.
    4. The index of the correct answer (starting from 0).
    5. The explanation for the answer, if one is provided in the text.
    VERY IMPORTANT: Respond ONLY with a valid JSON array of objects. Each object should have these exact keys: "question", "options", "correctAnswerIndex", and optionally "questionNumber" and "explanation". The "questionNumber" key should only be present if a number is explicitly found next to the question in the source text. Do not include any text or markdown formatting outside the JSON array.
    Example Response Format:
    [
      {
        "questionNumber": "1",
        "question": "What is the capital of France?",
        "options": ["Berlin", "Madrid", "Paris", "Rome"],
        "correctAnswerIndex": 2,
        "explanation": "Paris is the capital and most populous city of France."
      },
      {
        "questionNumber": "Q2",
        "question": "Which planet is known as the Red Planet?",
        "options": ["Earth", "Mars", "Jupiter", "Venus"],
        "correctAnswerIndex": 1
      }
    ]
    Text:
    ---
    ${text}
    ---
    `;

    const payload = { contents: [{ parts: [{ text: prompt }] }] };
    let failLogs = [];

    for (const model of modelsToTry) {
        console.log(`\n🔵 Trying Model: ${model.id}`);
        
        let quotaCount = 0;
        let notFoundCount = 0;
        let busyCount = 0;
        let parseErrorCount = 0;
        let otherErrorCount = 0;

        for (let i = 0; i < keys.length; i++) {
            const apiKey = keys[i];
            const url = `https://generativelanguage.googleapis.com/${model.apiVersion}/models/${model.id}:generateContent?key=${apiKey}`;

            try {
                const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });

                if (!response.data.candidates || response.data.candidates.length === 0) {
                     console.log(`❌ Key #${i+1}: Empty Response`);
                     parseErrorCount++;
                     continue;
                }

                const aiResponseText = response.data.candidates[0].content.parts[0].text;
                const cleanedJsonString = aiResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
                
                try {
                    let parsedQuestions = JSON.parse(cleanedJsonString);
                    if (Array.isArray(parsedQuestions) && parsedQuestions.length > 0) {
                        const valid = parsedQuestions.every(q => q.question && Array.isArray(q.options) && q.correctAnswerIndex !== undefined);
                        if (valid) {
                            console.log(`✅ Success: ${model.id} | Key #${i+1}`);
                            
                            parsedQuestions.forEach(q => {
                                if (q.questionNumber) {
                                    q.question = `${q.questionNumber}) ${q.question}`;
                                    delete q.questionNumber;
                                }
                            });

                            return { 
                                questions: parsedQuestions, 
                                modelDisplay: model.displayText, 
                                keyIndex: i + 1 
                            };
                        } else {
                            console.log(`❌ Key #${i+1}: JSON Valid but missing keys`);
                            parseErrorCount++;
                        }
                    } else {
                        parseErrorCount++;
                    }
                } catch (e) {
                    console.log(`❌ Key #${i+1}: JSON Parse Error`);
                    parseErrorCount++;
                }

            } catch (error) {
                const status = error.response ? error.response.status : 0;
                
                if (status === 429) quotaCount++;
                else if (status === 404) notFoundCount++;
                else if (status === 503) busyCount++;
                else otherErrorCount++;
                
                console.error(`❌ ${model.id} | Key #${i+1} | Status: ${status}`);
                
                if (i < keys.length - 1) await delay(1000);
            }
        } 

        let reason = '';
        if (quotaCount === keys.length) reason = 'الرصيد انتهى (Quota) 📉';
        else if (notFoundCount === keys.length) reason = 'النموذج غير موجود ❌';
        else if (busyCount > 0 && (busyCount + quotaCount === keys.length)) reason = 'السيرفر مشغول (Busy) 🛑';
        else if (parseErrorCount > 0) reason = 'فشل التحليل (هلوسة AI) 🥴';
        else reason = 'أخطاء اتصال/غير معروفة ⚠️';
        
        failLogs.push(`${model.id}: ${reason}`);
    }

    throw new Error(`Report: ${failLogs.join(' + ')}`);
}

function extractWithRegex(text) {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\f/g, '\n').replace(/\u2028|\u2029/g, '\n').replace(/\n{2,}/g, '\n');
    const lines = text.split('\n').map(l => l.trim());
    const questions = [];
    let i = 0;
    const questionPatterns = [/^(Q|Question|Problem|Quiz|السؤال)?\s*\d+[\s\.\)\]\-\ـ]/];
    const letterOptionPatterns = [/^\s*[\-\*]?\s*([A-Z])[\.\)\-:]\s*(.+)/i, /^\s*([A-Z])\s*-\s*(.+)/i, /^\s*[\(\[\{]([A-Z])[\)\]\}]\s*(.+)/i];
    const numberOptionPatterns = [/^\s*[\-\*]?\s*(\d+)[\.\)\-:]\s*(.+)/, /^\s*(\d+)\s*-\s*(.+)/, /^\s*[\(\[\{](\d+)[\)\]\}]\s*(.+)/];
    const romanOptionPatterns = [/^\s*([IVXLCDM]+)[\.\)\-]\s*(.+)/i];
    const optionPatterns = [...letterOptionPatterns, ...numberOptionPatterns, ...romanOptionPatterns];
    const answerPatterns = [/^\s*[\-\*]?\s*(Answer|Correct Answer|Solution|Ans|Sol)\s*[:\-\.,;\/]?\s*/i];
    function findMatch(line, patterns) { for (const pattern of patterns) { const match = line.match(pattern); if (match) return match; } return null; }
    function romanToNumber(roman) { const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }; let num = 0; for (let i = 0; i < roman.length; i++) { const current = map[roman[i].toUpperCase()]; const next = i + 1 < roman.length ? map[roman[i + 1].toUpperCase()] : 0; if (next > current) num -= current; else num += current; } return num; }
    function validateOptionsSequence(optionLines) { if (optionLines.length < 2) return true; let style = null; let lastValue = null; for (let j = 0; j < optionLines.length; j++) { const line = optionLines[j]; let currentStyle = null, currentValue = null, identifier = ''; if (findMatch(line, numberOptionPatterns)) { currentStyle = 'numbers'; identifier = findMatch(line, numberOptionPatterns)[1]; currentValue = parseInt(identifier, 10); } else if (findMatch(line, letterOptionPatterns)) { currentStyle = 'letters'; identifier = findMatch(line, letterOptionPatterns)[1].toUpperCase(); currentValue = identifier.charCodeAt(0); } else if (findMatch(line, romanOptionPatterns)) { currentStyle = 'roman'; identifier = findMatch(line, romanOptionPatterns)[1].toUpperCase(); currentValue = romanToNumber(identifier); } else { return false; } if (j === 0) { style = currentStyle; lastValue = currentValue; } else { if (currentStyle !== style || currentValue !== lastValue + 1) return false; lastValue = currentValue; } } return true; }
    while (i < lines.length) { const line = lines[i]; if (!line) { i++; continue; } const optionInFollowingLines = lines.slice(i + 1, i + 6).some(l => findMatch(l, optionPatterns)); const isQuestionStart = findMatch(line, questionPatterns) || (optionInFollowingLines && !findMatch(line, optionPatterns) && !findMatch(line, answerPatterns)); if (!isQuestionStart) { i++; continue; } let questionText = line; let potentialOptionsIndex = i + 1; let j = i + 1; while (j < lines.length && !findMatch(lines[j], optionPatterns) && !findMatch(lines[j], answerPatterns)) { questionText += ' ' + lines[j].trim(); potentialOptionsIndex = j + 1; j++; } if (potentialOptionsIndex < lines.length && findMatch(lines[potentialOptionsIndex], optionPatterns)) { const currentQuestion = { question: questionText.trim(), options: [], correctAnswerIndex: undefined }; let k = potentialOptionsIndex; const optionLines = []; while (k < lines.length) { const optLine = lines[k]; if (!optLine || findMatch(optLine, answerPatterns)) break; const optionMatch = findMatch(optLine, optionPatterns); if (optionMatch) { optionLines.push(optLine); currentQuestion.options.push(optionMatch[2].trim()); k++; } else { break; } } if (!validateOptionsSequence(optionLines)) { i++; continue; } if (k < lines.length && findMatch(lines[k], answerPatterns)) { const answerLine = lines[k]; let answerText = answerLine.replace(answerPatterns[0], '').trim(); let correctIndex = -1; const cleanAnswerText = answerText.replace(/^[A-Z\dIVXLCDM]+[\.\)]\s*/i, '').trim(); correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === cleanAnswerText.toLowerCase()); if (correctIndex === -1) { const identifierMatch = answerText.match(/^[A-Z\dIVXLCDM]+/i); if (identifierMatch) { const firstOptionLine = optionLines[0]; if(findMatch(firstOptionLine, numberOptionPatterns)) correctIndex = parseInt(identifierMatch[0], 10) - 1; else if(findMatch(firstOptionLine, letterOptionPatterns)) correctIndex = identifierMatch[0].toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0); else if(findMatch(firstOptionLine, romanOptionPatterns)) correctIndex = romanToNumber(identifierMatch[0].toUpperCase()) - 1; } } if (correctIndex >= 0 && correctIndex < currentQuestion.options.length) currentQuestion.correctAnswerIndex = correctIndex; i = k + 1; } else { i = k; } if (currentQuestion.options.length > 1 && currentQuestion.correctAnswerIndex !== undefined) questions.push(currentQuestion); } else { i++; } }
    return questions;
}

function formatQuizText(quizData) {
    let formattedText = ` ${quizData.question}\n\n`;
    const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const formattedOptions = quizData.options.map((optionText, optIndex) => `${optionLetters[optIndex]}) ${optionText}`);
    formattedText += formattedOptions.join('\n');
    if (quizData.correctOptionId !== null && quizData.correctOptionId >= 0) {
        const correctLetter = optionLetters[quizData.correctOptionId];
        const correctText = quizData.options[quizData.correctOptionId];
        formattedText += `\n\nAnswer: ${correctLetter}) ${correctText}`;
    }
    if (quizData.explanation) formattedText += `\nExplanation: ${quizData.explanation}`;
    return formattedText;
                }
