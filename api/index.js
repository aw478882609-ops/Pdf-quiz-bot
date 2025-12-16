const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

// تهيئة البوت
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
const userState = {};

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// دالة مساعدة للتأخير
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =================================================================
// 🔔 دالة لإرسال إشعار للمشرف (نظيفة ومختصرة)
// =================================================================
async function sendAdminNotification(status, user, fileId, details = '', method = 'غير محدد ❓') {
  if (String(user.id) === ADMIN_CHAT_ID) {
    return; 
  }

  if (!ADMIN_CHAT_ID) {
    console.log("ADMIN_CHAT_ID is not set.");
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
    captionText += `📝 ملخص التقرير: ${details}\n`;
  }

  try {
    await bot.sendDocument(ADMIN_CHAT_ID, fileId, { caption: captionText });
  } catch (error) {
    console.error("Failed to send admin notification:", error.message);
    try {
        await bot.sendMessage(ADMIN_CHAT_ID, `⚠️ تنبيه ملف: ${captionText}`);
    } catch (e) {}
  }
}

// =================================================================
// ⚙️ وحدة التعامل مع الطلبات (Main Handler)
// =================================================================
module.exports = async (req, res) => {
    try {
        if (req.method !== 'POST') {
            return res.status(405).send('Method Not Allowed');
        }
        const body = await micro.json(req);
        const update = body;

        console.log("⬇️ Incoming Update");

        if (update.message && update.message.date) {
            const timeDiff = Math.floor(Date.now() / 1000) - update.message.date;
            if (timeDiff > 20) return res.status(200).send('Stale request.');
        }

        // 1️⃣ التعامل مع الملفات المرسلة (PDF)
        if (update.message && update.message.document) {
            const message = update.message;
            const chatId = message.chat.id;
            const user = message.from;
            const fileId = message.document.file_id;
            const uniqueRequestId = `${fileId}_${update.update_id}`;

            if (!global.processingFiles) global.processingFiles = new Set();
            if (global.processingFiles.has(uniqueRequestId)) return res.status(200).send('Duplicate.');
            global.processingFiles.add(uniqueRequestId);

            let adminNotificationStatus = '';
            let adminNotificationDetails = '';
            let extractionMethodReport = 'جاري التحليل...';

            const VERCEL_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB
            if (message.document.file_size > VERCEL_LIMIT_BYTES) {
                await bot.sendMessage(chatId, `⚠️ عذرًا، حجم الملف يتجاوز الحد المسموح به (${'10 MB'}).`);
                adminNotificationStatus = 'ملف مرفوض 🐘';
                adminNotificationDetails = 'السبب: حجم الملف أكبر من 10 ميجا.';
                extractionMethodReport = 'مرفوض (الحجم)';
                global.processingFiles.delete(uniqueRequestId);
            } else if (message.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '⚠️ يرجى إرسال ملف بصيغة PDF فقط.');
                adminNotificationStatus = 'ملف مرفوض 📄';
                adminNotificationDetails = `السبب: نوع الملف ليس PDF.`;
                extractionMethodReport = 'مرفوض (الصيغة)';
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
                        try { await bot.sendMessage(chatId, '✋ ما زلت أعمل على تحليل الملف، يبدو أنه كبير.. شكراً لصبرك 🌹'); } catch (e) {}
                    }, 120000); 

                    const extractionPromise = extractQuestions(pdfData.text);
                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_LIMIT_REACHED")), 295000));

                    const extractionResult = await Promise.race([extractionPromise, timeoutPromise]);
                    clearTimeout(patienceTimer);

                    const questions = extractionResult.questions;
                    extractionMethodReport = extractionResult.method; 
                    
                    adminNotificationDetails = extractionResult.summary || 'تمت العملية بنجاح.';

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
                        
                        const failMessage = `❌ لم أتمكن من العثور على أي أسئلة.\n\n` +
                                            `📋 التشخيص:\n` + 
                                            `➖ ${extractionMethodReport}`; 

                        await bot.sendMessage(chatId, failMessage);
                        adminNotificationStatus = 'فشل (0 أسئلة) ❌';
                    }

                } catch (error) {
                    console.error("Error processing PDF:", error);
                    if (patienceTimer) clearTimeout(patienceTimer);
                    try { await bot.deleteMessage(chatId, waitingMsg.message_id); } catch(e){}

                    if (error.message === "TIMEOUT_LIMIT_REACHED") {
                        await bot.sendMessage(chatId, '⚠️ عذراً، عملية التحليل استغرقت وقتاً أطول من المسموح.');
                        adminNotificationStatus = 'فشل (انتهاء الوقت) ⏳';
                        extractionMethodReport = 'Timeout';
                    } else {
                        await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء معالجة الملف.');
                        adminNotificationStatus = 'فشل (خطأ تقني) 💥';
                        adminNotificationDetails = error.message;
                    }
                } finally {
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
// ✨✨ === قسم الدوال الخاصة باستخراج الأسئلة (Meticulous Logging) === ✨✨
// =================================================================

async function extractQuestions(text) {
    let questions = [];
    let failureSummary = '';

    // 1️⃣ محاولة الذكاء الاصطناعي
    if (text.trim().length > 50) {
        console.log("Attempting AI extraction...");
        try {
            const aiResult = await extractWithAI(text);
            return { 
                questions: aiResult.questions, 
                method: aiResult.method,
                summary: aiResult.summary 
            };
        } catch (error) {
            console.error("AI Models completely failed. See logs above.");
            if (error.message.startsWith("Report:")) {
                failureSummary = error.message.replace("Report: ", "");
            } else {
                failureSummary = "Unknown Error";
            }
        }
    } else {
        console.log("Skipping AI (Text short)");
        failureSummary = "Text too short";
    }

    // 2️⃣ محاولة Regex
    console.log("Falling back to Regex...");
    try {
        questions = extractWithRegex(text);
        if (questions.length > 0) {
            return { 
                questions: questions, 
                method: `Regex 🧩 (فشل AI: ${failureSummary})`,
                summary: `تم استخدام Regex لأن الـ AI فشل (${failureSummary})`
            };
        }
    } catch (e) { console.error("Regex failed:", e); }

    return { 
        questions: [], 
        method: 'فشل تام ❌',
        summary: `AI Failed (${failureSummary}) + Regex Failed`
    };
}

// الدالة الذكية (مع التعديل الجديد لاسم Gemma 3)
async function extractWithAI(text) {
    const keysRaw = process.env.GEMINI_API_KEY || '';
    const keys = keysRaw.split(',').map(k => k.trim()).filter(k => k);
    
    if (keys.length === 0) throw new Error("Report: No Keys Configured");

    // ✅✅ تم التحديث لاستخدام Gemma 3 (الموجود فعلياً)
    const modelsToTry = [
        { id: 'gemini-2.5-flash', apiVersion: 'v1', label: 'Flash 2.5', isFallback: false },
        { id: 'gemma-3-27b-it', apiVersion: 'v1beta', label: 'Gemma 3 (27B)', isFallback: true }
    ];

    const prompt = `
    Analyze the following text and extract all multiple-choice questions.
    Respond ONLY with a valid JSON array of objects.
    Text:
    ---
    ${text}
    ---
    `;
    const payload = { contents: [{ parts: [{ text: prompt }] }] };

    let summaryReport = []; 

    for (const model of modelsToTry) {
        console.log(`\n🔵 Starting Round: ${model.id}...`);
        
        let quotaHits = 0;
        let notFoundHits = 0;
        let busyHits = 0;
        let otherErrors = 0;

        for (let i = 0; i < keys.length; i++) {
            const apiKey = keys[i];
            const url = `https://generativelanguage.googleapis.com/${model.apiVersion}/models/${model.id}:generateContent?key=${apiKey}`;

            try {
                const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });

                if (!response.data.candidates || response.data.candidates.length === 0) {
                     console.log(`❌ Key #${i+1} on ${model.id}: Empty Response`);
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
                        
                        parsedQuestions.forEach(q => {
                            if (q.questionNumber) {
                                q.question = `${q.questionNumber}) ${q.question}`;
                                delete q.questionNumber;
                            }
                        });

                        let methodLabel = `AI 🤖 (${model.label})`;
                        let summary = `تم الاستخراج بواسطة ${model.label}.`;
                        
                        if (model.isFallback) {
                            methodLabel += ` (Backup)`;
                            summary += ` (لجأنا إليه بعد فشل Flash 2.5: ${summaryReport.join(', ')})`;
                        }

                        return { questions: parsedQuestions, method: methodLabel, summary: summary };
                    }
                }
                console.log(`❌ Key #${i+1} on ${model.id}: JSON Parsing Failed`);
                otherErrors++;
            } catch (error) {
                const errorResponse = error.response ? error.response.data : {};
                const errorCode = errorResponse.error ? errorResponse.error.code : (error.response ? error.response.status : 0);
                const errorMsg = errorResponse.error ? errorResponse.error.message : error.message;
                
                console.error(`❌ Key #${i+1} Failed on ${model.id} -> Code: ${errorCode} | Msg: ${errorMsg}`);

                if (errorCode === 429) quotaHits++;
                else if (errorCode === 404) notFoundHits++;
                else if (errorCode === 503) busyHits++;
                else otherErrors++;

                if (i < keys.length - 1) await delay(1000);
            }
        } 

        let modelStatus = '';
        if (quotaHits === keys.length) modelStatus = 'Quota 📉'; 
        else if (notFoundHits === keys.length) modelStatus = 'Not Found ❌'; 
        else if (busyHits > 0) modelStatus = 'Busy 🛑';
        else modelStatus = 'Errors ⚠️';

        summaryReport.push(`${model.label}: ${modelStatus}`);
        console.log(`⚠️ Model ${model.id} finished. Status: ${modelStatus}`);

    } 

    throw new Error(`Report: ${summaryReport.join(' + ')}`);
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
