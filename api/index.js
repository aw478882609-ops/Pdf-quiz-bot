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
                        // التحقق من طول السؤال
                        if (q.question.length > 255) {
                            // إرسال السؤال كنص عادي
                            await bot.sendMessage(chatId, q.question);
                            // ثم إرسال الخيارات كاستطلاع برأس قصير
                            await bot.sendPoll(chatId, '.', q.options, {
                                type: 'quiz',
                                correct_option_id: q.correctAnswerIndex,
                                is_anonymous: false
                            });
                        } else {
                            // إرسال الاستطلاع برأس السؤال الكامل
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

    // أنماط شاملة للأسئلة والخيارات والإجابات
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
        /^\s*\(\s*([A-Z])\s*\)\s*(.+)/i
    ];
    const answerPatterns = [
        /^(Answer|Correct Answer|Solution|Ans|Sol):?\s*([A-Z]|\d)\s*[\)\.\/\-_\^&@':;"\\]?\s*(.+)?/i,
        /^\s*([A-Z])\s*[\)\.\/\-_\^&@':;"\\]\s*(.+?)\s*$/i,
        /^\s*\d+\s*[\)\.\/\-_\^&@':;"\\]\s*(.+?)\s*$/
    ];

    // نمط شامل للتقاط كتل الأسئلة بالكامل
    const questionBlockRegex = new RegExp(
        `(^${questionPatterns.map(p => p.source).join('|')}.*?)(?=${questionPatterns.map(p => p.source).join('|')}|$)`, 'gs'
    );
    let match;

    while ((match = questionBlockRegex.exec(text)) !== null) {
        const block = match[0].trim();
        const blockLines = block.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        
        let questionText = '';
        let options = [];
        let answerText = '';
        let hasAnswer = false;

        for (const line of blockLines) {
            const answerMatch = findMatch(line, answerPatterns);
            const optionMatch = findMatch(line, optionPatterns);
            const questionMatch = findMatch(line, questionPatterns);

            if (answerMatch) {
                answerText = (answerMatch[3] || answerMatch[2] || answerMatch[1]).trim();
                hasAnswer = true;
            } else if (optionMatch) {
                options.push(optionMatch[2].trim());
            } else if (!questionText && questionMatch) {
                questionText = questionMatch[0].trim();
            } else if (!questionText && line.length > 0) {
                // التقاط السطور المتعددة للسؤال
                questionText += (questionText ? ' ' : '') + line;
            }
        }

        if (questionText && options.length > 0 && hasAnswer) {
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

function findMatch(line, patterns) {
    for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
            return match;
        }
    }
    return null;
}
