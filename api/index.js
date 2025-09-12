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

        // 1️⃣ التعامل مع الملفات المرسلة
        if (update.message && update.message.document) {
            const message = update.message;
            const chatId = message.chat.id;
            const userId = message.from.id;
            const fileId = message.document.file_id;

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
                    await bot.sendMessage(chatId, '❌ لم أتمكن من العثور على أي أسئلة بصيغة صحيحة في الملف.');
                }
            } catch (error) {
                console.error("Error processing PDF:", error);
                await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء معالجة الملف. يرجى التأكد من أن الملف سليم وغير تالف.');
            }
        }

        // 2️⃣ التعامل مع الضغط على الأزرار
        else if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const userId = callbackQuery.from.id;
            const chatId = callbackQuery.message.chat.id;
            const messageId = callbackQuery.message.message_id;
            const data = callbackQuery.data;

            if (!userState[userId] || !userState[userId].questions) {
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'انتهت هذه الجلسة، يرجى إرسال الملف مرة أخرى.', show_alert: true });
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
                return res.status(200).send('OK');
            }

            const gasWebAppUrl = process.env.GAS_WEB_APP_URL;

            if (!gasWebAppUrl && (data === 'send_here' || data === 'confirm_send')) {
                await bot.editMessageText('⚠️ خطأ في الإعدادات: رابط خدمة الإرسال الخارجية غير موجود.', { chat_id: chatId, message_id: messageId });
                return res.status(200).send('OK');
            }

            if (data === 'send_here') {
                const { questions } = userState[userId];
                const payload = {
                    questions, targetChatId: chatId, originalChatId: chatId, startIndex: 0,
                    chatType: 'private' // إرسال النوع كمحادثة خاصة
                };
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
                    const payload = {
                        questions, targetChatId, originalChatId: chatId, startIndex: 0,
                        chatType // إرسال نوع المحادثة (channel, supergroup)
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

        // 3️⃣ التعامل مع الرسائل النصية (ID القناة)
        else if (update.message && update.message.text && !update.message.document) {
            const message = update.message;
            const userId = message.from.id;
            const chatId = message.chat.id;
            const text = message.text;

            if (userState[userId] && userState[userId].awaiting === 'channel_id') {
                const targetChatId = text.trim();
                try {
                    const chatInfo = await bot.getChat(targetChatId);
                    const botMember = await bot.getChatMember(targetChatId, (await bot.getMe()).id);

                    // بناء رسالة التأكيد مع المعلومات والصلاحيات
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
                            chatType: chatInfo.type // تخزين نوع الشات لإرساله لاحقًا
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
    // الخطوة 1: توحيد وتنظيف النص
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\f/g, '\n').replace(/\u2028|\u2029/g, '\n');
    text = text.replace(/\n{2,}/g, '\n');

    const lines = text.split('\n').map(l => l.trim());
    const questions = [];
    let i = 0;

    // تعريف الأنماط والدوال المساعدة
    const letterOptionPatterns = [ /^\s*([a-zA-Z])\s*-\s*(.+)/, /^\s*[\(\[\{]([a-zA-Z])[\)\]\}]\s*(.+)/, /^\s*([a-zA-Z])[\.\)]\s*(.+)/ ];
    const numberOptionPatterns = [ /^\s*(\d+)\s*-\s*(.+)/, /^\s*[\(\[\{](\d+)[\)\]\}]\s*(.+)/, /^\s*(\d+)[\.\)]\s*(.+)/ ];
    const romanOptionPatterns = [ /^\s*([IVXLCDM]+)[\.\)]\s*(.+)/i ];
    const optionPatterns = [...letterOptionPatterns, ...numberOptionPatterns, ...romanOptionPatterns];
    const answerPatterns = [/^(Answer|Correct Answer|Solution|Ans|Sol)\s*[:\-]?\s*/i];
    function findMatch(line, patterns) { for (const pattern of patterns) { const match = line.match(pattern); if (match) return match; } return null; }
    function validateOptionsSequence(optionLines) {
        if (optionLines.length < 2) return true;
        let style = null; let lastValue = null;
        function romanToNumber(roman) { const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }; let num = 0; for (let i = 0; i < roman.length; i++) { const current = map[roman[i]]; const next = map[roman[i + 1]]; if (next > current) { num -= current; } else { num += current; } } return num; }
        for (let j = 0; j < optionLines.length; j++) {
            const line = optionLines[j]; let currentStyle = null; let currentValue = null;
            if (findMatch(line, numberOptionPatterns)) { currentStyle = 'numbers'; currentValue = parseInt(findMatch(line, numberOptionPatterns)[1], 10); }
            else if (findMatch(line, letterOptionPatterns)) { currentStyle = 'letters'; currentValue = findMatch(line, letterOptionPatterns)[1].toUpperCase().charCodeAt(0); }
            else if (findMatch(line, romanOptionPatterns)) { currentStyle = 'roman'; currentValue = romanToNumber(findMatch(line, romanOptionPatterns)[1].toUpperCase()); }
            else { return false; }
            if (j === 0) { style = currentStyle; lastValue = currentValue; }
            else { if (currentStyle !== style || currentValue !== lastValue + 1) { return false; } lastValue = currentValue; }
        }
        return true;
    }

    // [المنطق النهائي المدمج]
    while (i < lines.length) {
        const startLine = lines[i];

        // ## التحسين الجديد: شرط إضافي لتجاهل العناوين ##
        // يعتبر السطر عنوانًا إذا كان بأحرف كبيرة ويحتوي على مسافات فقط
        const isTitle = /^[A-Z\s\(\)]+$/.test(startLine) && startLine.length > 5;

        if (!startLine || findMatch(startLine, optionPatterns) || findMatch(startLine, answerPatterns) || isTitle) {
            i++;
            continue;
        }

        let potentialOptionsStartIndex = -1;
        for (let j = i + 1; j < lines.length; j++) {
            if (findMatch(lines[j], optionPatterns)) {
                potentialOptionsStartIndex = j;
                break;
            }
        }

        if (potentialOptionsStartIndex === -1) {
            i++;
            continue;
        }

        const potentialOptionLines = [];
        let k = potentialOptionsStartIndex;
        while (k < lines.length && findMatch(lines[k], optionPatterns)) {
            potentialOptionLines.push(lines[k]);
            k++;
        }

        if (!validateOptionsSequence(potentialOptionLines)) {
            i++;
            continue;
        }
        
        const optionsStartIndex = potentialOptionsStartIndex;
        const questionText = lines.slice(i, optionsStartIndex).join(' ').trim();
        const currentQuestion = { question: questionText, options: [], correctAnswerIndex: undefined };
        const optionLines = potentialOptionLines;
        
        k = optionsStartIndex + optionLines.length;

        optionLines.forEach(line => {
            const match = findMatch(line, optionPatterns);
            currentQuestion.options.push(match[2].trim());
        });
        
        if (k < lines.length && findMatch(lines[k], answerPatterns)) {
            const answerLine = lines[k];
            let answerText = answerLine.replace(answerPatterns[0], '').trim();
            let correctIndex = -1;
            const cleanAnswerText = answerText.replace(/^[a-zA-Z\dIVXLCDM]+[\.\)]\s*/, '').trim();
            correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === cleanAnswerText.toLowerCase());

            if (correctIndex === -1) {
                const identifierMatch = answerText.match(/^[a-zA-Z\dIVXLCDM]+/);
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
            i = k + 1;
        } else {
            i = k;
        }

        if (currentQuestion.options.length > 1 && currentQuestion.correctAnswerIndex !== undefined) {
            questions.push(currentQuestion);
        }
    }
    
    return questions;
}
