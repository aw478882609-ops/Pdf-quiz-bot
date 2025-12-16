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
// 🔔 دالة لإرسال إشعار للمشرف
// =================================================================
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
  captionText += `🛠️ طريقة الاستخراج: ${method}\n\n`;
  captionText += `من المستخدم: ${userName} (${userUsername})\n`;
  captionText += `ID المستخدم: ${user.id}\n\n`;
   
  if (details) {
    // تقصير التفاصيل إذا كانت طويلة جداً لتجنب خطأ تليجرام
    const safeDetails = details.length > 800 ? details.substring(0, 800) + '...' : details;
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

        console.log("⬇️ Incoming Telegram Update:", JSON.stringify(update, null, 2));

        if (update.message && update.message.date) {
            const messageDate = update.message.date;
            const currentTime = Math.floor(Date.now() / 1000);
            const timeDiff = currentTime - messageDate;

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
            const uniqueRequestId = `${fileId}_${update.update_id}`;

            if (!global.processingFiles) global.processingFiles = new Set();

            if (global.processingFiles.has(uniqueRequestId)) {
                console.warn(`⏳ Duplicate request detected. Ignoring.`);
                return res.status(200).send('Duplicate processing ignored.');
            }

            global.processingFiles.add(uniqueRequestId);

            let adminNotificationStatus = '';
            let adminNotificationDetails = '';
            let extractionMethodReport = 'جاري التحليل... ⏳';

            const VERCEL_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB
            if (message.document.file_size > VERCEL_LIMIT_BYTES) {
                await bot.sendMessage(chatId, `⚠️ عذرًا، حجم الملف يتجاوز الحد المسموح به (${'10 MB'}).`);
                adminNotificationStatus = 'ملف مرفوض 🐘';
                adminNotificationDetails = 'السبب: حجم الملف أكبر من 10 ميجا.';
                extractionMethodReport = 'لم يتم الفحص (حجم كبير)';
                global.processingFiles.delete(uniqueRequestId);
            } else if (message.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '⚠️ يرجى إرسال ملف بصيغة PDF فقط.');
                adminNotificationStatus = 'ملف مرفوض 📄';
                adminNotificationDetails = `السبب: نوع الملف ليس PDF.`;
                extractionMethodReport = 'لم يتم الفحص (صيغة خاطئة)';
                global.processingFiles.delete(uniqueRequestId);
            } else {
                const waitingMsg = await bot.sendMessage(chatId, '⏳ استلمت الملف.. جاري التحميل والتحليل..');
                let patienceTimer = null;

                try {
                    const fileLink = await bot.getFileLink(fileId);
                    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                    const dataBuffer = Buffer.from(response.data);
                    const pdfData = await pdf(dataBuffer);
                    console.log(`📏 [BENCHMARK] Total Characters: ${pdfData.text.length}`);

                    patienceTimer = setTimeout(async () => {
                        try {
                            await bot.sendMessage(chatId, '✋ ما زلت أعمل على تحليل الملف، يبدو أنه كبير ومليء بالمعلومات.. شكراً لصبرك 🌹');
                        } catch (e) { console.error("Failed to send patience msg", e); }
                    }, 120000); 

                    const extractionPromise = extractQuestions(pdfData.text);

                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => {
                            reject(new Error("TIMEOUT_LIMIT_REACHED"));
                        }, 295000); 
                    });

                    // تنفيذ الاستخراج
                    const extractionResult = await Promise.race([extractionPromise, timeoutPromise]);
                    clearTimeout(patienceTimer);

                    const questions = extractionResult.questions;
                    extractionMethodReport = extractionResult.method; 

                    // إذا كان هناك تقرير فشل (حتى لو وجدنا أسئلة بالـ Regex)، نعرضه للأدمن
                    if (extractionResult.failureReport) {
                        adminNotificationDetails = `تفاصيل AI: ${extractionResult.failureReport}`;
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
                   `🛠️ طريقة الاستخراج: ${extractionMethodReport}\n\n` +
                   `اختر أين وكيف تريد إرسالها:`;
                       
                        try { await bot.deleteMessage(chatId, waitingMsg.message_id); } catch(e){}

                        await bot.sendMessage(chatId, successMsg, {
                            parse_mode: 'Markdown',
                            reply_markup: keyboard
                        });
                        adminNotificationStatus = 'نجاح ✅';

                    } else {
                        try { await bot.deleteMessage(chatId, waitingMsg.message_id); } catch(e){}
                        
                        // هنا نستخدم تقرير الفشل المخزن بدقة
                        const failReportToShow = extractionResult.failureReport || extractionMethodReport;

                        const failMessage = `❌ لم أتمكن من العثور على أي أسئلة بصيغة صحيحة في الملف.\n\n` +
                                            `📋 تقرير التحليل:\n` + 
                                            `➖ التفاصيل: ${failReportToShow}`; 

                        await bot.sendMessage(chatId, failMessage);
                        
                        adminNotificationStatus = 'فشل (0 أسئلة) ❌';
                        adminNotificationDetails = `النتيجة 0 أسئلة. التقرير الكامل: ${failReportToShow}`;
                    }

                } catch (error) {
                    console.error("Error processing PDF:", error);
                    if (patienceTimer) clearTimeout(patienceTimer);
                    try { await bot.deleteMessage(chatId, waitingMsg.message_id); } catch(e){}

                    if (error.message === "TIMEOUT_LIMIT_REACHED") {
                        await bot.sendMessage(chatId, '⚠️ عذراً، عملية التحليل استغرقت وقتاً أطول من المسموح (5 دقائق).');
                        adminNotificationStatus = 'فشل (انتهاء الوقت) ⏳';
                        adminNotificationDetails = `انقطع الاتصال عند 295 ثانية.`;
                        extractionMethodReport = 'Timeout (توقف أثناء التحليل)';
                    } else {
                        await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء معالجة الملف. يرجى التأكد من أن الملف سليم.');
                        adminNotificationStatus = 'فشل (خطأ تقني) 💥';
                        adminNotificationDetails = `السبب: ${error.message}`;
                    }
                } finally {
                    global.processingFiles.delete(uniqueRequestId);
                }
            }

            if (adminNotificationStatus) {
                await sendAdminNotification(adminNotificationStatus, user, fileId, adminNotificationDetails, extractionMethodReport);
            }
        }

        // ... (باقي الكود: التعامل مع الاختبارات والأزرار والرسائل النصية كما هو في النسخة السابقة تماماً بدون تغيير)
        // قم بنسخ الجزء الخاص بـ update.message.poll و callback_query و text من الكود السابق وضعه هنا
        // اختصاراً للمساحة ولأن التعديل في الـ AI فقط، تأكد من وضع باقي الـ blocks هنا.
        else if (update.message && update.message.poll) {
             // ... (نفس كود الاختبارات) ...
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
        else if (update.callback_query) {
             // ... (نفس كود الأزرار) ...
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
        else if (update.message && update.message.text) {
             // ... (نفس كود الرسائل النصية) ...
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
// ✨✨ === قسم الدوال الخاصة باستخراج الأسئلة (المعدل بالكامل) === ✨✨
// =================================================================

async function extractQuestions(text) {
    let questions = [];

    // 1️⃣ محاولة الذكاء الاصطناعي
    if (text.trim().length > 50) {
        console.log("Attempting AI extraction (Multi-Model Strategy)...");
        try {
            const aiResult = await extractWithAI(text);
            if (aiResult.questions.length > 0) {
                return { 
                    questions: aiResult.questions, 
                    method: aiResult.method,
                    failureReport: aiResult.fullLog // نمرر السجل الكامل للأدمن
                };
            }
        } catch (error) {
            console.error("All AI Models failed logic:", error.message);
            if (error.message === "TIMEOUT_LIMIT_REACHED") throw error;
            
            // في حالة الفشل التام للـ AI، نلتقط التقرير لنرسله مع الـ Regex
            // الخطأ هنا هو string يحتوي على التقرير
            var aiFailReport = error.message; 
        }
    } else {
        console.log("Text too short for AI, skipping to Regex.");
        var aiFailReport = "Skipped (Text too short)";
    }

    // 2️⃣ محاولة Regex
    console.log("Falling back to Regex extraction...");
    try {
        questions = extractWithRegex(text);
        if (questions.length > 0) {
            return { 
                questions: questions, 
                method: `Regex 🧩 (AI Failed)`,
                failureReport: aiFailReport // نرفق تقرير فشل الـ AI هنا
            };
        }
    } catch (e) {
        console.error("Regex extraction also failed:", e);
    }

    return { 
        questions: [], 
        method: 'فشل تام ❌',
        failureReport: aiFailReport // تقرير لماذا فشل الـ AI
    };
}

// الدالة الذكية الجديدة للتعامل مع تعدد النماذج + تقارير دقيقة
async function extractWithAI(text) {
    const keysRaw = process.env.GEMINI_API_KEY || '';
    const keys = keysRaw.split(',').map(k => k.trim()).filter(k => k);
    
    if (keys.length === 0) throw new Error("No keys available");

    const modelsToTry = [
        { id: 'gemini-2.5-flash', apiVersion: 'v1', label: 'Flash 2.5', isFallback: false },
        { id: 'gemma-2-27b-it', apiVersion: 'v1beta', label: 'Gemma', isFallback: true }
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

    let fullLog = []; // 📝 سجل دقيق لكل محاولة

    for (const model of modelsToTry) {
        console.log(`\n🔵 Starting Round: ${model.id}...`);
        fullLog.push(`--- Model: ${model.label} ---`);

        for (let i = 0; i < keys.length; i++) {
            const apiKey = keys[i];
            const url = `https://generativelanguage.googleapis.com/${model.apiVersion}/models/${model.id}:generateContent?key=${apiKey}`;

            try {
                const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });

                if (!response.data.candidates || response.data.candidates.length === 0) {
                     fullLog.push(`Key #${i+1}: Empty Response`);
                     continue;
                }

                const aiResponseText = response.data.candidates[0].content.parts[0].text;
                const cleanedJsonString = aiResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
                let parsedQuestions = JSON.parse(cleanedJsonString);
                
                if (Array.isArray(parsedQuestions) && parsedQuestions.length > 0) {
                    const areQuestionsValid = parsedQuestions.every(q => q.question && Array.isArray(q.options) && q.correctAnswerIndex !== undefined);
                    if (areQuestionsValid) {
                        console.log(`✅ Success with Key #${i + 1} on ${model.id}`);
                        
                        parsedQuestions.forEach(q => {
                            if (q.questionNumber) {
                                q.question = `${q.questionNumber}) ${q.question}`;
                                delete q.questionNumber;
                            }
                        });

                        // إضافة سطر النجاح للتقرير
                        fullLog.push(`✅ Key #${i+1}: SUCCESS`);
                        
                        let methodLabel = `AI 🤖 (${model.label})`;
                        if (model.isFallback) methodLabel += ` (Backup)`;

                        return { 
                            questions: parsedQuestions, 
                            method: methodLabel,
                            fullLog: fullLog.join('\n') // نرجع السجل كامل
                        };
                    }
                }
                fullLog.push(`Key #${i+1}: Invalid JSON`);
            } catch (error) {
                const errorResponse = error.response ? error.response.data : {};
                const errorCode = errorResponse.error ? errorResponse.error.code : (error.response ? error.response.status : 0);
                const errorMsg = errorResponse.error ? errorResponse.error.message : error.message;
                
                // تسجيل الخطأ بدقة
                let logMsg = `Key #${i+1}: ${errorCode}`;
                if (errorCode === 429) logMsg += ' (Quota)';
                else if (errorCode === 404) logMsg += ' (Not Found)';
                else if (errorCode === 503) logMsg += ' (Busy)';
                else logMsg += ` (${errorMsg.substring(0, 20)}...)`; // جزء من رسالة الخطأ
                
                fullLog.push(logMsg);
                console.log(`❌ ${model.id} - ${logMsg}`);

                if (i < keys.length - 1) await delay(1000);
            }
        } // End Keys Loop

        fullLog.push(`⚠️ All keys failed for ${model.label}`);
    } // End Models Loop

    // إذا وصلنا هنا، يعني الفشل التام. نرجع السجل الكامل كنص للخطأ
    throw new Error(fullLog.join('\n'));
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
