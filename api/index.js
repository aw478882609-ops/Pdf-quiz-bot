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
    const rules = [
        {
            name: "Numbered Questions with Lettered Options (A., B.) and Answer Key",
            questionRegex: /^\d+\.\s(.+?)(?=\n|$)/,
            optionRegex: /^[A-D]\.\s(.+)/,
            answerRegex: /^(Correct Answer|Answer|Solution):?\s*(.+)/i
        },
        {
            name: "Numbered Questions with Numbered Options (1., 2.) and Answer Key",
            questionRegex: /^\d+\.\s(.+?)(?=\n|$)/,
            optionRegex: /^\d+\.\s(.+)/,
            answerRegex: /^(Correct Answer|Answer|Solution):?\s*(.+)/i
        },
        {
            name: "Questions with Question Words (What, Which, Who, etc.)",
            questionRegex: /^(What|Which|Who|How|When|Where) (.+?\??)(?=\n|$)/,
            optionRegex: /^\d+\.\s(.+)/,
            answerRegex: /^(Correct Answer|Answer|Solution):?\s*(.+)/i
        }
    ];

    for (const rule of rules) {
        try {
            const questions = parseTextWithRule(text, rule);
            if (questions.length > 0) {
                return questions;
            }
        } catch (e) {
            console.error(`Parsing with rule "${rule.name}" failed: ${e.message}`);
        }
    }
    return [];
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
