
// api/index.js

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

// استخدام المتغير البيئي لـ Token
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

            await bot.sendMessage(chatId, 'يتم تحليل الملف الآن...');

            try {
                const fileLink = await bot.getFileLink(fileId);
                const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                const dataBuffer = Buffer.from(response.data);

                const pdfData = await pdf(dataBuffer);
                const text = pdfData.text;

                const questions = extractQuestions(text);

                if (questions.length > 0) {
                    for (const q of questions) {
                        await bot.sendPoll(chatId, q.question, q.options, {
                            type: 'quiz',
                            correct_option_id: q.correctAnswerIndex,
                            is_anonymous: false
                        });
                    }
                } else {
                    await bot.sendMessage(chatId, 'لم أتمكن من العثور على أي أسئلة في الملف.');
                }
            } catch (error) {
                console.error("Error processing PDF:", error);
                await bot.sendMessage(chatId, 'حدث خطأ أثناء معالجة الملف. تأكد من أن صيغ الأسئلة صحيحة.');
            }
        }
    } catch (error) {
        console.error("General error:", error);
    }

    res.status(200).send('OK');
};

function extractQuestions(text) {
    const questions = [];
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    let currentQuestion = null;
    let i = 0;

    // أنماط البحث
    // أنماط البحث
const titleRegex = /^\d+\.\s(.+)/;
const questionTextRegex = /^(What|Which|Who|How|When|Where) (.+)/i;
const optionRegex = /^[A-D]\)\s(.+)/;
const answerRegex = /^(Answer|Correct Answer|Solution):?\s*([A-D]\))\s*(.+)/i;

    while (i < lines.length) {
        const line = lines[i];

        // البحث عن سطر العنوان
        const titleMatch = line.match(titleRegex);
        if (titleMatch) {
            // التحقق من أن السطر التالي هو السؤال الفعلي
            if (i + 1 < lines.length && lines[i + 1].match(questionTextRegex)) {
                if (currentQuestion) {
                    if (currentQuestion.options.length > 0 && currentQuestion.correctAnswerIndex !== undefined) {
                        questions.push(currentQuestion);
                    }
                }
                
                // بدء سؤال جديد
                const questionLine = lines[i + 1];
                const questionTextMatch = questionLine.match(questionTextRegex);
                currentQuestion = {
                    question: questionTextMatch[0].trim(),
                    options: [],
                    correctAnswerIndex: undefined
                };
                
                // البحث عن الخيارات
                let j = i + 2;
                while (j < lines.length && lines[j].match(optionRegex)) {
                    const optionMatch = lines[j].match(optionRegex);
                    currentQuestion.options.push(optionMatch[1].trim());
                    j++;
                }
                i = j - 1; // تحديث مؤشر السطر

                // البحث عن الإجابة
                if (i + 1 < lines.length) {
                    const answerLine = lines[i + 1];
                    const answerMatch = answerLine.match(answerRegex);
                    if (answerMatch) {
                        const correctOptionLetter = answerMatch[2].charAt(0).toUpperCase();
                        const correctIndex = correctOptionLetter.charCodeAt(0) - 'A'.charCodeAt(0);
                        if (correctIndex >= 0 && correctIndex < currentQuestion.options.length) {
                            currentQuestion.correctAnswerIndex = correctIndex;
                        }
                        i++;
                    }
                }
            }
        }
        i++;
    }

    if (currentQuestion && currentQuestion.options.length > 0 && currentQuestion.correctAnswerIndex !== undefined) {
        questions.push(currentQuestion);
    }

    return questions;
}

// دالة parseTextWithRule هي نفسها لم تتغير
function parseTextWithRule(text, rule) {
    const questions = [];
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    let currentQuestion = null;
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const questionMatch = line.match(rule.questionRegex);
        if (questionMatch) {
            if (currentQuestion) {
                if (currentQuestion.options.length > 0 && currentQuestion.correctAnswerIndex !== undefined) {
                    questions.push(currentQuestion);
                }
            }
            currentQuestion = {
                question: questionMatch[1].trim(),
                options: [],
                correctAnswerIndex: undefined
            };
            let j = i + 1;
            while (j < lines.length && lines[j].match(rule.optionRegex)) {
                const optionMatch = lines[j].match(rule.optionRegex);
                currentQuestion.options.push(optionMatch[1].trim());
                j++;
            }
            i = j - 1;
            if (i + 1 < lines.length) {
                const nextLine = lines[i + 1];
                const answerMatch = nextLine.match(rule.answerRegex);
                if (answerMatch) {
                    let answerText;
                    if (answerMatch[3]) { // This handles "Answer: B) text"
                        answerText = answerMatch[3].trim();
                    } else { // This handles "Answer: text"
                        answerText = answerMatch[2].trim();
                    }
                    const correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === answerText.toLowerCase());
                    if (correctIndex !== -1) {
                        currentQuestion.correctAnswerIndex = correctIndex;
                    }
                    i++;
                }
            }
        }
        i++;
    }
    if (currentQuestion && currentQuestion.options.length > 0 && currentQuestion.correctAnswerIndex !== undefined) {
        questions.push(currentQuestion);
    }
    return questions;
}

function parseTextWithRule(text, rule) {
    const questions = [];
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    let currentQuestion = null;
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const questionMatch = line.match(rule.questionRegex);
        if (questionMatch) {
            if (currentQuestion) {
                if (currentQuestion.options.length > 0 && currentQuestion.correctAnswerIndex !== undefined) {
                    questions.push(currentQuestion);
                }
            }
            currentQuestion = {
                question: questionMatch[1].trim(),
                options: [],
                correctAnswerIndex: undefined
            };
            let j = i + 1;
            while (j < lines.length && lines[j].match(rule.optionRegex)) {
                const optionMatch = lines[j].match(rule.optionRegex);
                currentQuestion.options.push(optionMatch[1].trim());
                j++;
            }
            i = j - 1;
            if (i + 1 < lines.length) {
                const nextLine = lines[i + 1];
                const answerMatch = nextLine.match(rule.answerRegex);
                if (answerMatch) {
                    const answerText = answerMatch[2].trim();
                    const correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === answerText.toLowerCase());
                    if (correctIndex !== -1) {
                        currentQuestion.correctAnswerIndex = correctIndex;
                    }
                    i++;
                }
            }
        }
        i++;
    }

    if (currentQuestion && currentQuestion.options.length > 0 && currentQuestion.correctAnswerIndex !== undefined) {
        questions.push(currentQuestion);
    }
    return questions;
}
