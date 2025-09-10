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

    // نمط شامل للتقاط كل كتلة سؤال منفصلة
    const questionBlockRegex = /(\d+\.\s.*?)(?=\d+\.\s|Answer:|Correct Answer:|Solution:|$)/gs;
    let match;

    while ((match = questionBlockRegex.exec(text)) !== null) {
        const block = match[1].trim();
        const blockLines = block.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        
        let questionText = '';
        let options = [];
        let answerText = '';

        // أنماط فرعية لتحليل الكتلة
        const questionTextRegex = /^(\d+\.\s|\s*(q|question)\s*\d+\s*[:\s-]?\s*|What|Which|Who|How|When|Where|Select|Choose|In the following|Identify|.+?\?|.+:)(.+)/i;
        const optionRegex = /^\s*([A-Z]|\d)[\)\.\/\-_\^&@':;"\\]\s*(.+)/i;
        const answerRegex = /^(Answer|Correct Answer|Solution|Ans|Sol):?\s*([A-Z]|\d)[\)\.\/\-_\^&@':;"\\]?\s*(.+)?/i;

        for (const line of blockLines) {
            if (line.match(answerRegex)) {
                const answerMatch = line.match(answerRegex);
                answerText = (answerMatch[3] || answerMatch[2] || answerMatch[1]).trim();
            } else if (line.match(optionRegex)) {
                const optionMatch = line.match(optionRegex);
                options.push(optionMatch[2].trim());
            } else if (line.match(questionTextRegex)) {
                questionText = line.trim();
            }
        }

        if (questionText && options.length > 0 && answerText) {
            const correctIndex = options.findIndex(opt => opt.toLowerCase() === answerText.toLowerCase());

            if (correctIndex === -1) {
                const letterMatch = answerText.match(/^[A-Z]|\d/i);
                if (letterMatch) {
                    const letterOrNumber = letterMatch[0].toUpperCase();
                    const index = isNaN(parseInt(letterOrNumber)) ? letterOrNumber.charCodeAt(0) - 'A'.charCodeAt(0) : parseInt(letterOrNumber) - 1;
                    if (index >= 0 && index < options.length) {
                        questions.push({
                            question: questionText,
                            options: options,
                            correctAnswerIndex: index
                        });
                    }
                }
            } else {
                questions.push({
                    question: questionText,
                    options: options,
                    correctAnswerIndex: correctIndex
                });
            }
        }
    }
    return questions;
}
