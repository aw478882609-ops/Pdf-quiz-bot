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
            const userId = message.from.id;
            const fileId = message.document.file_id;

            // التحقق من حجم الملف
            const VERCEL_LIMIT_BYTES = 10 * 1024 * 1024;
            if (message.document.file_size > VERCEL_LIMIT_BYTES) {
                await bot.sendMessage(chatId, `⚠️ عذرًا، حجم الملف يتجاوز الحد المسموح به (${'10 MB'}).`);
                return res.status(200).send('OK');
            }

            if (message.document.mime_type !== 'application/pdf') {
                await bot.sendMessage(chatId, '⚠️ يرجى إرسال ملف بصيغة PDF فقط.');
                return res.status(200).send('OK');
            }

            await bot.sendMessage(chatId, '📑 استلمت الملف، جاري تحليله واستخراج الأسئلة...');
            // ... باقي كود تحليل PDF ...
            // (لقد اختصرته هنا لأنه لم يتغير، لكن تأكد من أنه موجود في نسختك)
             try {
                const fileLink = await bot.getFileLink(fileId);
                const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                const dataBuffer = Buffer.from(response.data);
                const pdfData = await pdf(dataBuffer);
                const questions = extractQuestions(pdfData.text);

                if (questions.length > 0) {
                    userState[userId] = { questions: questions };
                    const keyboard = {
                        inline_keyboard: [
                            [{ text: 'إرسال هنا 📤', callback_data: 'send_here' }],
                            [{ text: 'إرسال لقناة/مجموعة 📢', callback_data: 'send_to_channel' }]
                        ]
                    };
                    await bot.sendMessage(chatId, `✅ تم العثور على ${questions.length} سؤالًا.\n\nاختر أين تريد إرسالها:`, {
                        reply_markup: keyboard
                    });
                } else {
                    await bot.sendMessage(chatId, '❌ لم أتمكن من العثور على أي أسئلة بصيغة صحيحة في الملف. للمساعدة اضغط /help');
                }
            } catch (error) {
                console.error("Error processing PDF:", error);
                await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء معالجة الملف. يرجى التأكد من أن الملف سليم وغير تالف. للمساعدة اضغط /help');
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
            // ... الكود الكامل والصحيح الخاص بـ callback_query من الردود السابقة ...
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
                if (!gasWebAppUrl && (data === 'send_here' || data === 'confirm_send')) {
                    await bot.editMessageText('⚠️ خطأ في الإعدادات: رابط خدمة الإرسال الخارجية غير موجود.', { chat_id: chatId, message_id: messageId });
                    return res.status(200).send('OK');
                }
                if (data === 'send_here') {
                    const { questions } = userState[userId];
                    const payload = { questions, targetChatId: chatId, originalChatId: chatId, startIndex: 0, chatType: 'private' };
                    axios.post(gasWebAppUrl, payload).catch(err => console.error("Error calling GAS:", err.message));
                    await bot.answerCallbackQuery(callbackQuery.id);
                    await bot.editMessageText(`✅ تم إرسال المهمة للخدمة الخارجية.\n\nسيتم إرسال ${questions.length} سؤالًا هنا في الخلفية.`, { chat_id: chatId, message_id: messageId });
                    delete userState[userId];
                } else if (data === 'send_to_channel') {
                    userState[userId].awaiting = 'channel_id';
                    await bot.answerCallbackQuery(callbackQuery.id);
                    await bot.editMessageText('يرجى إرسال معرف (ID) القناة أو المجموعة الآن.\n(مثال: @username أو -100123456789)', { chat_id: chatId, message_id: messageId });
                } else if (data === 'confirm_send') {
                    if (userState[userId] && userState[userId].awaiting === 'send_confirmation') {
                        const { questions, targetChatId, targetChatTitle, chatType } = userState[userId];
                        const payload = { questions, targetChatId, originalChatId: chatId, startIndex: 0, chatType };
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
                        infoText += `▫️ *إرسال الرسائل:* ${canPost ? '✅ يستطيع' : '❌ لا يستطيع'}\n`;
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
                        const confirmationKeyboard = { inline_keyboard: [[{ text: '✅ نعم، قم بالإرسال', callback_data: 'confirm_send' }, { text: '❌ إلغاء', callback_data: 'cancel_send' }]] };
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

function extractQuestions(text) {
    // 1. تنظيف النص الأولي
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').map(l => l.trim().replace(/^"|"$/g, ''));
    const questions = [];

    // 2. تعريف الأنماط والدوال المساعدة
    const optionLetter = 'A-Z|क-ह|ि';
    const optionPatterns = [
        new RegExp(`^\\s*[\\-\\*]?\\s*([${optionLetter}])\\s*-\\s*(.+)`, 'i'),
        new RegExp(`^\\s*[\\-\\*]?\\s*([${optionLetter}])[\\.\\)]\\s*(.+)`, 'i'),
        new RegExp(`^\\s*[\\(\\[\\{]([${optionLetter}])[\\)\\]\\}]\\s*(.+)`, 'i'),
        /^\s*[\-\*]?\s*(\d+)[\.\)\-]\s*(.+)/,
        /^\s*[\-\*]?\s*(\d+)\s*-\s*(.+)/,
        /^\s*[\(\[\{](\d+)[\)\]\}]\s*(.+)/,
    ];
    
    const answerPattern = /^\s*[\-\*]?\s*(?:सही उत्तर|उत्तर)(?:ः)?\s*[:\-\.,;\/]?\s*(.+)/i;
    const devanagariMap = { 'क': 0, 'ख': 1, 'ग': 2, 'घ': 3, 'ङ': 4, 'ि': 0 };

    const isOption = (line) => line && optionPatterns.some(p => p.test(line));
    const isAnswer = (line) => line && answerPattern.test(line);
    
    const getOptionParts = (line) => {
        for (const pattern of optionPatterns) {
            const match = line.match(pattern);
            if (match) return match;
        }
        return null;
    };

    // **منطق جديد كليًا للتعرف على بداية السؤال**
    const isQuestionStart = (index) => {
        const line = lines[index];
        if (!line) return false;
        if (isAnswer(line)) return false;

        // الحالة 1: يبدأ برقم ولكنه ليس خيارًا (أكثر دقة)
        if (/^\d+/.test(line) && !isOption(line)) {
            return true;
        }
        
        // الحالة 2: لا يبدأ برقم، ليس خيارًا، ولكن يليه خيار (للأسئلة غير المرقمة)
        if (!/^\d+/.test(line) && !isOption(line)) {
            let nextLineIndex = index + 1;
            while (nextLineIndex < lines.length && !lines[nextLineIndex]) {
                nextLineIndex++; // تجاهل الأسطر الفارغة
            }
            if (nextLineIndex < lines.length && isOption(lines[nextLineIndex])) {
                return true;
            }
        }
        return false;
    };

    // 3. الحلقة الرئيسية لتحليل النص
    let i = 0;
    while (i < lines.length) {
        if (!isQuestionStart(i)) {
            i++;
            continue;
        }

        let questionText = lines[i];
        const options = [];
        let correctAnswerIndex = undefined;
        let k = i + 1;

        // --- تجميع نص السؤال الكامل ---
        while (k < lines.length && !isOption(lines[k])) {
            if (isQuestionStart(k) || isAnswer(lines[k])) break;
            if (lines[k]) { questionText += ' ' + lines[k]; }
            k++;
        }

        // --- تجميع الخيارات الكاملة ---
        while (k < lines.length) {
            const line = lines[k];
            if (!line) { k++; continue; }
            if (isAnswer(line) || isQuestionStart(k)) break;

            const optParts = getOptionParts(line);
            if (optParts) {
                let optionText = optParts[2].trim();
                let next_k = k + 1;
                while (next_k < lines.length) {
                    const nextLine = lines[next_k];
                    if (!nextLine) { next_k++; continue; }
                    if (isOption(nextLine) || isAnswer(nextLine) || isQuestionStart(next_k)) break;
                    optionText += ' ' + nextLine;
                    next_k++;
                }
                options.push(optionText);
                k = next_k;
            } else { break; }
        }
        
        // --- تجميع الإجابة ---
        if (k < lines.length && isAnswer(lines[k])) {
            const answerMatch = lines[k].match(answerPattern);
            if (answerMatch) {
                let answerIdentifier = answerMatch[1].trim().replace(/[()\[\]{}\.\)]/g, '');
                if (devanagariMap.hasOwnProperty(answerIdentifier)) {
                    correctAnswerIndex = devanagariMap[answerIdentifier];
                } else if (/^[A-Z]$/i.test(answerIdentifier)) {
                    correctAnswerIndex = answerIdentifier.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
                } else if (/^\d+$/.test(answerIdentifier)) {
                    correctAnswerIndex = parseInt(answerIdentifier, 10) - 1;
                }
            }
            k++;
        }

        // --- حفظ السؤال ---
        if (questionText.trim() && options.length >= 2 && correctAnswerIndex !== undefined) {
            questions.push({
                question: questionText.trim(),
                options: options,
                correctAnswerIndex: correctAnswerIndex
            });
        }
        i = k;
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

