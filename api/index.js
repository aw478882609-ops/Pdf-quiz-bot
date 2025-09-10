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

    // أنماط البحث الشاملة
    const questionPatterns = [
        /^(What|Which|Who|How|When|Where|Select|Choose|In the following|Identify)\s/i,
        /^\d+\.\s(.+?\??)$/
    ];
    const optionPatterns = [
        /^[A-Z]\)\s*(.+)/,
        /^[A-Z]\.\s*(.+)/,
        /^\d+\)\s*(.+)/,
        /^\d+\.\s*(.+)/,
        /^\[[A-Z]\]\s*(.+)/,
        /^\(\s*([A-Z])\s*\)\s*(.+)/
    ];
    const answerPatterns = [
        /^(Answer|Correct Answer|Solution):?\s*([A-Z]|\d)\s*\)?\s*(.+)?/i,
        /^\s*([A-Z])\s*\)\s*(.+?)\s*$/,
        /^\s*\d+\.\s*(.+?)\s*$/,
        /^\s*(Correct|Solution)\s*([A-Z])\s*\)?\s*(.+)?/i
    ];
    
    function findMatch(line, patterns) {
        for (const pattern of patterns) {
            const match = line.match(pattern);
            if (match) {
                return match;
            }
        }
        return null;
    }

    while (i < lines.length) {
        const line = lines[i];
        let questionText = null;
        
        // 1. البحث عن السؤال
        // الحالة الأولى: السؤال يبدأ برقم وعنوان ثم جملة السؤال (كما في ملفك)
        const titleMatch = findMatch(line, [/^(\d+\.\s.*)/]);
        if (titleMatch && i + 1 < lines.length && findMatch(lines[i+1], questionPatterns)) {
            questionText = lines[i + 1];
            i++;
        }
        // الحالة الثانية: السؤال يبدأ مباشرة بكلمة استفهام
        else if (findMatch(line, questionPatterns)) {
            questionText = line;
        }

        if (questionText) {
            if (currentQuestion && currentQuestion.options.length > 0 && currentQuestion.correctAnswerIndex !== undefined) {
                questions.push(currentQuestion);
            }
            
            currentQuestion = {
                question: questionText.trim(),
                options: [],
                correctAnswerIndex: undefined
            };

            // 2. البحث عن الخيارات
            let j = i + 1;
            while (j < lines.length) {
                const optionMatch = findMatch(lines[j], optionPatterns);
                if (optionMatch) {
                    currentQuestion.options.push(optionMatch[1].trim());
                    j++;
                } else {
                    break;
                }
            }
            i = j - 1;

            // 3. البحث عن الإجابة
            if (i + 1 < lines.length) {
                const answerMatch = findMatch(lines[i + 1], answerPatterns);
                if (answerMatch) {
                    const answerText = (answerMatch[3] || answerMatch[2] || answerMatch[1]).trim();
                    const correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === answerText.toLowerCase());
                    if (correctIndex !== -1) {
                        currentQuestion.correctAnswerIndex = correctIndex;
                    } else {
                        const letterMatch = answerText.match(/^[A-Z]/i);
                        if (letterMatch) {
                            const letter = letterMatch[0].toUpperCase();
                            const index = letter.charCodeAt(0) - 'A'.charCodeAt(0);
                            if (index >= 0 && index < currentQuestion.options.length) {
                                currentQuestion.correctAnswerIndex = index;
                            }
                        }
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
