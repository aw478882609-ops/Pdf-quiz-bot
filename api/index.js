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
// دالة مساعدة لإرسال الأسئلة (النسخة المحدثة)
async function sendPolls(targetChatId, questions) {
    for (const q of questions) {
        if (q.question.length > 255) {
            await bot.sendMessage(targetChatId, q.question);
            await bot.sendPoll(targetChatId, '.', q.options, {
                type: 'quiz',
                correct_option_id: q.correctAnswerIndex,
                is_anonymous: true // <--- تم التعديل هنا
            });
        } else {
            await bot.sendPoll(targetChatId, q.question, q.options, {
                type: 'quiz',
                correct_option_id: q.correctAnswerIndex,
                is_anonymous: true // <--- تم التعديل هنا
            });
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
                    // تخزين الأسئلة في حالة المستخدم
                    userState[userId] = { questions: questions };

                    const keyboard = {
                        inline_keyboard: [
                            [{ text: 'إرسال هنا 📤', callback_data: 'send_here' }],
                            [{ text: 'إرسال لقناة/مجموعة  broadcasting', callback_data: 'send_to_channel' }]
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
            const data = callbackQuery.data;

            // التأكد من أن الأسئلة لا تزال محفوظة
            if (!userState[userId] || !userState[userId].questions) {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'انتهت هذه الجلسة، يرجى إرسال الملف مرة أخرى.',
                    show_alert: true
                });
                return;
            }

            if (data === 'send_here') {
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'جاري إرسال الأسئلة...' });
                await sendPolls(chatId, userState[userId].questions);
                delete userState[userId]; // حذف الحالة بعد الانتهاء
            } else if (data === 'send_to_channel') {
                // ضبط حالة المستخدم لانتظار ID القناة
                userState[userId].awaiting = 'channel_id';
                await bot.answerCallbackQuery(callbackQuery.id);
                await bot.sendMessage(chatId, 'يرجى إرسال معرف (ID) القناة أو المجموعة الآن.\n(مثال: @username أو -100123456789)');
            }
        }

        // 3️⃣ التعامل مع الرسائل النصية (قد تكون ID القناة)
        else if (update.message && update.message.text) {
            const message = update.message;
            const userId = message.from.id;
            const chatId = message.chat.id;
            const text = message.text;

            // التحقق مما إذا كان المستخدم في حالة انتظار ID القناة
            if (userState[userId] && userState[userId].awaiting === 'channel_id') {
                const targetChatId = text.trim();
                const questions = userState[userId].questions;

                await bot.sendMessage(chatId, `جاري التحقق من الصلاحيات في ${targetChatId}...`);

                try {
                    // الحصول على معلومات البوت داخل الشات المستهدف
                    const botInfo = await bot.getMe();
                    const botMember = await bot.getChatMember(targetChatId, botInfo.id);
                    
                    if (botMember.status === 'administrator' || botMember.status === 'creator') {
                        // التحقق من صلاحية إرسال استطلاعات
                        if (botMember.can_send_polls) {
                             await bot.sendMessage(chatId, '✅ الصلاحيات متوفرة. جاري إرسال الأسئلة...');
                             await sendPolls(targetChatId, questions);
                             await bot.sendMessage(chatId, '👍 تم الإرسال بنجاح!');
                        } else {
                            await bot.sendMessage(chatId, '⚠️ ليس لدي صلاحية "إرسال استطلاعات" في هذه القناة/المجموعة.');
                        }
                    } else {
                         await bot.sendMessage(chatId, '⚠️ أنا لست مشرفًا (Admin) في هذه القناة/المجموعة.');
                    }

                } catch (error) {
                    console.error(error);
                    // غالبًا ما يحدث الخطأ إذا كان البوت غير موجود في القناة
                    await bot.sendMessage(chatId, '❌ خطأ! لا يمكنني الوصول إلى هذه القناة/المجموعة. تأكد من أنني عضو فيها وأن المعرف صحيح.');
                } finally {
                    delete userState[userId]; // حذف الحالة بعد الانتهاء
                }
            }
        }

    } catch (error) {
        console.error("General error:", error);
    }
    res.status(200).send('OK');
};


// =================================================================
//        دالة استخراج الأسئلة من النص (بدون تغيير)
// =================================================================
function extractQuestions(text) {
    const questions = [];
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\f/g, '\n').replace(/\u2028|\u2029/g, '\n');
    const lines = text.split('\n').map(l => l.trim());
    let i = 0;
    const letterOptionPatterns = [/^\s*([A-Z])[\)\.\/\-_\^&@':;"\\]\s*(.+)/i, /^\s*\[([A-Z])\]\s*(.+)/i, /^\s*\(\s*([A-Z])\s*\)\s*(.+)/i, /^\s*([A-Z])\s+(.+)/i, ];
    const numberOptionPatterns = [/^\s*(\d+)[\)\.\/\-_\^&@':;"\\]\s*(.+)/, /^\s*(\d+)\s+(.+)/];
    const optionPatterns = [...letterOptionPatterns, ...numberOptionPatterns];
    const answerPatterns = [/^(Answer|Correct Answer|Solution|Ans|Sol):?/i];

    function findMatch(line, patterns) {
        for (const pattern of patterns) {
            const match = line.match(pattern);
            if (match) return match;
        }
        return null;
    }

    function areOptionsConsistent(optionLines) {
        if (optionLines.length === 0) return false;
        let style = null;
        for (const line of optionLines) {
            let currentStyle = null;
            if (findMatch(line, letterOptionPatterns)) {
                currentStyle = 'letters';
            } else if (findMatch(line, numberOptionPatterns)) {
                currentStyle = 'numbers';
            } else {
                return false;
            }
            if (!style) {
                style = currentStyle;
            } else if (style !== currentStyle) {
                return false;
            }
        }
        return true;
    }

    while (i < lines.length) {
        const line = lines[i];
        if (!line) {
            i++;
            continue;
        }
        let questionText = line.trim();
        let potentialOptionsIndex = -1;
        let j = i + 1;
        while (j < lines.length) {
            const currentLine = lines[j].trim();
            if (!currentLine) {
                j++;
                continue;
            }
            if (findMatch(currentLine, optionPatterns) || findMatch(currentLine, answerPatterns)) {
                if (findMatch(currentLine, optionPatterns)) {
                    potentialOptionsIndex = j;
                }
                break;
            }
            questionText += ' ' + currentLine;
            j++;
        }
        if (potentialOptionsIndex !== -1) {
            const currentQuestion = {
                question: questionText,
                options: [],
                correctAnswerIndex: undefined
            };
            let k = potentialOptionsIndex;
            const optionLines = [];
            while (k < lines.length) {
                const optLine = lines[k].trim();
                if (findMatch(optLine, answerPatterns)) {
                    break;
                }
                const optionMatch = findMatch(optLine, optionPatterns);
                if (optionMatch) {
                    optionLines.push(optLine);
                    const optionText = optionMatch[2] ? optionMatch[2].trim() : optionMatch[1].trim();
                    currentQuestion.options.push(optionText);
                    k++;
                } else {
                    break;
                }
            }
            if (!areOptionsConsistent(optionLines)) {
                i = i + 1;
                continue;
            }
            i = k - 1;
            if (i + 1 < lines.length) {
                const answerMatch = findMatch(lines[i + 1], answerPatterns);
                if (answerMatch) {
                    const answerLine = lines[i + 1];
                    let answerText = answerLine.replace(/^(Answer|Correct Answer|Solution|Ans|Sol):?/i, '').trim();
                    let correctIndex = currentQuestion.options.findIndex(
                        opt => opt.toLowerCase() === answerText.toLowerCase()
                    );
                    if (correctIndex === -1) {
                        const letterMatch = answerText.match(/^[A-Z]|\d/i);
                        if (letterMatch) {
                            const letterOrNumber = letterMatch[0].toUpperCase();
                            const index = isNaN(parseInt(letterOrNumber)) ?
                                letterOrNumber.charCodeAt(0) - 'A'.charCodeAt(0) :
                                parseInt(letterOrNumber) - 1;
                            if (index >= 0 && index < currentQuestion.options.length) {
                                correctIndex = index;
                            }
                        }
                    }
                    if (correctIndex !== -1) {
                        currentQuestion.correctAnswerIndex = correctIndex;
                        i++;
                    }
                }
            }
            if (currentQuestion.options.length > 1 && currentQuestion.correctAnswerIndex !== undefined) {
                questions.push(currentQuestion);
            }
        }
        i++;
    }
    return questions;
}
