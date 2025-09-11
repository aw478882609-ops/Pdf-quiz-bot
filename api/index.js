// api/index.js

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

// 🧠 متغير لتخزين حالة المستخدم والأسئلة المستخرجة مؤقتًا
const userState = {};
// ... (الجزء العلوي من الملف يبقى كما هو) ...

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

        // 2️⃣ التعامل مع الضغط على الأزرار (الجزء المعدل)
        else if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const userId = callbackQuery.from.id;
            const chatId = callbackQuery.message.chat.id;
            const messageId = callbackQuery.message.message_id;
            const data = callbackQuery.data;

            if (!userState[userId] || !userState[userId].questions) {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'انتهت هذه الجلسة، يرجى إرسال الملف مرة أخرى.',
                    show_alert: true
                });
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
                return res.status(200).send('OK');;
            }

            const gasWebAppUrl = process.env.GAS_WEB_APP_URL;

            // التأكد من وجود رابط الخدمة الخارجية أولاً
            if (!gasWebAppUrl && (data === 'send_here' || data === 'confirm_send')) {
                 await bot.editMessageText('⚠️ خطأ في الإعدادات: رابط خدمة الإرسال الخارجية غير موجود.', { chat_id: chatId, message_id: messageId });
                 return res.status(200).send('OK');
            }

            if (data === 'send_here') {
                 // استخدام منطق الإرسال الخارجي، ولكن مع استخدام chatId الحالي
                const { questions } = userState[userId];
                
                const payload = {
                    questions: questions,
                    targetChatId: chatId, // الإرسال هنا
                    originalChatId: chatId,
                    startIndex: 0
                };
                
                // إطلاق المهمة في الخلفية
                axios.post(gasWebAppUrl, payload).catch(err => console.error("Error calling GAS:", err.message));
                
                await bot.answerCallbackQuery(callbackQuery.id);
                await bot.editMessageText(`✅ تم إرسال المهمة للخدمة الخارجية.\n\nسيتم إرسال ${questions.length} سؤالًا هنا في الخلفية. قد تستغرق العملية عدة دقائق.`, { chat_id: chatId, message_id: messageId });
                
                delete userState[userId];

            } else if (data === 'send_to_channel') {
                userState[userId].awaiting = 'channel_id';
                await bot.answerCallbackQuery(callbackQuery.id);
                await bot.editMessageText('يرجى إرسال معرف (ID) القناة أو المجموعة الآن.\n(مثال: @username أو -100123456789)\n\nتأكد من أن البوت مشرف في القناة/المجموعة ولديه صلاحية إرسال الرسائل.', { chat_id: chatId, message_id: messageId });

            } else if (data === 'confirm_send') {
                if (userState[userId] && userState[userId].awaiting === 'send_confirmation') {
                    const { questions, targetChatId, targetChatTitle } = userState[userId];
                    
                    // إعداد البيانات وإضافة startIndex: 0 لبدء العملية
                    const payload = {
                        questions: questions,
                        targetChatId: targetChatId,
                        originalChatId: chatId,
                        startIndex: 0
                    };

                    // إرسال الطلب الأول إلى Google Apps Script
                    axios.post(gasWebAppUrl, payload).catch(err => {
                        console.error("Error calling Google Apps Script:", err.message);
                    });
                    
                    // الرد على المستخدم فورًا
                    await bot.answerCallbackQuery(callbackQuery.id);
                    await bot.editMessageText(`✅ تم إرسال المهمة إلى الخدمة الخارجية.\n\nسيتم إرسال ${questions.length} سؤالًا في الخلفية إلى "${targetChatTitle}". قد تستغرق العملية عدة دقائق حسب العدد. سيصلك إشعار عند الانتهاء.`, {
                        chat_id: chatId,
                        message_id: messageId
                    });

                    delete userState[userId];
                }
            } else if (data === 'cancel_send') {
                await bot.answerCallbackQuery(callbackQuery.id);
                await bot.editMessageText('❌ تم إلغاء العملية.', { chat_id: chatId, message_id: messageId });
                delete userState[userId];
            }
        }

        // 3️⃣ التعامل مع الرسائل النصية (ID القناة) (الجزء المعدل)
        else if (update.message && update.message.text && !update.message.document) { // 🚨 أضفنا !update.message.document هنا
            const message = update.message;
            const userId = message.from.id;
            const chatId = message.chat.id;
            const text = message.text;

            if (userState[userId] && userState[userId].awaiting === 'channel_id') {
                const targetChatId = text.trim();
                
                try {
                    // التحقق من صلاحيات البوت في القناة/المجموعة
                    const chatInfo = await bot.getChat(targetChatId);
                    const botMember = await bot.getChatMember(targetChatId, (await bot.getMe()).id);

                    if (botMember.status !== 'administrator' && botMember.status !== 'creator') {
                        await bot.sendMessage(chatId, `❌ البوت ليس مشرفًا في "${chatInfo.title}". يرجى رفع البوت كمشرف ثم المحاولة مرة أخرى.`);
                        return res.status(200).send('OK');
                    }

                    // إذا كانت الصلاحيات سليمة، اطلب التأكيد النهائي
                    userState[userId].awaiting = 'send_confirmation';
                    userState[userId].targetChatId = chatInfo.id;
                    userState[userId].targetChatTitle = chatInfo.title;

                    const confirmationKeyboard = {
                        inline_keyboard: [[{ text: '✅ نعم، قم بالإرسال', callback_data: 'confirm_send' }, { text: '❌ إلغاء', callback_data: 'cancel_send' }]]
                    };
                    await bot.sendMessage(chatId, `هل أنت متأكد أنك تريد إرسال ${userState[userId].questions.length} سؤالًا إلى "${chatInfo.title}"؟`, {
                        reply_markup: confirmationKeyboard
                    });

                } catch (error) {
                    console.error("Error getting chat info:", error.response ? error.response.body : error.message);
                    await bot.sendMessage(chatId, '❌ فشل! لم أتمكن من العثور على هذه القناة/المجموعة أو أن البوت ليس عضوًا فيها. يرجى التأكد من المعرف وصلاحيات البوت.');
                }
            }
        }
    } catch (error) {
        console.error("General error:", error);
    }
    res.status(200).send('OK');
};

// ... (دالة extractQuestions تبقى كما هي في النهاية) ...

// ... (دالة extractQuestions تبقى كما هي هنا)
function extractQuestions(text) {
    const questions = [];
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\f/g, '\n').replace(/\u2028|\u2029/g, '\n');
    const lines = text.split('\n').map(l => l.trim());
    let i = 0;
    const letterOptionPatterns = [/^\s*([A-Z])[\)\.\/\-_\^&@':;"\\]\s*(.+)/i, /^\s*\[([A-Z])\]\s*(.+)/i, /^\s*\(\s*([A-Z])\s*\)\s*(.+)/i, /^\s*([A-Z])\s+(.+)/i,];
    const numberOptionPatterns = [/^\s*(\d+)[\)\.\/\-_\^&@':;"\\]\s*(.+)/, /^\s*(\d+)\s+(.+)/];
    const optionPatterns = [...letterOptionPatterns, ...numberOptionPatterns];
    const answerPatterns = [/^(Answer|Correct Answer|Solution|Ans|Sol):?/i];
    function findMatch(line, patterns) { for (const pattern of patterns) { const match = line.match(pattern); if (match) return match; } return null; }
    function areOptionsConsistent(optionLines) { if (optionLines.length === 0) return false; let style = null; for (const line of optionLines) { let currentStyle = null; if (findMatch(line, letterOptionPatterns)) { currentStyle = 'letters'; } else if (findMatch(line, numberOptionPatterns)) { currentStyle = 'numbers'; } else { return false; } if (!style) { style = currentStyle; } else if (style !== currentStyle) { return false; } } return true; }
    while (i < lines.length) {
        const line = lines[i];
        if (!line) { i++; continue; }
        let questionText = line.trim();
        let potentialOptionsIndex = -1;
        let j = i + 1;
        while (j < lines.length) {
            const currentLine = lines[j].trim();
            if (!currentLine) { j++; continue; }
            if (findMatch(currentLine, optionPatterns) || findMatch(currentLine, answerPatterns)) { if (findMatch(currentLine, optionPatterns)) { potentialOptionsIndex = j; } break; }
            questionText += ' ' + currentLine;
            j++;
        }
        if (potentialOptionsIndex !== -1) {
            const currentQuestion = { question: questionText, options: [], correctAnswerIndex: undefined };
            let k = potentialOptionsIndex;
            const optionLines = [];
            while (k < lines.length) {
                const optLine = lines[k].trim();
                if (findMatch(optLine, answerPatterns)) { break; }
                const optionMatch = findMatch(optLine, optionPatterns);
                if (optionMatch) {
                    optionLines.push(optLine);
                    const optionText = optionMatch[2] ? optionMatch[2].trim() : optionMatch[1].trim();
                    currentQuestion.options.push(optionText);
                    k++;
                } else { break; }
            }
            if (!areOptionsConsistent(optionLines)) { i = i + 1; continue; }
            i = k - 1;
            if (i + 1 < lines.length) {
                const answerMatch = findMatch(lines[i + 1], answerPatterns);
                if (answerMatch) {
                    const answerLine = lines[i + 1];
                    let answerText = answerLine.replace(/^(Answer|Correct Answer|Solution|Ans|Sol):?/i, '').trim();
                    let correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === answerText.toLowerCase());
                    if (correctIndex === -1) {
                        const letterMatch = answerText.match(/^[A-Z]|\d/i);
                        if (letterMatch) {
                            const letterOrNumber = letterMatch[0].toUpperCase();
                            const index = isNaN(parseInt(letterOrNumber)) ? letterOrNumber.charCodeAt(0) - 'A'.charCodeAt(0) : parseInt(letterOrNumber) - 1;
                            if (index >= 0 && index < currentQuestion.options.length) { correctIndex = index; }
                        }
                    }
                    if (correctIndex !== -1) { currentQuestion.correctAnswerIndex = correctIndex; i++; }
                }
            }
            if (currentQuestion.options.length > 1 && currentQuestion.correctAnswerIndex !== undefined) { questions.push(currentQuestion); }
        }
        i++;
    }
    return questions;
}
