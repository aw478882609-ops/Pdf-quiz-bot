// ==== بداية كود Vercel الكامل والصحيح (api/index.js) ====

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

// تهيئة البوت
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
const userState = {};

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// دالة مساعدة للتأخير (لتجنب الحظر السريع بين المحاولات)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/*
 * دالة لإرسال إشعار للمشرف (لا ترسل شيئًا إذا كان المستخدم هو المشرف نفسه).
 */
async function sendAdminNotification(status, user, fileId, details = '', method = 'غير محدد ❓') {
  if (String(user.id) === ADMIN_CHAT_ID) {
    console.log("User is the admin. Skipping self-notification.");
    return; 
  }

  if (!ADMIN_CHAT_ID) {
    console.log("ADMIN_CHAT_ID is not set. Skipping notification.");
    return;
  }

  const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  const userUsername = user.username ? `@${user.username}` : 'لا يوجد';
   
  let captionText = `🔔 إشعار معالجة ملف 🔔\n\n`;
  captionText += `الحالة: ${status}\n`;
  captionText += `🛠️ الطريقة: ${method}\n\n`;
  captionText += `من المستخدم: ${userName} (${userUsername})\n`;
  captionText += `ID المستخدم: ${user.id}\n\n`;
   
  if (details) {
    // تقليم التفاصيل الطويلة جداً لتجنب رفض تليجرام للرسالة
    const safeDetails = details.length > 900 ? details.substring(0, 900) + '\n... (تم قص الباقي)' : details;
    captionText += `📝 تفاصيل: ${safeDetails}\n`;
  }

  try {
    await bot.sendDocument(ADMIN_CHAT_ID, fileId, { caption: captionText });
  } catch (error) {
    console.error("Failed to send document notification to admin:", error.message);
    try {
        await bot.sendMessage(ADMIN_CHAT_ID, `⚠️ فشل إرسال إشعار الملف الأصلي. \n\n ${captionText}`);
    } catch (textError) {
        console.error("Failed to send even a text notification to admin:", textError.message);
    }
  }
}

// وحدة التعامل مع الطلبات (النسخة النهائية والمصححة)
module.exports = async (req, res) => {
    try {
        if (req.method !== 'POST') {
            return res.status(405).send('Method Not Allowed');
        }
        const body = await micro.json(req);
        const update = body;

        console.log("⬇️ Incoming Update");

        // 🛡️ حماية ضد التكرار الزمني (Stale Requests)
        if (update.message && update.message.date) {
            const timeDiff = Math.floor(Date.now() / 1000) - update.message.date;
            if (timeDiff > 20) {
                console.warn(`⚠️ [STALE REQUEST IGNORED] Time Diff: ${timeDiff}s.`);
                return res.status(200).send('Stale request ignored.');
            }
        }

        // 1️⃣ التعامل مع الملفات المرسلة (PDF)
        if (update.message && update.message.document) {
            const message = update.message;
            const chatId = message.chat.id;
            const user = message.from;
            const fileId = message.document.file_id;
            const uniqueRequestId = `${fileId}_${update.update_id}`; // معرف فريد للطلب

            // 🧠 كاش لمنع التحليل المكرر (Processing Lock)
            if (!global.processingFiles) global.processingFiles = new Set();

            if (global.processingFiles.has(uniqueRequestId)) {
                console.warn(`⏳ Duplicate request detected (${uniqueRequestId}). Ignoring.`);
                await bot.sendMessage(chatId, '⚙️ هذا الملف قيد المعالجة حالياً، يرجى الانتظار...');
                return res.status(200).send('Duplicate processing ignored.');
            }

            // تفعيل القفل
            global.processingFiles.add(uniqueRequestId);

            let adminNotificationStatus = '';
            let adminNotificationDetails = '';
            let extractionMethodReport = 'جاري التحليل... ⏳';

            const VERCEL_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB
            if (message.document.file_size > VERCEL_LIMIT_BYTES) {
                await bot.sendMessage(chatId, `⚠️ عذرًا، حجم الملف (${(message.document.file_size / 1024 / 1024).toFixed(2)} MB) يتجاوز الحد المسموح به (10 MB).`);
                adminNotificationStatus = 'ملف مرفوض 🐘';
                adminNotificationDetails = `السبب: حجم الملف (${(message.document.file_size / 1024 / 1024).toFixed(2)} MB) أكبر من الحد المسموح.`;
                extractionMethodReport = 'مرفوض (الحجم)';
                global.processingFiles.delete(uniqueRequestId); // فك القفل فوراً
            } else if (message.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '⚠️ يرجى إرسال ملف بصيغة PDF فقط.');
                adminNotificationStatus = 'ملف مرفوض 📄';
                adminNotificationDetails = `السبب: نوع الملف ليس PDF (النوع المرسل: ${message.document.mime_type}).`;
                extractionMethodReport = 'مرفوض (الصيغة)';
                global.processingFiles.delete(uniqueRequestId); // فك القفل فوراً
            } else {
                const waitingMsg = await bot.sendMessage(chatId, '📑 استلمت الملف، جاري تحليله واستخراج الأسئلة...');
                let patienceTimer = null;

                try {
                    const fileLink = await bot.getFileLink(fileId);
                    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                    const dataBuffer = Buffer.from(response.data);
                    const pdfData = await pdf(dataBuffer);
                    console.log(`📏 Chars: ${pdfData.text.length}`);

                    patienceTimer = setTimeout(async () => {
                        try { await bot.sendMessage(chatId, '✋ ما زلت أعمل على تحليل الملف، يبدو أنه كبير.. شكراً لصبرك 🌹'); } catch (e) {}
                    }, 120000); 

                    // تشغيل دالة الاستخراج الذكية
                    const extractionPromise = extractQuestions(pdfData.text);
                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_LIMIT_REACHED")), 295000));

                    const extractionResult = await Promise.race([extractionPromise, timeoutPromise]);
                    clearTimeout(patienceTimer);

                    const questions = extractionResult.questions;
                    extractionMethodReport = extractionResult.method; 

                    // تفاصيل مختصرة للأدمن
                    if (extractionResult.failureReport) {
                         adminNotificationDetails = extractionResult.failureReport;
                    } else {
                         adminNotificationDetails = 'تم الاستخراج بنجاح مباشر.';
                    }

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
                   `🛠️ المصدر: ${extractionMethodReport}\n\n` +
                   `اختر أين وكيف تريد إرسالها:`;
                       
                        try { await bot.deleteMessage(chatId, waitingMsg.message_id); } catch(e){}

                        await bot.sendMessage(chatId, successMsg, { parse_mode: 'Markdown', reply_markup: keyboard });
                        adminNotificationStatus = 'نجاح ✅';

                    } else {
                        try { await bot.deleteMessage(chatId, waitingMsg.message_id); } catch(e){}
                        
                        // استخدام التقرير المخزن للعرض
                        const failReportToShow = extractionResult.failureReport || "لا يوجد تفاصيل.";
                        const failMessage = `❌ لم أتمكن من العثور على أي أسئلة بصيغة صحيحة.\n\n` +
                                            `📋 التشخيص:\n` + 
                                            `➖ الحالة: ${extractionMethodReport}`; 

                        await bot.sendMessage(chatId, failMessage);
                        adminNotificationStatus = 'فشل (0 أسئلة) ❌';
                    }

                } catch (error) {
                    console.error("Error processing PDF:", error);
                    if (patienceTimer) clearTimeout(patienceTimer);
                    try { await bot.deleteMessage(chatId, waitingMsg.message_id); } catch(e){}

                    if (error.message === "TIMEOUT_LIMIT_REACHED") {
                        await bot.sendMessage(chatId, '⚠️ عذراً، عملية التحليل استغرقت وقتاً أطول من المسموح (5 دقائق).');
                        adminNotificationStatus = 'فشل (انتهاء الوقت) ⏳';
                        extractionMethodReport = 'Timeout';
                    } else {
                        await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء معالجة الملف. تأكد أنه سليم وغير تالف.');
                        adminNotificationStatus = 'فشل (خطأ تقني) 💥';
                        adminNotificationDetails = `السبب: ${error.message}`;
                    }
                } finally {
                    // ✅ فك القفل في النهاية دائماً
                    global.processingFiles.delete(uniqueRequestId);
                }
            }

            if (adminNotificationStatus) {
                await sendAdminNotification(adminNotificationStatus, user, fileId, adminNotificationDetails, extractionMethodReport);
            }
        }

        // 2️⃣ التعامل مع الاختبارات (Quizzes)
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
                    const promptText = `${previewText}\n\n*يرجى تحديد الإجابة الصحيحة لهذا الاختبار:*`;
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

        // 3️⃣ التعامل مع الضغط على الأزرار (Callback Query)
        else if (update.callback_query) {
             const callbackQuery = update.callback_query;
             const userId = callbackQuery.from.id;
             const chatId = callbackQuery.message.chat.id;
             const messageId = callbackQuery.message.message_id;
             const data = callbackQuery.data;
             const gasWebAppUrl = process.env.GAS_WEB_APP_URL;
 
             if (data.startsWith('poll_answer_')) {
                 if (!userState[userId] || !userState[userId].pending_polls || !userState[userId].pending_polls[messageId]) {
                     await bot.answerCallbackQuery(callbackQuery.id, { text: 'هذه الجلسة انتهت.', show_alert: true });
                     await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
                     return res.status(200).send('OK');
                 }
                 const poll_data = userState[userId].pending_polls[messageId];
                 poll_data.correctOptionId = parseInt(data.split('_')[2], 10);
                 const formattedText = formatQuizText(poll_data);
                 await bot.editMessageText(formattedText, {
                     chat_id: chatId,
                     message_id: messageId,
                 });
                 delete userState[userId].pending_polls[messageId];
                 await bot.answerCallbackQuery(callbackQuery.id);
             }
             else {
                 if (!userState[userId] || !userState[userId].questions) {
                     await bot.answerCallbackQuery(callbackQuery.id, { text: 'انتهت الجلسة، أعد إرسال الملف.', show_alert: true });
                     return res.status(200).send('OK');
                 }
                 if (!gasWebAppUrl) {
                     await bot.editMessageText('⚠️ خطأ: رابط GAS غير موجود في الإعدادات.', { chat_id: chatId, message_id: messageId });
                     return res.status(200).send('OK');
                 }
                 
                 if (data === 'send_here' || data === 'send_and_close_here') {
                     const { questions } = userState[userId];
                     const shouldClose = data === 'send_and_close_here';
                     const payload = { questions, targetChatId: chatId, originalChatId: chatId, startIndex: 0, chatType: 'private', closePolls: shouldClose };
                     axios.post(gasWebAppUrl, payload).catch(err => console.error("Error calling GAS:", err.message));
                     await bot.answerCallbackQuery(callbackQuery.id);
                     await bot.editMessageText(`✅ تم الإرسال للخدمة الخارجية.\n\nسيتم إرسال ${questions.length} سؤالًا.`, { chat_id: chatId, message_id: messageId });
                     delete userState[userId];
                 } else if (data === 'send_to_channel') {
                     userState[userId].awaiting = 'channel_id';
                     await bot.answerCallbackQuery(callbackQuery.id);
                     await bot.editMessageText('يرجى إرسال معرف (ID) القناة أو المجموعة الآن.\n(مثال: @username)', { chat_id: chatId, message_id: messageId });
                 } else if (data.startsWith('confirm_send')) {
                     if (userState[userId] && userState[userId].awaiting === 'send_confirmation') {
                         const { questions, targetChatId, targetChatTitle, chatType } = userState[userId];
                         const shouldClose = data.endsWith('_and_close');
                         const payload = { questions, targetChatId, originalChatId: chatId, startIndex: 0, chatType, closePolls: shouldClose };
                         axios.post(gasWebAppUrl, payload).catch(err => console.error("Error calling GAS:", err.message));
                         await bot.answerCallbackQuery(callbackQuery.id);
                         await bot.editMessageText(`✅ تم الإرسال إلى "${targetChatTitle}".`, { chat_id: chatId, message_id: messageId });
                         delete userState[userId];
                     }
                 } else if (data === 'cancel_send') {
                     await bot.answerCallbackQuery(callbackQuery.id);
                     await bot.editMessageText('❌ تم إلغاء العملية.', { chat_id: chatId, message_id: messageId });
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

            if (text.toLowerCase() === '/help') {
                const fileId = 'BQACAgQAAxkBAAE72dRo2-EHmbty7PivB2ZsIz1WKkAXXgAC5BsAAtF24VLmLAPbHKW4IDYE';
                await bot.sendDocument(chatId, fileId, { caption: 'مرحباً بك! 👋\n\nإليك دليل المستخدم الشامل للبوت بصيغة PDF. 📖' });
            }
            else if (userState[userId] && userState[userId].awaiting === 'channel_id') {
                 const targetChatId = text.trim();
                 try {
                     const chatInfo = await bot.getChat(targetChatId);
                     const botMember = await bot.getChatMember(targetChatId, (await bot.getMe()).id);
                     let infoText = `*-- الهدف: ${chatInfo.title} --*\n`;
                     let canProceed = false;
                     if (botMember.status === 'administrator' || botMember.status === 'creator') {
                         if (botMember.can_post_messages) canProceed = true;
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
                                 [{ text: '✅ نعم، إرسال', callback_data: 'confirm_send' }],
                                 [{ text: '🔒 إرسال وإغلاق', callback_data: 'confirm_send_and_close' }],
                                 [{ text: '❌ إلغاء', callback_data: 'cancel_send' }]
                             ] 
                         };
                         await bot.sendMessage(chatId, infoText + `هل تريد إرسال ${userState[userId].questions.length} سؤال؟`, { parse_mode: 'Markdown', reply_markup: confirmationKeyboard });
                     } else {
                         await bot.sendMessage(chatId, `⚠️ لا يمكن المتابعة. البوت ليس مشرفاً أو لا يملك صلاحية النشر.`);
                     }
                 } catch (error) {
                     await bot.sendMessage(chatId, '❌ فشل! تأكد من المعرف وأن البوت عضو في القناة.');
                 }
            }
        }
    } catch (error) {
        console.error("General error:", error);
    }
    res.status(200).send('OK');
};

// =================================================================
// ✨✨ === قسم الدوال الخاصة باستخراج الأسئلة (Logic V6.0) === ✨✨
// =================================================================

async function extractQuestions(text) {
    let questions = [];
    let failureSummary = '';

    // 1️⃣ محاولة الذكاء الاصطناعي (بنظام الدورتين: الأساسي ثم الاحتياطي)
    if (text.trim().length > 50) {
        console.log("Attempting AI extraction...");
        try {
            const aiResult = await extractWithAI(text);
            return { 
                questions: aiResult.questions, 
                method: aiResult.method,
                summary: aiResult.summary,
                failureReport: aiResult.fullLog // اللوج الكامل للأدمن
            };
        } catch (error) {
            console.error("AI Models completely failed. See logs.");
            // نأخذ سبب الفشل المختصر من نص الخطأ
            if (error.message.startsWith("Report:")) {
                failureSummary = error.message.replace("Report: ", "");
            } else {
                failureSummary = "AI Error";
            }
        }
    } else {
        console.log("Skipping AI (Text too short)");
        failureSummary = "Skipped (Short Text)";
    }

    // 2️⃣ محاولة Regex (Fallback)
    console.log("Falling back to Regex...");
    try {
        questions = extractWithRegex(text);
        if (questions.length > 0) {
            return { 
                questions: questions, 
                method: `Regex 🧩 (فشل AI: ${failureSummary})`,
                summary: `تم استخدام Regex لأن الـ AI فشل (${failureSummary})`,
                failureReport: `AI Failed (${failureSummary})`
            };
        }
    } catch (e) { console.error("Regex failed:", e); }

    return { 
        questions: [], 
        method: 'فشل تام ❌',
        summary: `AI Failed (${failureSummary}) + Regex Failed`,
        failureReport: `AI: ${failureSummary} | Regex: Failed`
    };
}

// ✨ الدالة الذكية (تدعم مفاتيح متعددة + Gemma 3 Backup)
async function extractWithAI(text) {
    // جلب المفاتيح من المتغير وتحويلها لمصفوفة
    const keysRaw = process.env.GEMINI_API_KEY || '';
    const keys = keysRaw.split(',').map(k => k.trim()).filter(k => k);
    
    if (keys.length === 0) throw new Error("Report: No Keys Configured");

    // إعداد النماذج (الأساسي والاحتياطي)
    const modelsToTry = [
        { id: 'gemini-2.5-flash', apiVersion: 'v1', label: 'Flash 2.5', isFallback: false },
        { id: 'gemma-3-27b-it', apiVersion: 'v1beta', label: 'Gemma 3 (27B)', isFallback: true }
    ];

    // نفس البرومبت المطلوب حرفياً
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
      }
    ]
    
    Here is the text to analyze:
    ---
    ${text}
    ---
    `;

    const payload = { contents: [{ parts: [{ text: prompt }] }] };

    let summaryReport = []; 
    let fullLog = []; // سجل كامل للتشخيص

    // 🔄 حلقة النماذج (Model Loop)
    for (const model of modelsToTry) {
        console.log(`\n🔵 Starting Round: ${model.id}...`);
        fullLog.push(`--- Model: ${model.label} ---`);

        let quotaHits = 0;
        let notFoundHits = 0;
        let busyHits = 0;
        let otherErrors = 0;

        // 🔄 حلقة المفاتيح (Key Loop)
        for (let i = 0; i < keys.length; i++) {
            const apiKey = keys[i];
            const url = `https://generativelanguage.googleapis.com/${model.apiVersion}/models/${model.id}:generateContent?key=${apiKey}`;

            try {
                const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });

                if (!response.data.candidates || response.data.candidates.length === 0) {
                     fullLog.push(`Key #${i+1}: Empty Response`);
                     otherErrors++;
                     continue;
                }

                const aiResponseText = response.data.candidates[0].content.parts[0].text;
                const cleanedJsonString = aiResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
                let parsedQuestions = JSON.parse(cleanedJsonString);
                
                if (Array.isArray(parsedQuestions) && parsedQuestions.length > 0) {
                    const areQuestionsValid = parsedQuestions.every(q => q.question && Array.isArray(q.options) && q.correctAnswerIndex !== undefined);
                    if (areQuestionsValid) {
                        console.log(`✅ SUCCESS: Key #${i + 1} on ${model.id}`);
                        
                        // دمج رقم السؤال مع النص
                        parsedQuestions.forEach(q => {
                            if (q.questionNumber) {
                                q.question = `${q.questionNumber}) ${q.question}`;
                                delete q.questionNumber;
                            }
                        });

                        fullLog.push(`✅ Key #${i+1}: SUCCESS`);
                        
                        let methodLabel = `AI 🤖 (${model.label})`;
                        let summary = `تم الاستخراج بواسطة ${model.label}.`;
                        
                        if (model.isFallback) {
                            methodLabel += ` (Backup)`;
                            summary += ` (لجأنا إليه بعد فشل Flash 2.5: ${summaryReport.join(', ')})`;
                        }

                        // النجاح! نرجع النتيجة
                        return { 
                            questions: parsedQuestions, 
                            method: methodLabel, 
                            summary: summary,
                            fullLog: fullLog.join('\n') 
                        };
                    }
                }
                fullLog.push(`Key #${i+1}: Invalid JSON`);
                otherErrors++;
            } catch (error) {
                const errorResponse = error.response ? error.response.data : {};
                const errorCode = errorResponse.error ? errorResponse.error.code : (error.response ? error.response.status : 0);
                const errorMsg = errorResponse.error ? errorResponse.error.message : error.message;
                
                let logMsg = `Key #${i+1}: ${errorCode}`;
                if (errorCode === 429) logMsg += ' (Quota)';
                else if (errorCode === 404) logMsg += ' (Not Found)';
                else if (errorCode === 503) logMsg += ' (Busy)';
                else logMsg += ` (${errorMsg.substring(0, 20)}...)`;
                
                fullLog.push(logMsg);
                console.log(`❌ ${model.id} - ${logMsg}`);

                // إحصائيات للتقرير المختصر
                if (errorCode === 429) quotaHits++;
                else if (errorCode === 404) notFoundHits++;
                else if (errorCode === 503) busyHits++;
                else otherErrors++;

                // تأخير بسيط إذا لم يكن آخر مفتاح
                if (i < keys.length - 1) await delay(1000);
            }
        } // End Key Loop

        let modelStatus = '';
        if (quotaHits === keys.length) modelStatus = 'Quota 📉'; 
        else if (notFoundHits === keys.length) modelStatus = 'Not Found ❌'; 
        else if (busyHits > 0) modelStatus = 'Busy 🛑';
        else modelStatus = 'Errors ⚠️';

        summaryReport.push(`${model.label}: ${modelStatus}`);
        fullLog.push(`⚠️ All keys failed for ${model.label}`);

    } // End Model Loop

    // إذا وصلنا هنا، يعني الفشل التام
    const finalReport = `Report: ${summaryReport.join(' + ')}`;
    // نرفق السجل الكامل مع رسالة الخطأ لنلتقطه في الدالة الرئيسية
    const errorObj = new Error(finalReport);
    errorObj.fullLog = fullLog.join('\n');
    throw errorObj;
}

// (دالة Regex - كما هي تماماً)
function extractWithRegex(text) {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\f/g, '\n').replace(/\u2028|\u2029/g, '\n');
    text = text.replace(/\n{2,}/g, '\n');

    const lines = text.split('\n').map(l => l.trim());
    const questions = [];
    let i = 0;

    const questionPatterns = [/^(Q|Question|Problem|Quiz|السؤال)?\s*\d+[\s\.\)\]\-\ـ]/];
    const letterOptionPatterns = [
        /^\s*[\-\*]?\s*([A-Z])[\.\)\-:]\s*(.+)/i,
        /^\s*([A-Z])\s*-\s*(.+)/i,
        /^\s*[\(\[\{]([A-Z])[\)\]\}]\s*(.+)/i,
    ];
    const numberOptionPatterns = [
        /^\s*[\-\*]?\s*(\d+)[\.\)\-:]\s*(.+)/,
        /^\s*(\d+)\s*-\s*(.+)/,
        /^\s*[\(\[\{](\d+)[\)\]\}]\s*(.+)/,
    ];
    const romanOptionPatterns = [ /^\s*([IVXLCDM]+)[\.\)\-]\s*(.+)/i ];
    const optionPatterns = [...letterOptionPatterns, ...numberOptionPatterns, ...romanOptionPatterns];
    const answerPatterns = [/^\s*[\-\*]?\s*(Answer|Correct Answer|Solution|Ans|Sol)\s*[:\-\.,;\/]?\s*/i];

    function findMatch(line, patterns) { for (const pattern of patterns) { const match = line.match(pattern); if (match) return match; } return null; }
    function romanToNumber(roman) {
        const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
        let num = 0;
        for (let i = 0; i < roman.length; i++) {
            const current = map[roman[i].toUpperCase()];
            const next = i + 1 < roman.length ? map[roman[i + 1].toUpperCase()] : 0;
            if (next > current) { num -= current; } else { num += current; }
        }
        return num;
    }
    
    function validateOptionsSequence(optionLines) {
        if (optionLines.length < 2) return true;
        let style = null;
        let lastValue = null;
        for (let j = 0; j < optionLines.length; j++) {
            const line = optionLines[j];
            let currentStyle = null, currentValue = null, identifier = '';
            if (findMatch(line, numberOptionPatterns)) { currentStyle = 'numbers'; identifier = findMatch(line, numberOptionPatterns)[1]; currentValue = parseInt(identifier, 10); } 
            else if (findMatch(line, letterOptionPatterns)) { currentStyle = 'letters'; identifier = findMatch(line, letterOptionPatterns)[1].toUpperCase(); currentValue = identifier.charCodeAt(0); } 
            else if (findMatch(line, romanOptionPatterns)) { currentStyle = 'roman'; identifier = findMatch(line, romanOptionPatterns)[1].toUpperCase(); currentValue = romanToNumber(identifier); } 
            else { return false; }
            if (j === 0) { style = currentStyle; lastValue = currentValue; } 
            else { if (currentStyle !== style || currentValue !== lastValue + 1) return false; lastValue = currentValue; }
        }
        return true;
    }

    while (i < lines.length) {
        const line = lines[i];
        if (!line) { i++; continue; }
        const optionInFollowingLines = lines.slice(i + 1, i + 6).some(l => findMatch(l, optionPatterns));
        const isQuestionStart = findMatch(line, questionPatterns) || (optionInFollowingLines && !findMatch(line, optionPatterns) && !findMatch(line, answerPatterns));
        if (!isQuestionStart) { i++; continue; }

        let questionText = line;
        let potentialOptionsIndex = i + 1;
        let j = i + 1;
        while (j < lines.length && !findMatch(lines[j], optionPatterns) && !findMatch(lines[j], answerPatterns)) {
            questionText += ' ' + lines[j].trim();
            potentialOptionsIndex = j + 1;
            j++;
        }
        
        if (potentialOptionsIndex < lines.length && findMatch(lines[potentialOptionsIndex], optionPatterns)) {
            const currentQuestion = { question: questionText.trim(), options: [], correctAnswerIndex: undefined };
            let k = potentialOptionsIndex;
            const optionLines = [];
            while (k < lines.length) {
                const optLine = lines[k];
                if (!optLine || findMatch(optLine, answerPatterns)) break;
                const optionMatch = findMatch(optLine, optionPatterns);
                if (optionMatch) { optionLines.push(optLine); currentQuestion.options.push(optionMatch[2].trim()); k++; } else { break; }
            }
            if (!validateOptionsSequence(optionLines)) { i++; continue; }
            if (k < lines.length && findMatch(lines[k], answerPatterns)) {
                const answerLine = lines[k];
                let answerText = answerLine.replace(answerPatterns[0], '').trim();
                let correctIndex = -1;
                const cleanAnswerText = answerText.replace(/^[A-Z\dIVXLCDM]+[\.\)]\s*/i, '').trim();
                correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === cleanAnswerText.toLowerCase());
                if (correctIndex === -1) {
                    const identifierMatch = answerText.match(/^[A-Z\dIVXLCDM]+/i);
                    if (identifierMatch) {
                        const firstOptionLine = optionLines[0];
                        if(findMatch(firstOptionLine, numberOptionPatterns)) correctIndex = parseInt(identifierMatch[0], 10) - 1;
                        else if(findMatch(firstOptionLine, letterOptionPatterns)) correctIndex = identifierMatch[0].toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
                        else if(findMatch(firstOptionLine, romanOptionPatterns)) correctIndex = romanToNumber(identifierMatch[0].toUpperCase()) - 1;
                    }
                }
                 if (correctIndex >= 0 && correctIndex < currentQuestion.options.length) currentQuestion.correctAnswerIndex = correctIndex;
                i = k + 1;
            } else { i = k; }
            if (currentQuestion.options.length > 1 && currentQuestion.correctAnswerIndex !== undefined) questions.push(currentQuestion);
        } else { i++; }
    }
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
