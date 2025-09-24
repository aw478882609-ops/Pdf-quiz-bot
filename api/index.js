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
            } else {
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

// ... باقي الدوال المساعدة (extractQuestions, formatQuizText) تبقى كما هي بدون تغيير ...

function extractQuestions(text) {
    // الخطوة 1: توحيد وتنظيف النص
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\f/g, '\n').replace(/\u2028|\u2029/g, '\n');
    text = text.replace(/\n{2,}/g, '\n');

    const lines = text.split('\n').map(l => l.trim());
    const questions = [];
    let i = 0;

    // [تجميع] كل الأنماط الشاملة للأسئلة والخيارات
    const questionPatterns = [/^(Q|Question|Problem|Quiz|السؤال)?\s*\d+[\s\.\)\]]/i];
    // النسخة النهائية والمُدمجة
const letterOptionPatterns = [
    // نمط مرن وشامل يغطي:
    // "A." أو "A)" أو "A-"
    // وأيضًا "- A." أو "* B." (مع رمز في البداية)
    /^\s*[\-\*]?\s*([A-Z])[\.\)\-]\s*(.+)/i,

    // نمط منفصل ومهم لدعم "A - " (مع مسافات حول الشرطة)
    /^\s*([A-Z])\s*-\s*(.+)/i,

    // نمط الأقواس الذي كان موجودًا بالفعل مثل "(A)" أو "[B]"
    /^\s*[\(\[\{]([A-Z])[\)\]\}]\s*(.+)/i,
];
    // النسخة النهائية والمُدمجة
const numberOptionPatterns = [
    // نمط مرن وشامل يغطي:
    // "1." أو "1)" أو "1-"
    // وأيضًا "- 1." أو "* 2." (مع رمز في البداية)
    /^\s*[\-\*]?\s*(\d+)[\.\)\-]\s*(.+)/,

    // نمط منفصل ومهم لدعم "1 - " (مع مسافات حول الشرطة)
    /^\s*(\d+)\s*-\s*(.+)/,

    // نمط الأقواس الذي كان موجودًا بالفعل مثل "(1)" أو "[2]"
    /^\s*[\(\[\{](\d+)[\)\]\}]\s*(.+)/,
];
    
    // النسخة النهائية والمُدمجة
const romanOptionPatterns = [
    // تم تحسينه ليدعم "I." أو "I)" وأيضًا "I-"
    /^\s*([IVXLCDM]+)[\.\)\-]\s*(.+)/i,
];
    // دمج كل أنماط الخيارات معًا
    const optionPatterns = [...letterOptionPatterns, ...numberOptionPatterns, ...romanOptionPatterns];

    // الكود الجديد بعد إضافة كل الرموز
    // الكود الجديد والمُحسَّن
const answerPatterns = [/^\s*[\-\*]?\s*(Answer|Correct Answer|Solution|Ans|Sol|The right answer is)\s*[:\-\.,;\/]?\s*/i];

    function findMatch(line, patterns) { for (const pattern of patterns) { const match = line.match(pattern); if (match) return match; } return null; }

    // [تطوير] دالة جديدة للتحقق من النوع والتسلسل لجميع الأنماط
    function validateOptionsSequence(optionLines) {
        if (optionLines.length < 2) return true;

        let style = null;
        let lastValue = null;

        // دالة مساعدة لتحويل الأرقام الرومانية إلى أرقام عادية
        function romanToNumber(roman) {
            const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
            let num = 0;
            for (let i = 0; i < roman.length; i++) {
                const current = map[roman[i]];
                const next = map[roman[i + 1]];
                if (next > current) {
                    num -= current;
                } else {
                    num += current;
                }
            }
            return num;
        }

        for (let j = 0; j < optionLines.length; j++) {
            const line = optionLines[j];
            let currentStyle = null;
            let currentValue = null;
            let identifier = '';

            if (findMatch(line, numberOptionPatterns)) {
                currentStyle = 'numbers';
                identifier = findMatch(line, numberOptionPatterns)[1];
                currentValue = parseInt(identifier, 10);
            } else if (findMatch(line, letterOptionPatterns)) {
                currentStyle = 'letters';
                identifier = findMatch(line, letterOptionPatterns)[1].toUpperCase();
                currentValue = identifier.charCodeAt(0);
            } else if (findMatch(line, romanOptionPatterns)) {
                currentStyle = 'roman';
                identifier = findMatch(line, romanOptionPatterns)[1].toUpperCase();
                currentValue = romanToNumber(identifier);
            } else {
                return false; // ليس خيارًا صالحًا
            }

            if (j === 0) {
                // تحديد النوع والقيمة الأولية من أول خيار
                style = currentStyle;
                lastValue = currentValue;
            } else {
                // التحقق من تطابق النوع ومن التسلسل
                if (currentStyle !== style || currentValue !== lastValue + 1) {
                    return false;
                }
                lastValue = currentValue;
            }
        }
        return true;
    }


    // [تعديل جذري] منطق جديد للبحث الذكي عن بداية كتلة السؤال
    while (i < lines.length) {
        const line = lines[i];
        if (!line) { i++; continue; }

       const optionInFollowingLines = lines.slice(i + 1).some(l => findMatch(l, optionPatterns));
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
                if (optionMatch) {
                    optionLines.push(optLine);
                    currentQuestion.options.push(optionMatch[2].trim());
                    k++;
                } else {
                    break;
                }
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
                        // منطق ذكي لتحديد الإجابة الصحيحة بناءً على نوع ترقيم الخيارات
                        const firstOptionLine = optionLines[0];
                        if(findMatch(firstOptionLine, numberOptionPatterns)) {
                            correctIndex = parseInt(identifierMatch[0], 10) - 1;
                        } else if(findMatch(firstOptionLine, letterOptionPatterns)) {
                            correctIndex = identifierMatch[0].toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
                        } else if(findMatch(firstOptionLine, romanOptionPatterns)) {
                             correctIndex = romanToNumber(identifierMatch[0].toUpperCase()) - 1;
                        }
                    }
                }
                 if (correctIndex >= 0 && correctIndex < currentQuestion.options.length) {
                    currentQuestion.correctAnswerIndex = correctIndex;
                 }
                i = k + 1;
            } else {
                i = k;
            }

            if (currentQuestion.options.length > 1 && currentQuestion.correctAnswerIndex !== undefined) {
                questions.push(currentQuestion);
            }
        } else {
            i++;
        }
    }
    return questions;
}
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
