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
    const lines = text.split('\n').map(line => line.trim());
    let i = 0;

    const questionPatterns = [
        /^\s*(q|question)\s*\d+\s*[:\s-]?\s*(.+)/i,
        /^\d+\.\s(.+)/,
        /^(What|Which|Who|How|When|Where|Select|Choose|In the following|Identify)\s(.+)/i,
        /^(.+)\?$/,
        /^(.+):$/
    ];
    const optionPatterns = [
        /^\s*([A-Z])[\)\.\/\-_\^&@':;"\\]\s*(.+)/i,
        /^\s*(\d+)[\)\.\/\-_\^&@':;"\\]\s*(.+)/,
        /^\s*\[([A-Z])\]\s*(.+)/i,
        /^\s*\(\s*([A-Z])\s*\)\s*(.+)/i,
        /^\s*([A-Z])\s+(.+)/i,
        /^\s*(\d+)\s+(.+)/
    ];
    const answerPatterns = [
        /^(Answer|Correct Answer|Solution|Ans|Sol):?\s*([A-Z]|\d)\s*[\)\.\/\-_\^&@':;"\\]?\s*(.+)?/i,
        /^\s*([A-Z])\s*[\)\.\/\-_\^&@':;"\\]\s*(.+?)\s*$/i,
        /^\s*\d+\s*[\)\.\/\-_\^&@':;"\\]\s*(.+?)\s*$/
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
        
        const questionMatch = findMatch(line, questionPatterns);
        if (questionMatch) {
            // Find start of question
            questionText = questionMatch[0].trim();
            let hasBlankLine = false;

            // Greedily collect question text until a stop condition
            let j = i + 1;
            while (j < lines.length && !findMatch(lines[j], questionPatterns) && !findMatch(lines[j], optionPatterns)) {
                if (lines[j].trim().length === 0) {
                    hasBlankLine = true;
                    break;
                }
                questionText += ' ' + lines[j].trim();
                j++;
            }
            
            if (hasBlankLine) {
                i = j;
                continue;
            }
            i = j - 1;

            const currentQuestion = {
                question: questionText,
                options: [],
                correctAnswerIndex: undefined
            };

            // Collect options
            let k = i + 1;
            while (k < lines.length) {
                const optionMatch = findMatch(lines[k], optionPatterns);
                if (optionMatch) {
                    currentQuestion.options.push(optionMatch[2].trim());
                    k++;
                } else {
                    break;
                }
            }
            i = k - 1;

            // Find answer
            if (i + 1 < lines.length) {
                const answerMatch = findMatch(lines[i + 1], answerPatterns);
                if (answerMatch) {
                    const answerText = (answerMatch[3] || answerMatch[2] || answerMatch[1]).trim();
                    const correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === answerText.toLowerCase());
                    if (correctIndex !== -1) {
                        currentQuestion.correctAnswerIndex = correctIndex;
                    } else {
                        const letterMatch = answerText.match(/^[A-Z]|\d/i);
                        if (letterMatch) {
                            const letterOrNumber = letterMatch[0].toUpperCase();
                            const index = isNaN(parseInt(letterOrNumber)) ? letterOrNumber.charCodeAt(0) - 'A'.charCodeAt(0) : parseInt(letterOrNumber) - 1;
                            if (index >= 0 && index < currentQuestion.options.length) {
                                currentQuestion.correctAnswerIndex = index;
                            }
                        }
                    }
                    i++;
                }
            }
            
            if (currentQuestion.options.length > 0 && currentQuestion.correctAnswerIndex !== undefined) {
                questions.push(currentQuestion);
            }
        }
        i++;
    }
    return questions;
}
