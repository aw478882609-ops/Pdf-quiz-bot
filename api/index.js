// api/index.js

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

module.exports = async (req, res) => {
    try {
        if (req.method !== 'POST') {
            return res.status(405).send('Method Not Allowed');
        }
        const body = await micro.json(req);
        const update = body;

        if (update.message && update.message.document) {
            const chatId = update.message.chat.id;
            const fileId = update.message.document.file_id;
            await bot.sendMessage(chatId, '📑 يتم تحليل الملف الآن...');

            try {
                const fileLink = await bot.getFileLink(fileId);
                const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                const dataBuffer = Buffer.from(response.data);
                const pdfData = await pdf(dataBuffer);
                const text = pdfData.text;

                const questions = extractQuestions(text);

                if (questions.length > 0) {
                    for (const q of questions) {
                        if (q.question.length > 255) {
                            await bot.sendMessage(chatId, q.question);
                            await bot.sendPoll(chatId, '.', q.options, {
                                type: 'quiz',
                                correct_option_id: q.correctAnswerIndex,
                                is_anonymous: false
                            });
                        } else {
                            await bot.sendPoll(chatId, q.question, q.options, {
                                type: 'quiz',
                                correct_option_id: q.correctAnswerIndex,
                                is_anonymous: false
                            });
                        }
                    }
                } else {
                    await bot.sendMessage(chatId, '❌ لم أتمكن من العثور على أي أسئلة في الملف.');
                }
            } catch (error) {
                console.error("Error processing PDF:", error);
                await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء معالجة الملف. تأكد من أن صيغ الأسئلة صحيحة.');
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

    // 🧹 تنظيف النص لتوحيد نهايات الأسطر
    text = text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\f/g, '\n')
        .replace(/\u2028|\u2029/g, '\n');

    const lines = text.split('\n').map(l => l.trim());
    let i = 0;

    // ✅ أنماط الاختيارات (مقسمة حسب النوع لدعم جميع الرموز)
    const letterOptionPatterns = [
        /^\s*([A-Z])[\)\.\/\-_\^&@':;"\\]\s*(.+)/i,
        /^\s*\[([A-Z])\]\s*(.+)/i,
        /^\s*\(\s*([A-Z])\s*\)\s*(.+)/i,
        /^\s*([A-Z])\s+(.+)/i,
    ];
    const numberOptionPatterns = [
        /^\s*(\d+)[\)\.\/\-_\^&@':;"\\]\s*(.+)/,
        /^\s*(\d+)\s+(.+)/
    ];
    const optionPatterns = [...letterOptionPatterns, ...numberOptionPatterns];

    // ✅ أنماط الإجابة
    const answerPatterns = [
        /^(Answer|Correct Answer|Solution|Ans|Sol):?/i
    ];

    function findMatch(line, patterns) {
        for (const pattern of patterns) {
            const match = line.match(pattern);
            if (match) return match;
        }
        return null;
    }

    // ✅ التحقق من تناسق الاختيارات (يدعم جميع الرموز)
    function areOptionsConsistent(optionLines) {
        if (optionLines.length === 0) return false;
        let style = null; // سيتم تعيينه إلى 'letters' أو 'numbers'

        for (const line of optionLines) {
            let currentStyle = null;

            if (findMatch(line, letterOptionPatterns)) {
                currentStyle = 'letters';
            } else if (findMatch(line, numberOptionPatterns)) {
                currentStyle = 'numbers';
            } else {
                return false; // لا يطابق أي نمط معروف
            }

            if (!style) {
                style = currentStyle; // تعيين النمط الأساسي من أول اختيار
            } else if (style !== currentStyle) {
                return false; // النمط الحالي مختلف عن الأساسي (غير متناسق)
            }
        }
        return true; // جميع الاختيارات متناسقة
    }

    while (i < lines.length) {
        const line = lines[i];
        if (!line) {
            i++;
            continue;
        }

        // 🧠 اعتبار أي سطر بداية محتملة لسؤال
        let questionText = line.trim();
        let potentialOptionsIndex = -1;

        //  собирать (تجميع) نصوص السؤال متعددة الأسطر
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
        
        // 🔍 إذا تم العثور على بداية للاختيارات
        if (potentialOptionsIndex !== -1) {
            const currentQuestion = {
                question: questionText,
                options: [],
                correctAnswerIndex: undefined
            };

            // 📚 تجميع الاختيارات
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

            // 🚦 التحقق من تناسق الاختيارات قبل المتابعة
            if (!areOptionsConsistent(optionLines)) {
                i = i + 1;
                continue;
            }

            i = k - 1;

            // 🎯 البحث عن الإجابة الصحيحة
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
                            const index = isNaN(parseInt(letterOrNumber))
                                ? letterOrNumber.charCodeAt(0) - 'A'.charCodeAt(0)
                                : parseInt(letterOrNumber) - 1;
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
