// ==== بداية كود Vercel الكامل (api/index.js) ====

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

// تهيئة البوت
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
const userState = {};

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

/*
 * دالة لإرسال إشعار للمشرف
 */
async function sendAdminNotification(status, user, fileId, details = '') {
  if (String(user.id) === ADMIN_CHAT_ID) {
    console.log("User is the admin. Skipping self-notification.");
    return;
  }

  if (!ADMIN_CHAT_ID) return;

  const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  const userUsername = user.username ? `@${user.username}` : 'لا يوجد';
  let captionText = `🔔 إشعار معالجة ملف 🔔\n\n`;
  captionText += `الحالة: ${status}\n\n`;
  captionText += `من المستخدم: ${userName} (${userUsername})\n\n`;
  captionText += `ID المستخدم: ${user.id}\n\n`;
  if (details) captionText += `تفاصيل: ${details}\n`;

  try {
    await bot.sendDocument(ADMIN_CHAT_ID, fileId, { caption: captionText });
  } catch (error) {
    console.error("Failed to send notification to admin:", error.message);
    try {
        await bot.sendMessage(ADMIN_CHAT_ID, `⚠️ فشل إرسال إشعار الملف. \n\n ${captionText}`);
    } catch (e) {}
  }
}

// وحدة التعامل مع الطلبات
module.exports = async (req, res) => {
    try {
        if (req.method !== 'POST') {
            return res.status(405).send('Method Not Allowed');
        }
        const body = await micro.json(req);
        const update = body;

        // 1️⃣ التعامل مع الملفات المرسلة (PDF)
        if (update.message && update.message.document) {
            const message = update.message;
            const chatId = message.chat.id;
            const user = message.from;
            const fileId = message.document.file_id;

            // ✅ مفتاح فريد يعتمد على الشات ورقم الرسالة لمنع التكرار
            const requestKey = `${chatId}_${message.message_id}`;

            if (!global.processingFiles) global.processingFiles = new Set();

            if (global.processingFiles.has(requestKey)) {
                console.log(`⏳ الطلب ${requestKey} مكرر (Webhook Retry) — تم التجاهل.`);
                return res.status(200).send('Duplicate processing ignored.');
            }

            // قفل الملف
            global.processingFiles.add(requestKey);

            // 🛡️ مؤقت حماية (Failsafe): يزيل القفل تلقائيًا بعد 5 دقائق إذا حدث خطأ كارثي منع الوصول للنهاية
            // هذا يحمي البوت من التعليق للأبد إذا انتهى وقت دالة Vercel
            const failsafeTimer = setTimeout(() => {
                global.processingFiles.delete(requestKey);
            }, 5 * 60 * 1000);

            let adminNotificationStatus = '';
            let adminNotificationDetails = '';

            try {
                const VERCEL_LIMIT_BYTES = 10 * 1024 * 1024;
                if (message.document.file_size > VERCEL_LIMIT_BYTES) {
                    await bot.sendMessage(chatId, `⚠️ عذرًا، حجم الملف يتجاوز الحد المسموح به (10 MB).`);
                    adminNotificationStatus = 'ملف مرفوض 🐘';
                    adminNotificationDetails = 'السبب: حجم الملف أكبر من 10 ميجا.';
                } else if (message.document.mime_type !== 'application/pdf') {
                    await bot.sendMessage(chatId, '⚠️ يرجى إرسال ملف بصيغة PDF فقط.');
                    adminNotificationStatus = 'ملف مرفوض 📄';
                    adminNotificationDetails = `السبب: نوع الملف ليس PDF (${message.document.mime_type}).`;
                } else {
                    await bot.sendMessage(chatId, '📑 استلمت الملف، جاري تحليله واستخراج الأسئلة...\n(يرجى الانتظار دقيقة...)');
                    
                    const fileLink = await bot.getFileLink(fileId);
                    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                    const dataBuffer = Buffer.from(response.data);
                    const pdfData = await pdf(dataBuffer);

                    // استخراج الأسئلة + معرفة المصدر
                    const result = await extractQuestions(pdfData.text);
                    const questions = result.questions;
                    const source = result.source; // '🤖 الذكاء الاصطناعي' أو '🧩 Regex'

                    if (questions.length > 0) {
                        userState[user.id] = { questions: questions };
                        
                        const keyboard = {
                            inline_keyboard: [
                                [{ text: 'إرسال هنا 📤', callback_data: 'send_here' }],
                                [{ text: 'إرسال وإغلاق هنا 🔒', callback_data: 'send_and_close_here'}],
                                [{ text: 'إرسال لقناة/مجموعة 📢', callback_data: 'send_to_channel' }]
                            ]
                        };
                        
                        // ✅ إرسال الرد مع توضيح المصدر (AI أم Regex)
                        await bot.sendMessage(chatId, `✅ تم العثور على ${questions.length} سؤالًا.\n⚡ طريقة التحليل: ${source}\n\nاختر أين وكيف تريد إرسالها:`, {
                            reply_markup: keyboard
                        });
                        
                        adminNotificationStatus = 'نجاح ✅';
                        adminNotificationDetails = `تم العثور على ${questions.length} سؤال.\nالمصدر: ${source}`;
                    } else {
                        await bot.sendMessage(chatId, '❌ لم أتمكن من العثور على أي أسئلة بصيغة صحيحة.');
                        adminNotificationStatus = 'نجاح (لكن فارغ) 🤷‍♂️';
                        adminNotificationDetails = 'لم يتم العثور على أسئلة.';
                    }
                }
            } catch (error) {
                console.error("Error processing PDF:", error);
                await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء معالجة الملف. يرجى المحاولة مرة أخرى.');
                adminNotificationStatus = 'فشل ❌';
                adminNotificationDetails = `السبب: ${error.message}`;
            } finally {
                // ✅ فك القفل فوراً بعد الانتهاء من المعالجة وإرسال الرد (سواء نجاح أو فشل)
                global.processingFiles.delete(requestKey);
                clearTimeout(failsafeTimer); // إلغاء مؤقت الحماية لأننا انتهينا
            }

            if (adminNotificationStatus) {
                await sendAdminNotification(adminNotificationStatus, user, fileId, adminNotificationDetails);
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
                    if (!userState[userId] || !userState[userId].pending_polls) userState[userId] = { pending_polls: {} };
                    const previewText = formatQuizText({ ...quizData, correctOptionId: null });
                    const promptText = `${previewText}\n\n*يرجى تحديد الإجابة الصحيحة:*`;
                    const keyboardButtons = quizData.options.map((option, index) => ({
                        text: String(index + 1),
                        callback_data: `poll_answer_${index}`
                    }));
                    const interactiveMessage = await bot.sendMessage(chatId, promptText, {
                        parse_mode: 'Markdown',
                        reply_to_message_id: message.message_id,
                        reply_markup: { inline_keyboard: [keyboardButtons] }
                    });
                    userState[userId].pending_polls[interactiveMessage.message_id] = quizData;
                }
            } else if (quizData.correctOptionId !== null) {
                const formattedText = formatQuizText(quizData);
                await bot.sendMessage(chatId, formattedText);
            } else {
                await bot.sendMessage(chatId, "⚠️ هذا الاختبار لا يحتوي على إجابة صحيحة.");
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
                if (!userState[userId]?.pending_polls?.[messageId]) {
                    await bot.answerCallbackQuery(callbackQuery.id, { text: 'جلسة منتهية.', show_alert: true });
                    return res.status(200).send('OK');
                }
                const poll_data = userState[userId].pending_polls[messageId];
                poll_data.correctOptionId = parseInt(data.split('_')[2], 10);
                const formattedText = formatQuizText(poll_data);
                await bot.editMessageText(formattedText, { chat_id: chatId, message_id: messageId });
                delete userState[userId].pending_polls[messageId];
                await bot.answerCallbackQuery(callbackQuery.id);
            } else {
                if (!userState[userId] || !userState[userId].questions) {
                    await bot.answerCallbackQuery(callbackQuery.id, { text: 'انتهت الجلسة.', show_alert: true });
                    return res.status(200).send('OK');
                }
                if (!gasWebAppUrl) {
                    await bot.editMessageText('⚠️ خطأ: رابط GAS غير موجود.', { chat_id: chatId, message_id: messageId });
                    return res.status(200).send('OK');
                }
                
                if (data === 'send_here' || data === 'send_and_close_here') {
                    const { questions } = userState[userId];
                    const shouldClose = data === 'send_and_close_here';
                    const payload = { questions, targetChatId: chatId, originalChatId: chatId, startIndex: 0, chatType: 'private', closePolls: shouldClose };
                    axios.post(gasWebAppUrl, payload).catch(err => console.error("GAS Error:", err.message));
                    await bot.answerCallbackQuery(callbackQuery.id);
                    await bot.editMessageText(`✅ جاري إرسال ${questions.length} سؤال...`, { chat_id: chatId, message_id: messageId });
                    delete userState[userId];
                } else if (data === 'send_to_channel') {
                    userState[userId].awaiting = 'channel_id';
                    await bot.answerCallbackQuery(callbackQuery.id);
                    await bot.editMessageText('يرجى إرسال معرف (ID) القناة الآن.', { chat_id: chatId, message_id: messageId });
                } else if (data.startsWith('confirm_send')) {
                     const { questions, targetChatId, targetChatTitle, chatType } = userState[userId];
                     const shouldClose = data.endsWith('_and_close');
                     const payload = { questions, targetChatId, originalChatId: chatId, startIndex: 0, chatType, closePolls: shouldClose };
                     axios.post(gasWebAppUrl, payload).catch(err => console.error("GAS Error:", err.message));
                     await bot.answerCallbackQuery(callbackQuery.id);
                     await bot.editMessageText(`✅ تم الإرسال إلى "${targetChatTitle}".`, { chat_id: chatId, message_id: messageId });
                     delete userState[userId];
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
            const userId = message.from.id;
            const chatId = message.chat.id;
            const text = message.text;

            if (text.toLowerCase() === '/help') {
                const fileId = 'BQACAgQAAxkBAAE72dRo2-EHmbty7PivB2ZsIz1WKkAXXgAC5BsAAtF24VLmLAPbHKW4IDYE';
                await bot.sendDocument(chatId, fileId, { caption: 'دليل المستخدم 📖' });
            } else if (userState[userId] && userState[userId].awaiting === 'channel_id') {
                const targetChatId = text.trim();
                try {
                    const chatInfo = await bot.getChat(targetChatId);
                    const botMember = await bot.getChatMember(targetChatId, (await bot.getMe()).id);
                    if (botMember.status === 'administrator' || botMember.status === 'creator') {
                        userState[userId] = { ...userState[userId], awaiting: 'send_confirmation', targetChatId: chatInfo.id, targetChatTitle: chatInfo.title, chatType: chatInfo.type };
                        const confirmationKeyboard = { 
                            inline_keyboard: [
                                [{ text: '✅ نعم، إرسال', callback_data: 'confirm_send' }],
                                [{ text: '🔒 إرسال وإغلاق', callback_data: 'confirm_send_and_close' }],
                                [{ text: '❌ إلغاء', callback_data: 'cancel_send' }]
                            ] 
                        };
                        await bot.sendMessage(chatId, `هل تريد الإرسال لـ ${chatInfo.title}؟`, { parse_mode: 'Markdown', reply_markup: confirmationKeyboard });
                    } else {
                        await bot.sendMessage(chatId, '⚠️ البوت ليس مشرفًا في القناة.');
                    }
                } catch (error) {
                    await bot.sendMessage(chatId, '❌ لم يتم العثور على القناة.');
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
    let source = '';

    // المحاولة الأولى: AI
    if (text.trim().length > 50) {
        console.log("Attempting AI extraction first...");
        try {
            questions = await extractWithGemma(text);
            if (questions.length > 0) {
                source = '🤖 الذكاء الاصطناعي (Gemma 3)';
            }
        } catch (error) {
            console.error("AI extraction failed:", error.message);
            questions = []; 
        }
    }

    // المحاولة الثانية: Regex
    if (questions.length === 0) {
        console.log("Falling back to Regex extraction...");
        try {
            questions = extractWithRegex(text);
            if (questions.length > 0) {
                source = '🧩 النمط التقليدي (Regex)';
            }
        } catch (e) {
            console.error("Regex extraction failed:", e);
            questions = [];
        }
    }

    if (questions.length === 0) {
        source = '❌ فشل الاستخراج';
    }

    return { questions, source };
}

async function extractWithGemma(text) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.log("GEMINI_API_KEY missing.");
        return [];
    }

    const modelId = 'gemma-3-27b-it'; 
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const prompt = `
    You are a strict JSON generator.
    Task: Extract all multiple-choice questions from the provided text into a RAW JSON array.
    
    Rules:
    1. Output ONLY valid JSON. No Markdown, no explanations.
    2. If no questions, return [].
    
    JSON Structure:
    {
      "question": "Question text (include number)",
      "options": ["Opt 1", "Opt 2"],
      "correctAnswerIndex": 0, // Infer if missing
      "explanation": "Explanation or null"
    }

    Text:
    """
    ${text.substring(0, 30000)} 
    """
    `; 

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192
        }
    };

    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.data.candidates || !response.data.candidates[0].content) return [];

        let jsonString = response.data.candidates[0].content.parts[0].text
            .replace(/```json/gi, '').replace(/```/g, '').trim();

        const firstBracket = jsonString.indexOf('[');
        const lastBracket = jsonString.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket !== -1) {
            jsonString = jsonString.substring(firstBracket, lastBracket + 1);
        }

        let parsed = JSON.parse(jsonString);
        if (!Array.isArray(parsed) && parsed.questions) parsed = parsed.questions;

        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.filter(q => q.question && Array.isArray(q.options)).map(q => {
                if (q.questionNumber) {
                    q.question = `${q.questionNumber}) ${q.question}`;
                    delete q.questionNumber;
                }
                return q;
            });
        }
        return [];

    } catch (error) {
        console.error("Gemma API Error:", error.message);
        return [];
    }
}

function extractWithRegex(text) {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const questions = [];
    const qPattern = /^(Q\d+|السؤال|\d+[\.\-\)])\s*(.+)/i;
    const optPattern = /^([A-D]|[أ-د]|\d+)[\.\-\)]\s*(.+)/i;
    
    let currentQ = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const qMatch = line.match(qPattern);
        if (qMatch && !line.match(optPattern)) {
            if (currentQ) questions.push(currentQ);
            currentQ = { question: line, options: [], correctAnswerIndex: 0 };
            continue;
        }
        const optMatch = line.match(optPattern);
        if (currentQ && optMatch) {
            currentQ.options.push(optMatch[2]);
            if (line.includes('*') || line.includes('✅')) currentQ.correctAnswerIndex = currentQ.options.length - 1;
        }
    }
    if (currentQ) questions.push(currentQ);
    return questions;
}

function formatQuizText(quizData) {
    let text = `${quizData.question}\n\n`;
    quizData.options.forEach((opt, i) => text += `${i+1}) ${opt}\n`);
    if (quizData.correctOptionId !== null) text += `\n✅ الإجابة: ${quizData.options[quizData.correctOptionId]}`;
    if (quizData.explanation) text += `\n📝 الشرح: ${quizData.explanation}`;
    return text;
  }
