// ==== بداية كود Vercel الكامل والصحيح (api/index.js) ====

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

// تهيئة البوت
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

// متغير لتخزين حالة المستخدم مؤقتًا
const userState = {};
// ==== ضع هذا الكود قبل دالة module.exports ====

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

/**
 * دالة لإرسال إشعار للمشرف (لا ترسل شيئًا إذا كان المستخدم هو المشرف نفسه).
 */
async function sendAdminNotification(status, user, fileId, details = '') {
  // <<-- التعديل الجديد: التحقق إذا كان المستخدم هو المشرف
  // نقارن كنص لضمان الدقة (لأن متغير البيئة يكون نصًا)
  if (String(user.id) === ADMIN_CHAT_ID) {
    console.log("User is the admin. Skipping self-notification.");
    return; // الخروج من الدالة فورًا
  }

  if (!ADMIN_CHAT_ID) {
    console.log("ADMIN_CHAT_ID is not set. Skipping notification.");
    return;
  }

  // بناء نص الشرح (caption)
  const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  const userUsername = user.username ? `@${user.username}` : 'لا يوجد';
  let captionText = `🔔 *إشعار معالجة ملف* 🔔\n\n`;
  captionText += `*الحالة:* ${status}\n\n`;
  captionText += `*من المستخدم:* ${userName} (${userUsername})\n\n`;
  captionText += `*ID المستخدم:* \`${user.id}\`\n\n`;
  if (details) {
    captionText += `*تفاصيل:* ${details}\n`;
  }

  try {
    await bot.sendDocument(ADMIN_CHAT_ID, fileId, {
        caption: captionText,
        parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error("Failed to send document notification to admin:", error.message);
  }
}
// وحدة التعامل مع الطلبات
// وحدة التعامل مع الطلبات (النسخة النهائية والمصححة)
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

            // متغيرات لتخزين الحالة النهائية للإشعار
            let adminNotificationStatus = '';
            let adminNotificationDetails = '';

            const VERCEL_LIMIT_BYTES = 10 * 1024 * 1024;
            if (message.document.file_size > VERCEL_LIMIT_BYTES) {
                await bot.sendMessage(chatId, `⚠️ عذرًا، حجم الملف يتجاوز الحد المسموح به (${'10 MB'}).`);
                adminNotificationStatus = 'ملف مرفوض 🐘';
                adminNotificationDetails = 'السبب: حجم الملف أكبر من 10 ميجا.';
            } else if (message.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '⚠️ يرجى إرسال ملف بصيغة PDF فقط.');
                adminNotificationStatus = 'ملف مرفوض 📄';
                adminNotificationDetails = `السبب: نوع الملف ليس PDF (النوع المرسل: ${message.document.mime_type}).`;
            } else {
                await bot.sendMessage(chatId, '📑 استلمت الملف، جاري تحليله واستخراج الأسئلة...');
                try {
                    const fileLink = await bot.getFileLink(fileId);
                    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                    const dataBuffer = Buffer.from(response.data);
                    const pdfData = await pdf(dataBuffer);
                    const questions = extractQuestions(pdfData.text);

                    if (questions.length > 0) {
                        userState[user.id] = { questions: questions };
                        // ✨ التعديل: إضافة زر "إرسال وإغلاق"
                        const keyboard = {
                            inline_keyboard: [
                                [{ text: 'إرسال هنا 📤', callback_data: 'send_here' }],
                                [{ text: 'إرسال وإغلاق هنا 🔒', callback_data: 'send_and_close_here'}], //  <-- الزر الجديد
                                [{ text: 'إرسال لقناة/مجموعة 📢', callback_data: 'send_to_channel' }]
                            ]
                        };
                        await bot.sendMessage(chatId, `✅ تم العثور على ${questions.length} سؤالًا.\n\nاختر أين وكيف تريد إرسالها:`, {
                            reply_markup: keyboard
                        });
                        adminNotificationStatus = 'نجاح ✅';
                        adminNotificationDetails = `تم العثور على ${questions.length} سؤال.`;
                    } else {
                        await bot.sendMessage(chatId, '❌ لم أتمكن من العثور على أي أسئلة بصيغة صحيحة في الملف. للمساعدة اضغط /help');
                        adminNotificationStatus = 'نجاح (لكن فارغ) 🤷‍♂️';
                        adminNotificationDetails = 'تمت معالجة الملف لكن لم يتم العثور على أسئلة.';
                    }
                } catch (error) {
                    console.error("Error processing PDF:", error);
                    await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء معالجة الملف. يرجى التأكد من أن الملف سليم وغير تالف. للمساعدة اضغط /help');
                    adminNotificationStatus = 'فشل ❌';
                    adminNotificationDetails = `السبب: ${error.message}`;
                }
            }

            // إرسال الإشعار المجمع في النهاية
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
        // ✨ التحسين الجديد: التحقق من وجود إجابة في الاختبار المعاد توجيهه
        if (quizData.correctOptionId !== null && quizData.correctOptionId >= 0) {
            // إذا كانت الإجابة موجودة، يتم تحويل الاختبار إلى نص مباشرة
            const formattedText = formatQuizText(quizData);
            await bot.sendMessage(chatId, formattedText, {
                reply_to_message_id: message.message_id // للرد على الرسالة الأصلية
            });
        } else {
            // إذا لم تكن الإجابة موجودة، نطلب من المستخدم تحديدها (السلوك القديم)
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
        // هذا الجزء يبقى كما هو للتعامل مع الاختبارات التي يتم إنشاؤها مباشرة
        if (quizData.correctOptionId !== null && quizData.correctOptionId >= 0) {
            const formattedText = formatQuizText(quizData);
            await bot.sendMessage(chatId, formattedText);
        } else {
            await bot.sendMessage(chatId, "⚠️ هذا الاختبار لا يحتوي على إجابة صحيحة، لا يمكن تحويله تلقائيًا.");
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
                    await bot.answerCallbackQuery(callbackQuery.id, { text: 'هذه الجلسة انتهت أو تمت معالجتها.', show_alert: true });
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
            } else {
                if (!userState[userId] || !userState[userId].questions) {
                    await bot.answerCallbackQuery(callbackQuery.id, { text: 'انتهت جلسة استخراج الملف، يرجى إرسال الملف مرة أخرى.', show_alert: true });
                    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
                    return res.status(200).send('OK');
                }
                if (!gasWebAppUrl) {
                    await bot.editMessageText('⚠️ خطأ في الإعدادات: رابط خدمة الإرسال الخارجية غير موجود.', { chat_id: chatId, message_id: messageId });
                    return res.status(200).send('OK');
                }
                // ✨ التعديل: التعامل مع الزر الجديد
                if (data === 'send_here' || data === 'send_and_close_here') {
                    const { questions } = userState[userId];
                    const shouldClose = data === 'send_and_close_here'; // تحديد ما إذا كان يجب الإغلاق
                    const payload = {
                        questions,
                        targetChatId: chatId,
                        originalChatId: chatId,
                        startIndex: 0,
                        chatType: 'private',
                        closePolls: shouldClose //  <-- إرسال الحالة الجديدة
                    };
                    axios.post(gasWebAppUrl, payload).catch(err => console.error("Error calling GAS:", err.message));
                    await bot.answerCallbackQuery(callbackQuery.id);
                    await bot.editMessageText(`✅ تم إرسال المهمة للخدمة الخارجية.\n\nسيتم إرسال ${questions.length} سؤالًا هنا في الخلفية.`, { chat_id: chatId, message_id: messageId });
                    delete userState[userId];
                } else if (data === 'send_to_channel') {
                    userState[userId].awaiting = 'channel_id';
                    await bot.answerCallbackQuery(callbackQuery.id);
                    await bot.editMessageText('يرجى إرسال معرف (ID) القناة أو المجموعة الآن.\n(مثال: @username أو -100123456789)', { chat_id: chatId, message_id: messageId });

                // ✨ التعديل: التعامل مع تأكيد الإرسال للقناة
                } else if (data.startsWith('confirm_send')) { // تم تعديل الشرط ليبدأ بـ 'confirm_send'
                    if (userState[userId] && userState[userId].awaiting === 'send_confirmation') {
                        const { questions, targetChatId, targetChatTitle, chatType } = userState[userId];
                        const shouldClose = data.endsWith('_and_close'); // التحقق من نوع الإرسال
                        const payload = {
                            questions,
                            targetChatId,
                            originalChatId: chatId,
                            startIndex: 0,
                            chatType,
                            closePolls: shouldClose //  <-- إرسال الحالة الجديدة
                        };
                        axios.post(gasWebAppUrl, payload).catch(err => console.error("Error calling GAS:", err.message));
                        await bot.answerCallbackQuery(callbackQuery.id);
                        await bot.editMessageText(`✅ تم إرسال المهمة للخدمة الخارجية.\n\nسيتم إرسال ${questions.length} سؤالًا في الخلفية إلى "${targetChatTitle}".`, { chat_id: chatId, message_id: messageId });
                        delete userState[userId];
                    }
                } else if (data === 'cancel_send') {
                    await bot.answerCallbackQuery(callbackQuery.id);
                    await bot.editMessageText('❌ تم إلغاء العملية.', { chat_id: chatId, message_id: messageId });
                    delete userState[userId];
                }
            }
        }

        // 4️⃣ التعامل مع الرسائل النصية (ID القناة، /start، إلخ)
        else if (update.message && update.message.text) {
            const message = update.message;
            const userId = message.from.id;
            const chatId = message.chat.id;
            const text = message.text;

          if (text.toLowerCase() === '/help') {
                const fileId = 'BQACAgQAAxkBAAE7DSpoxZngmTGzsB_8dwKoygzU0Kag6wAC4hgAAoEOKVIe8Plc9LwL8TYE'; // استبدل هذا بـ file_id لملف PDF الخاص بك
                await bot.sendDocument(chatId, fileId, {
                    caption: 'مرحباً بك! 👋\n\nإليك دليل المستخدم الشامل للبوت بصيغة PDF. 📖'
                });
            }

             if (userState[userId] && userState[userId].awaiting === 'channel_id') {
                const targetChatId = text.trim();
                try {
                    const chatInfo = await bot.getChat(targetChatId);
                    const botMember = await bot.getChatMember(targetChatId, (await bot.getMe()).id);
                    let infoText = `*-- معلومات الهدف --*\n`;
                    infoText += `👤 *الاسم:* ${chatInfo.title}\n`;
                    infoText += `🆔 *المعرف:* \`${chatInfo.id}\`\n\n`;
                    infoText += `*-- صلاحيات البوت --*\n`;
                    let canProceed = false;
                    if (botMember.status === 'administrator' || botMember.status === 'creator') {
                        infoText += `▫️ *الحالة:* مشرف (Admin)\n`;
                        const canPost = botMember.can_post_messages;
                        const canStopPoll = botMember.can_stop_polls; //  <-- التحقق من صلاحية إغلاق الاستطلاعات
                        infoText += `▫️ *إرسال الرسائل:* ${canPost ? '✅ يستطيع' : '❌ لا يستطيع'}\n`;
                        infoText += `▫️ *إيقاف الاستطلاعات:* ${canStopPoll ? '✅ يستطيع' : '❌ لا يستطيع'}\n`; //  <-- عرض الصلاحية
                        if (canPost) canProceed = true;
                    } else {
                        infoText += `▫️ *الحالة:* مجرد عضو 🤷‍♂️\n`;
                    }
                    infoText += `\n---------------------\n`;
                    if (canProceed) {
                        userState[userId] = {
                            ...userState[userId],
                            awaiting: 'send_confirmation',
                            targetChatId: chatInfo.id,
                            targetChatTitle: chatInfo.title,
                            chatType: chatInfo.type
                        };
                        infoText += `هل أنت متأكد أنك تريد إرسال ${userState[userId].questions.length} سؤالًا؟`;
                        // ✨ التعديل: إضافة أزرار جديدة لتأكيد الإرسال مع الإغلاق
                        const confirmationKeyboard = {
                            inline_keyboard: [
                                [{ text: '✅ نعم، إرسال فقط', callback_data: 'confirm_send' }],
                                [{ text: '🔒 نعم، إرسال وإغلاق', callback_data: 'confirm_send_and_close' }],
                                [{ text: '❌ إلغاء', callback_data: 'cancel_send' }]
                            ]
                        };
                        await bot.sendMessage(chatId, infoText, { parse_mode: 'Markdown', reply_markup: confirmationKeyboard });
                    } else {
                        infoText += `⚠️ لا يمكن المتابعة. الصلاحيات غير كافية.`;
                        await bot.sendMessage(chatId, infoText, { parse_mode: 'Markdown' });
                    }
                } catch (error) {
                    await bot.sendMessage(chatId, '❌ فشل! لم أتمكن من العثور على هذه القناة/المجموعة أو أن البوت ليس عضوًا فيها.');
                }
            }
        }
    } catch (error) {
        console.error("General error:", error);
    }
    res.status(200).send('OK');
};

// ==== بداية دالة استخراج الأسئلة المعدلة ====
function extractQuestions(text) {
    // الخطوة 1: توحيد وتنظيف النص
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\f/g, '\n').replace(/\u2028|\u2029/g, '\n');
    text = text.replace(/\n{2,}/g, '\n');

    const lines = text.split('\n').map(l => l.trim());
    const questions = [];
    let i = 0;

    // [تجميع] كل الأنماط الشاملة للأسئلة والخيارات
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
    const romanOptionPatterns = [
        /^\s*([IVXLCDM]+)[\.\)\-]\s*(.+)/i,
    ];
    const optionPatterns = [...letterOptionPatterns, ...numberOptionPatterns, ...romanOptionPatterns];
    const answerPatterns = [/^\s*[\-\*]?\s*(Answer|Correct Answer|Solution|Ans|Sol)\s*[:\-\.,;\/]?\s*/i];
    // ** التعديل الجديد: إضافة نمط للشرح **
    const explanationPattern = /^\s*Rationale\s*\/\s*Explanation\s*:\s*(.*)/i;


    function findMatch(line, patterns) { for (const pattern of patterns) { const match = line.match(pattern); if (match) return match; } return null; }

    function romanToNumber(roman) {
        const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
        let num = 0;
        for (let i = 0; i < roman.length; i++) {
            const current = map[roman[i].toUpperCase()];
            const next = map[roman[i + 1] ? roman[i + 1].toUpperCase() : ''];
            if (next > current) { num -= current; } else { num += current; }
        }
        return num;
    }

    function validateOptionsSequence(optionLines) {
        if (optionLines.length < 2) return true;
        let style = null; let lastValue = null;
        for (let j = 0; j < optionLines.length; j++) {
            const line = optionLines[j]; let currentStyle = null; let currentValue = null;
            if (findMatch(line, numberOptionPatterns)) {
                currentStyle = 'numbers'; currentValue = parseInt(findMatch(line, numberOptionPatterns)[1], 10);
            } else if (findMatch(line, letterOptionPatterns)) {
                currentStyle = 'letters'; currentValue = findMatch(line, letterOptionPatterns)[1].toUpperCase().charCodeAt(0);
            } else if (findMatch(line, romanOptionPatterns)) {
                currentStyle = 'roman'; currentValue = romanToNumber(findMatch(line, romanOptionPatterns)[1].toUpperCase());
            } else { return false; }
            if (j === 0) { style = currentStyle; lastValue = currentValue; }
            else { if (currentStyle !== style || currentValue !== lastValue + 1) { return false; } lastValue = currentValue; }
        }
        return true;
    }

    while (i < lines.length) {
        let line = lines[i];
        if (!line) { i++; continue; }

        const isQuestionStart = findMatch(line, questionPatterns) || (lines.slice(i + 1).some(l => findMatch(l, optionPatterns)) && !findMatch(line, optionPatterns) && !findMatch(line, answerPatterns));
        if (!isQuestionStart) { i++; continue; }

        let questionText = line;
        let optionsStartIndex = -1;
        let j = i + 1;
        while (j < lines.length && !findMatch(lines[j], optionPatterns)) {
            questionText += ' ' + lines[j].trim();
            j++;
        }
        optionsStartIndex = j;

        if (optionsStartIndex < lines.length) {
            const currentQuestion = { question: questionText.trim(), options: [], correctAnswerIndex: undefined, explanation: '' };
            const optionLines = [];
            let k = optionsStartIndex;
            while (k < lines.length) {
                const optLine = lines[k];
                const optionMatch = findMatch(optLine, optionPatterns);
                if (optionMatch) {
                    optionLines.push(optLine);
                    currentQuestion.options.push(optionMatch[2].trim());
                    k++;
                } else {
                    break;
                }
            }

            if (!validateOptionsSequence(optionLines)) { i++; continue; }

            let answerIndex = k;
            if (answerIndex < lines.length && findMatch(lines[answerIndex], answerPatterns)) {
                const answerLine = lines[answerIndex];
                let answerText = answerLine.replace(answerPatterns[0], '').trim();
                let correctIndex = -1;

                const cleanAnswerText = answerText.replace(/^[A-Z\dIVXLCDM]+[\.\)]\s*/i, '').trim();
                correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === cleanAnswerText.toLowerCase());

                if (correctIndex === -1) {
                    const identifierMatch = answerText.match(/^[A-Z\dIVXLCDM]+/i);
                    if (identifierMatch) {
                        const firstOptionLine = optionLines[0];
                        if (findMatch(firstOptionLine, numberOptionPatterns)) { correctIndex = parseInt(identifierMatch[0], 10) - 1; }
                        else if (findMatch(firstOptionLine, letterOptionPatterns)) { correctIndex = identifierMatch[0].toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0); }
                        else if (findMatch(firstOptionLine, romanOptionPatterns)) { correctIndex = romanToNumber(identifierMatch[0].toUpperCase()) - 1; }
                    }
                }
                if (correctIndex >= 0 && correctIndex < currentQuestion.options.length) {
                    currentQuestion.correctAnswerIndex = correctIndex;
                }
                answerIndex++;
            }

            // **منطق استخراج الشرح الجديد**
            let explanationText = '';
            let rationaleFound = false;
            let l = answerIndex;
            while (l < lines.length) {
                const currentLine = lines[l];
                if (findMatch(currentLine, questionPatterns)) {
                    break; // توقف عند السؤال التالي
                }

                if (!rationaleFound) {
                    const rationaleMatch = currentLine.match(explanationPattern);
                    if (rationaleMatch) {
                        rationaleFound = true;
                        if (rationaleMatch[1]) { // إذا كان هناك نص في نفس سطر البداية
                            explanationText += rationaleMatch[1].trim() + ' ';
                        }
                    }
                } else {
                    // تجاهل أرقام الصفحات والأسطر الفارغة
                    if (currentLine.trim() && !/^\s*Page\s*\d+\s*$/.test(currentLine.trim())) {
                        explanationText += currentLine.trim() + ' ';
                    }
                }
                l++;
            }

            if (explanationText) {
                currentQuestion.explanation = explanationText.trim();
            }

            if (currentQuestion.options.length > 1 && currentQuestion.correctAnswerIndex !== undefined) {
                questions.push(currentQuestion);
            }
            i = l; // تحديث العداد الرئيسي
        } else {
            i++;
        }
    }
    return questions;
}
// ==== نهاية دالة استخراج الأسئلة المعدلة ====

 function formatQuizText(quizData) {
    // السؤال مع سطر فارغ بعده
    let formattedText = ` ${quizData.question}\n\n`;
    const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

    // الخيارات بدون سطر فارغ بينها
    const formattedOptions = quizData.options.map((optionText, optIndex) => {
        return `${optionLetters[optIndex]}) ${optionText}`;
    });
    formattedText += formattedOptions.join('\n'); // **التعديل هنا**

    // الإجابة مع سطر فارغ قبلها
    if (quizData.correctOptionId !== null && quizData.correctOptionId >= 0) {
        const correctLetter = optionLetters[quizData.correctOptionId];
        const correctText = quizData.options[quizData.correctOptionId];
        formattedText += `\n\nAnswer: ${correctLetter}) ${correctText}`;
    }

    if (quizData.explanation) {
        formattedText += `\nExplanation: ${quizData.explanation}`;
    }
    return formattedText;
}
