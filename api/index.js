// api/index.js

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

// 🧠 متغير لتخزين حالة المستخدم والأسئلة المستخرجة مؤقتًا
const userState = {};

// دالة مساعدة لإرسال الأسئلة
// دالة مساعدة لإرسال الأسئلة (النسخة المحسنة والأسرع)
async function sendPolls(targetChatId, questions) {
    const chunkSize = 20; // إرسال 20 سؤالًا في كل دفعة
    const delay = 1000; // الانتظار لمدة ثانية واحدة بين كل دفعة

    for (let i = 0; i < questions.length; i += chunkSize) {
        const chunk = questions.slice(i, i + chunkSize);
        
        // إنشاء مجموعة من الوعود لإرسال الدفعة الحالية بالتوازي
        const promises = chunk.map(q => {
            if (q.question.length > 255) {
                // إذا كان السؤال طويلاً، أرسل النص أولاً ثم الاستطلاع
                return bot.sendMessage(targetChatId, q.question)
                    .then(() => bot.sendPoll(targetChatId, '.', q.options, {
                        type: 'quiz',
                        correct_option_id: q.correctAnswerIndex,
                        is_anonymous: true
                    }));
            } else {
                // أرسل الاستطلاع مباشرة
                return bot.sendPoll(targetChatId, q.question, q.options, {
                    type: 'quiz',
                    correct_option_id: q.correctAnswerIndex,
                    is_anonymous: true
                });
            }
        });

        // انتظار اكتمال إرسال الدفعة الحالية
        await Promise.all(promises);

        // الانتظار قبل إرسال الدفعة التالية (إذا كانت هناك دفعات متبقية)
        if (i + chunkSize < questions.length) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}


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

            await bot.sendMessage(chatId, '📑 يتم تحليل الملف الآن...');

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
                    await bot.sendMessage(chatId, '❌ لم أتمكن من العثور على أي أسئلة في الملف.');
                }
            } catch (error) {
                console.error("Error processing PDF:", error);
                await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء معالجة الملف.');
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
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'انتهت هذه الجلسة، يرجى إرسال الملف مرة أخرى.',
                    show_alert: true
                });
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
                return;
            }

            if (data === 'send_here') {
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'جاري إرسال الأسئلة...' });
                await bot.editMessageText(`✅ تم إرسال ${userState[userId].questions.length} سؤالًا بنجاح.`, { chat_id: chatId, message_id: messageId });
                await sendPolls(chatId, userState[userId].questions);
                delete userState[userId];
            } else if (data === 'send_to_channel') {
                userState[userId].awaiting = 'channel_id';
                await bot.answerCallbackQuery(callbackQuery.id);
                await bot.editMessageText('يرجى إرسال معرف (ID) القناة أو المجموعة الآن.\n(مثال: @username أو -100123456789)', { chat_id: chatId, message_id: messageId });
            } else if (data === 'confirm_send') {
                 if (userState[userId] && userState[userId].awaiting === 'send_confirmation') {
                    const { questions, targetChatId, targetChatTitle } = userState[userId];
                    await bot.answerCallbackQuery(callbackQuery.id);
                    await bot.editMessageText(`✅ جاري إرسال ${questions.length} سؤالًا إلى "${targetChatTitle}"...`, { chat_id: chatId, message_id: messageId });
                    await sendPolls(targetChatId, questions);
                    await bot.sendMessage(chatId, '👍 تم الإرسال بنجاح!');
                    delete userState[userId];
                 }
            } else if (data === 'cancel_send') {
                await bot.answerCallbackQuery(callbackQuery.id);
                await bot.editMessageText('❌ تم إلغاء العملية.', { chat_id: chatId, message_id: messageId });
                delete userState[userId];
            }
        }

        // 3️⃣ التعامل مع الرسائل النصية (ID القناة)
        else if (update.message && update.message.text) {
            const message = update.message;
            const userId = message.from.id;
            const chatId = message.chat.id;
            const text = message.text;

            if (userState[userId] && userState[userId].awaiting === 'channel_id') {
                const targetChatId = text.trim();
                
                try {
                    const chatInfo = await bot.getChat(targetChatId);
                    
                    if (chatInfo.type === 'private') {
                        await bot.sendMessage(chatId, '❌ لا يمكن الإرسال إلى المستخدمين. يرجى استخدام معرف قناة أو مجموعة.');
                        delete userState[userId];
                        return;
                    }
                    
                    const botInfo = await bot.getMe();
                    const botMember = await bot.getChatMember(targetChatId, botInfo.id);
                    const chatType = chatInfo.type === 'channel' ? 'قناة' : 'مجموعة';

                    let messageText = `*تم العثور على المعلومات التالية:*\n\n`;
                    messageText += `👤 *الاسم:* ${chatInfo.title}\n`;
                    messageText += `🆔 *المعرف:* \`${chatInfo.id}\`\n`;
                    messageText += `*النوع:* ${chatType}\n`;

                    let canProceed = false;

                    if (botMember.status === 'administrator' || botMember.status === 'creator') {
                        const membersCount = await bot.getChatMembersCount(targetChatId);
                        messageText += `👥 *عدد الأعضاء:* ${membersCount}\n\n`;

                        const canPost = botMember.can_post_messages;
                        messageText += `*تقرير الصلاحيات:*\n`;
                        messageText += `▫️ *حالة البوت:* مشرف (Admin)\n`;
                        messageText += `▫️ *إرسال الرسائل:* ${canPost ? '✅ يستطيع' : '❌ لا يستطيع'}\n`;
                        
                        if (canPost) {
                            canProceed = true;
                        }
                    } else {
                        messageText += `\n*تقرير الصلاحيات:*\n`;
                        messageText += `▫️ *حالة البوت:* مجرد عضو\n`;
                    }
                    
                    if (canProceed) {
                        const questions = userState[userId].questions;
                        userState[userId].awaiting = 'send_confirmation';
                        userState[userId].targetChatId = targetChatId;
                        userState[userId].targetChatTitle = chatInfo.title;

                        messageText += `\n*النتيجة: الصلاحيات كافية.*\nهل تريد بالتأكيد إرسال ${questions.length} سؤالًا؟`;

                        const confirmationKeyboard = {
                            inline_keyboard: [[{ text: '✅ نعم، قم بالإرسال', callback_data: 'confirm_send' }, { text: '❌ إلغاء', callback_data: 'cancel_send' }]]
                        };
                        
                        await bot.sendMessage(chatId, messageText, {
                            parse_mode: 'Markdown',
                            reply_markup: confirmationKeyboard
                        });

                    } else {
                        messageText += `\n*النتيجة: الصلاحيات غير كافية لإرسال الأسئلة.*`;
                        await bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
                        delete userState[userId];
                    }

                } catch (error) {
                    console.error("An error occurred during chat validation:", error.message || error);
                    await bot.sendMessage(chatId, '❌ حدث خطأ أثناء التحقق من الشات. يرجى التأكد من صحة المعرف وأن البوت عضو في القناة/المجموعة.');
                    delete userState[userId];
                }
            }
        }

    } catch (error) {
        console.error("General error:", error);
    }
    res.status(200).send('OK');
};


// =================================================================
//        دالة استخراج الأسئلة من النص (النسخة النهائية)
// =================================================================
function extractQuestions(text) {
    const questions = [];
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\f/g, '\n').replace(/\u2028|\u2029/g, '\n');
    const lines = text.split('\n').map(l => l.trim());
    let i = 0;

    // ---  تم التعديل هنا لدعم الحروف الهندية ---
    const letterOptionPatterns = [
        /^\s*([A-Zक-ह])[\)\.\/\-_\^&@':;"\\]\s*(.+)/i,
        /^\s*\[([A-Zक-ह])\]\s*(.+)/i,
        /^\s*\(\s*([A-Zक-ह])\s*\)\s*(.+)/i,
        /^\s*([A-Zक-ह])\s+(.+)/i,
    ];
    const numberOptionPatterns = [
        /^\s*(\d+)[\)\.\/\-_\^&@':;"\\]\s*(.+)/,
        /^\s*(\d+)\s+(.+)/
    ];
    const optionPatterns = [...letterOptionPatterns, ...numberOptionPatterns];

    // --- تم التعديل هنا لدعم كلمة "उत्तर" ---
    const answerPatterns = [
        /^(Answer|Correct Answer|Solution|Ans|Sol|उत्तर):?/i
    ];

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
                    let answerText = answerLine.replace(/^(Answer|Correct Answer|Solution|Ans|Sol|उत्तर):?/i, '').trim();
                    let correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === answerText.toLowerCase());
                    if (correctIndex === -1) {
                        const letterMatch = answerText.match(/^[A-Zक-ह]|\d/i);
                        if (letterMatch) {
                            const letterOrNumber = letterMatch[0].toUpperCase();
                            // Handle Hindi and English letters
                            const index = isNaN(parseInt(letterOrNumber)) ? 
                                (letterOrNumber >= 'A' && letterOrNumber <= 'Z' ? letterOrNumber.charCodeAt(0) - 'A'.charCodeAt(0) : 'कखगघङचछजझञटठडढणतथदधनपफबभम'.indexOf(letterOrNumber))
                                : parseInt(letterOrNumber) - 1;
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
