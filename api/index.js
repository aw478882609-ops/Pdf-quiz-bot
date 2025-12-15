const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

// تهيئة البوت
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
const userState = {};

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// دالة لإرسال إشعار للمشرف
async function sendAdminNotification(status, user, fileId, details = '') {
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
  captionText += `الحالة: ${status}\n\n`;
  captionText += `من المستخدم: ${userName} (${userUsername})\n\n`;
  captionText += `ID المستخدم: ${user.id}\n\n`;
  if (details) {
    captionText += `تفاصيل: ${details}\n`;
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

        // 🔍 تسجيل كل تحديث قادم من تليجرام (للمراقبة)
        console.log("⬇️ Incoming Telegram Update:", JSON.stringify(update, null, 2));

        // =================================================================
        // 🛡️ [حماية ضد التكرار]: التحقق من وقت الرسالة (Stale Request Check)
        // =================================================================
        if (update.message && update.message.date) {
            const messageDate = update.message.date; // توقيت الرسالة (Unix Timestamp بالثواني)
            const currentTime = Math.floor(Date.now() / 1000); // الوقت الحالي بالثواني
            const timeDiff = currentTime - messageDate;

            // إذا مر أكثر من 20 ثانية على الرسالة، فهذا "تكرار" (Retry) من تليجرام بسبب التأخير
            if (timeDiff > 20) {
                console.warn(`⚠️ [STALE REQUEST IGNORED] Time Diff: ${timeDiff}s. UpdateID: ${update.update_id}`);
                // الرد بـ OK فوراً لإسكات تليجرام
                return res.status(200).send('Stale request ignored.');
            }
        }

        // 1️⃣ التعامل مع الملفات المرسلة (PDF)
        if (update.message && update.message.document) {
            const message = update.message;
            const chatId = message.chat.id;
            const user = message.from;
            const fileId = message.document.file_id;
            // استخدام update_id لضمان دقة الكاش المحلي
            const uniqueRequestId = `${fileId}_${update.update_id}`;

            // 🧠 كاش محلي (إضافي) لمنع التحليل المكرر في نفس اللحظة
            if (!global.processingFiles) global.processingFiles = new Set();

            if (global.processingFiles.has(uniqueRequestId)) {
                console.warn(`⏳ Duplicate in-memory request detected for ${uniqueRequestId}. Ignoring.`);
                return res.status(200).send('Duplicate processing ignored.');
            }

            // إضافة للكاش
            global.processingFiles.add(uniqueRequestId);

            let adminNotificationStatus = '';
            let adminNotificationDetails = '';

            const VERCEL_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB
            if (message.document.file_size > VERCEL_LIMIT_BYTES) {
                await bot.sendMessage(chatId, `⚠️ عذرًا، حجم الملف يتجاوز الحد المسموح به (${'10 MB'}).`);
                adminNotificationStatus = 'ملف مرفوض 🐘';
                adminNotificationDetails = 'السبب: حجم الملف أكبر من 10 ميجا.';
                global.processingFiles.delete(uniqueRequestId);
            } else if (message.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '⚠️ يرجى إرسال ملف بصيغة PDF فقط.');
                adminNotificationStatus = 'ملف مرفوض 📄';
                adminNotificationDetails = `السبب: نوع الملف ليس PDF (النوع المرسل: ${message.document.mime_type}).`;
                global.processingFiles.delete(uniqueRequestId);
            } else {
                await bot.sendMessage(chatId, '📑 استلمت الملف، جاري تحليله واستخراج الأسئلة...');
                try {
                    const fileLink = await bot.getFileLink(fileId);
                    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                    const dataBuffer = Buffer.from(response.data);
                    const pdfData = await pdf(dataBuffer);

                    // استدعاء دالة الاستخراج المعدلة
                    const extractionResult = await extractQuestions(pdfData.text);
                    const questions = extractionResult.questions;
                    const extractionMethod = extractionResult.method;

                    if (questions.length > 0) {
                        userState[user.id] = { questions: questions };
                        const keyboard = {
                            inline_keyboard: [
                                [{ text: 'إرسال هنا 📤', callback_data: 'send_here' }],
                                [{ text: 'إرسال وإغلاق هنا 🔒', callback_data: 'send_and_close_here'}],
                                [{ text: 'إرسال لقناة/مجموعة 📢', callback_data: 'send_to_channel' }]
                            ]
                        };
                        
                        const successMsg = `✅ تم العثور على ${questions.length} سؤالًا.\n` +
                                           `🛠️ *طريقة الاستخراج:* ${extractionMethod}\n\n` +
                                           `اختر أين وكيف تريد إرسالها:`;

                        await bot.sendMessage(chatId, successMsg, {
                            parse_mode: 'Markdown',
                            reply_markup: keyboard
                        });
                        adminNotificationStatus = 'نجاح ✅';
                        adminNotificationDetails = `تم العثور على ${questions.length} سؤال باستخدام (${extractionMethod}).`;
                    } else {
                        await bot.sendMessage(chatId, '❌ لم أتمكن من العثور على أي أسئلة بصيغة صحيحة في الملف. تأكد أن النص قابل للنسخ. للمساعدة اضغط /help');
                        adminNotificationStatus = 'نجاح (لكن فارغ) 🤷‍♂️';
                        adminNotificationDetails = 'تمت معالجة الملف لكن لم يتم العثور على أسئلة.';
                    }
                } catch (error) {
                    console.error("Error processing PDF:", error);
                    await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء معالجة الملف. يرجى التأكد من أن الملف سليم وغير تالف.');
                    adminNotificationStatus = 'فشل ❌';
                    adminNotificationDetails = `السبب: ${error.message}`;
                } finally {
                    // تنظيف الكاش دائماً
                    global.processingFiles.delete(uniqueRequestId);
                }
            }

            if (adminNotificationStatus) {
                await sendAdminNotification(adminNotificationStatus, user, fileId, adminNotificationDetails);
            }
        }

        // 2️⃣ التعامل مع الاختبارات (Quizzes)
        else if (update.message && update.message.poll) {
            const message = update.message;
            const poll = message.poll;

            if (poll.type !== 'quiz') {
                return res.status(200).send('OK');
            }

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
                    await bot.sendMessage(chatId, formattedText, {
                        reply_to_message_id: message.message_id
                    });
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
            const userId = message.from.id;
            const chatId = message.chat.id;
            const text = message.text;

            if (text.toLowerCase() === '/help') {
                const fileId = 'BQACAgQAAxkBAAE72dRo2-EHmbty7PivB2ZsIz1WKkAXXgAC5BsAAtF24VLmLAPbHKW4IDYE';
                await bot.sendDocument(chatId, fileId, {
                    caption: 'مرحباً بك! 👋\n\nإليك دليل المستخدم الشامل للبوت بصيغة PDF. 📖'
                });
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
// ✨✨ === قسم الدوال الخاصة باستخراج الأسئلة === ✨✨
// =================================================================

async function extractQuestions(text) {
    let questions = [];

    // محاولة الذكاء الاصطناعي
    if (text.trim().length > 50) {
        console.log("Attempting AI extraction first...");
        try {
            questions = await extractWithAI(text);
            if (questions.length > 0) {
                return { questions: questions, method: 'AI 🤖' };
            }
        } catch (error) {
            console.error("All AI Keys failed:", error.message);
        }
    }

    // محاولة Regex
    console.log("Falling back to Regex extraction...");
    try {
        questions = extractWithRegex(text);
        if (questions.length > 0) {
            return { questions: questions, method: 'Regex 🧩' };
        }
    } catch (e) {
        console.error("Regex extraction also failed:", e);
    }

    return { questions: [], method: 'None ❌' };
}

// (دالة extractWithAI المُعدّلة لدعم تعدد المفاتيح بالتتابع)
async function extractWithAI(text) {
    const keysRaw = process.env.GEMINI_API_KEY || '';
    const keys = keysRaw.split(',').map(k => k.trim()).filter(k => k);
    
    if (keys.length === 0) return [];

    const prompt = `
    Analyze the following text and extract all multiple-choice questions.
    For each question, provide:
    1. The question number as a string (e.g., "1", "Q2", "٣"), if it exists.
    2. The full question text.
    3. A list of all possible options.
    4. The index of the correct answer (starting from 0).
    5. The explanation for the answer, if one is provided in the text.
    VERY IMPORTANT: Respond ONLY with a valid JSON array of objects.
    [
      {
        "questionNumber": "1",
        "question": "Example Question?",
        "options": ["Option A", "Option B"],
        "correctAnswerIndex": 0,
        "explanation": "Explanation here"
      }
    ]
    Text:
    ---
    ${text}
    ---
    `;

    const payload = {
        contents: [{ parts: [{ text: prompt }] }]
    };

    // 🔁 الحلقة التكرارية: جرب المفتاح الأول، إذا فشل جرب الثاني...
    for (let i = 0; i < keys.length; i++) {
        const apiKey = keys[i];
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        try {
            console.log(`🔄 Trying API Key #${i + 1}...`);
            const response = await axios.post(url, payload, {
                headers: { 'Content-Type': 'application/json' }
            });

            if (!response.data.candidates || response.data.candidates.length === 0) continue; 

            const aiResponseText = response.data.candidates[0].content.parts[0].text;
            const cleanedJsonString = aiResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
            let parsedQuestions = JSON.parse(cleanedJsonString);
            
            if (Array.isArray(parsedQuestions) && parsedQuestions.length > 0) {
                const areQuestionsValid = parsedQuestions.every(q => q.question && Array.isArray(q.options) && q.correctAnswerIndex !== undefined);
                if (areQuestionsValid) {
                    console.log(`✅ Success with Key #${i + 1}: Extracted ${parsedQuestions.length} questions.`);
                    parsedQuestions.forEach(q => {
                        if (q.questionNumber) {
                            q.question = `${q.questionNumber}) ${q.question}`;
                            delete q.questionNumber;
                        }
                    });
                    return parsedQuestions;
                }
            }
        } catch (error) {
            const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
            console.error(`❌ Key #${i + 1} Failed: ${errorMsg}`);
            console.log("➡️ Switching to next key...");
        }
    }
    throw new Error("All provided API keys failed.");
}


// (دالة extractWithRegex - لم يتم تغيير المنطق)
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
