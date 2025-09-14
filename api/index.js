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
        const fileId = 'BQACAgQAAxkBAAE7DSpoxZngmTGzsB_8dwKoygzU0Kag6wAC4hgAAoEOKVIe8Plc9LwL8TYE';
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

// ===============================================================================================
// ==== بداية دالة استخراج الأسئلة النهائية (النسخة الأكثر قوة واستقرارًا) ====
// ===============================================================================================
function extractQuestions(text) {
    // 1. التنظيف الأولي للسطور وإزالة أي علامات اقتباس زائدة
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').map(l => l.trim().replace(/^"|"$/g, ''));

    // 2. تعريف جميع الأنماط المدعومة بشكل كامل
    const letterOptionPatterns = [ /^\s*[\-\*]?\s*([A-Z])[\.\)\-]\s*(.+)/i, /^\s*([A-Z])\s*-\s*(.+)/i, /^\s*[\(\[\{]([A-Z])[\)\]\}]\s*(.+)/i ];
    const numberOptionPatterns = [ /^\s*[\-\*]?\s*(\d+)[\.\)\-]\s*(.+)/, /^\s*(\d+)\s*-\s*(.+)/, /^\s*[\(\[\{](\d+)[\)\]\}]\s*(.+)/ ];
    const romanOptionPatterns = [ /^\s*([IVXLCDM]+)[\.\)\-]\s*(.+)/i ];
    const devanagariOptionPatterns = [ /^\s*[\(\[\{]([क-ह]|ि)[\)\]\}]\s*(.+)/, /^\s*([क-ह]|ि)[\.\)]\s*(.+)/ ];
    
    const optionPatterns = [...letterOptionPatterns, ...numberOptionPatterns, ...romanOptionPatterns, ...devanagariOptionPatterns];
    
    const answerPattern = /^\s*[\-\*]?\s*(?:सही उत्तर|उत्तर|Answer|Correct Answer|Solution|Ans|Sol)(?:ः|:)?\s*[:\-\.,;\/]?\s*(.+)/i;
    
    // 3. تعريف الدوال المساعدة
    const devanagariMap = { 'क': 0, 'ख': 1, 'ग': 2, 'घ': 3, 'ङ': 4, 'ि': 0 };
    function romanToNumber(roman) {
        const R_MAP = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
        let num = 0;
        roman = roman.toUpperCase();
        for (let i = 0; i < roman.length; i++) {
            const current = R_MAP[roman[i]];
            const next = i + 1 < roman.length ? R_MAP[roman[i + 1]] : 0;
            if (next > current) { num -= current; } else { num += current; }
        }
        return num;
    }

    const isOption = (line) => line && optionPatterns.some(p => p.test(line));
    const isAnswer = (line) => line && answerPattern.test(line);
    const getOptionParts = (line) => {
        for (const pattern of optionPatterns) {
            const match = line.match(pattern);
            if (match) return match;
        }
        return null;
    };

    const questions = [];
    
    // 4. منطق التحليل الجديد القائم على "نقاط الارتكاز"
    // الخطوة أ: العثور على جميع أسطر الإجابات أولاً
    const answerIndices = [];
    lines.forEach((line, index) => {
        if (isAnswer(line)) {
            answerIndices.push(index);
        }
    });

    let startOfBlockIndex = 0;
    // الخطوة ب: معالجة كل "كتلة" بين إجابة والتي تليها
    for (const answerIndex of answerIndices) {
        // تحديد كتلة النص (من بعد الإجابة السابقة وحتى قبل الإجابة الحالية)
        const blockLines = lines.slice(startOfBlockIndex, answerIndex);
        
        // البحث عن أول خيار في الكتلة لتحديد بداية الخيارات
        let firstOptionIndexInBlock = -1;
        for (let i = 0; i < blockLines.length; i++) {
            if (isOption(blockLines[i])) {
                firstOptionIndexInBlock = i;
                break;
            }
        }

        if (firstOptionIndexInBlock === -1) {
            startOfBlockIndex = answerIndex + 1;
            continue; // لا توجد خيارات في هذه الكتلة، تجاهلها وانتقال
        }
        
        // كل ما قبل أول خيار هو نص السؤال
        const questionText = blockLines.slice(0, firstOptionIndexInBlock).join(' ').replace(/\s+/g, ' ').trim();
        
        // تجميع الخيارات ومعالجة الأسطر المتعددة
        const rawOptionLines = blockLines.slice(firstOptionIndexInBlock);
        const options = [];
        const optionLinesForTypeCheck = [];
        let currentOptionText = '';
        
        for (const rawLine of rawOptionLines) {
            const optParts = getOptionParts(rawLine);
            if (optParts) { // هذا السطر هو بداية خيار جديد
                if (currentOptionText) {
                    options.push(currentOptionText.trim());
                }
                optionLinesForTypeCheck.push(rawLine);
                currentOptionText = optParts[optParts.length - 1]; // النص دائمًا في آخر مجموعة التقاط
            } else { // هذا السطر هو تكملة للخيار السابق
                currentOptionText += ' ' + rawLine;
            }
        }
        if (currentOptionText) {
            options.push(currentOptionText.trim());
        }

        // تحليل الإجابة
        let correctAnswerIndex = undefined;
        const answerLine = lines[answerIndex];
        const answerMatch = answerLine.match(answerPattern);

        if (answerMatch && optionLinesForTypeCheck.length > 0) {
            let answerIdentifier = answerMatch[1].trim().replace(/[()\[\]{}\.\)]/g, '');
            const firstOptionLine = optionLinesForTypeCheck[0];
            
            if (devanagariOptionPatterns.some(p => p.test(firstOptionLine))) {
                if (devanagariMap.hasOwnProperty(answerIdentifier)) {
                    correctAnswerIndex = devanagariMap[answerIdentifier];
                }
            } else if (romanOptionPatterns.some(p => p.test(firstOptionLine))) {
                correctAnswerIndex = romanToNumber(answerIdentifier) - 1;
            } else if (letterOptionPatterns.some(p => p.test(firstOptionLine))) {
                correctAnswerIndex = answerIdentifier.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
            } else if (numberOptionPatterns.some(p => p.test(firstOptionLine))) {
                correctAnswerIndex = parseInt(answerIdentifier, 10) - 1;
            }
        }

        // حفظ السؤال إذا كان مكتملاً
        if (questionText && options.length > 1 && correctAnswerIndex !== undefined && correctAnswerIndex >= 0 && correctAnswerIndex < options.length) {
            questions.push({
                question: questionText,
                options: options,
                correctAnswerIndex: correctAnswerIndex
            });
        }
        
        startOfBlockIndex = answerIndex + 1; // تحديث بداية الكتلة التالية
    }

    return questions;
}
// ===============================================================================================
// ==== نهاية دالة استخراج الأسئلة ====
// ===============================================================================================

function formatQuizText(quizData) {
    let formattedText = ` ${quizData.question}\n\n`;
    const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

    const formattedOptions = quizData.options.map((optionText, optIndex) => {
        return `${optionLetters[optIndex]}) ${optionText}`;
    });
    formattedText += formattedOptions.join('\n');

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
