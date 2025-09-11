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
        /^(Answer|Correct Answer|Solution|Ans|Sol):?\s*([A-Z]|\d)\s*[\)\.\/\-_\^&@':;"\\]?\s*(.+)?/i
    ];

    function findMatch(line, patterns) {
        for (const pattern of patterns) {
            const match = line.match(pattern);
            if (match) return match;
        }
        return null;
    }

    while (i < lines.length) {
        const line = lines[i];
        
        const questionMatch = findMatch(line, questionPatterns);
        if (questionMatch) {
            let questionText = questionMatch[0].trim();
            let potentialOptionsIndex = -1;
            let hasBlankLine = false;

            // ابحث عن بداية الخيارات أو عن سطر فارغ
            let j = i + 1;
            while (j < lines.length) {
                if (lines[j].trim().length === 0) {
                    hasBlankLine = true;
                    break; // توقف عند العثور على سطر فارغ
                }
                if (findMatch(lines[j], optionPatterns)) {
                    potentialOptionsIndex = j;
                    break; // توقف عند العثور على بداية الخيارات
                }
                j++;
            }

            // إذا وجدنا سطراً فارغاً قبل الخيارات، فهذا يعني أنه عنوان
            if (hasBlankLine) {
                i++; // انتقل إلى السطر التالي بعد "العنوان" المحتمل وابدأ البحث من جديد
                continue;
            }

            // إذا وجدنا بداية للخيارات
            if (potentialOptionsIndex !== -1) {
                // قم بتجميع كل النص بين بداية السؤال وبداية الخيارات
                for (let k = i + 1; k < potentialOptionsIndex; k++) {
                    questionText += ' ' + lines[k].trim();
                }

                const currentQuestion = {
                    question: questionText,
                    options: [],
                    correctAnswerIndex: undefined
                };

                // استمر من حيث توقفت لتجميع الخيارات
                let k = potentialOptionsIndex;
                while (k < lines.length) {
                    const optionMatch = findMatch(lines[k], optionPatterns);
                    if (optionMatch) {
                        currentQuestion.options.push(optionMatch[2].trim());
                        k++;
                    } else {
                        break;
                    }
                }
                
                i = k - 1; // تحديث المؤشر الرئيسي

                // البحث عن الإجابة بعد الخيارات
                if (i + 1 < lines.length) {
                    const answerMatch = findMatch(lines[i + 1], answerPatterns);
                    if (answerMatch) {
                        const answerText = (answerMatch[3] || answerMatch[2] || answerMatch[1]).trim();
                        let correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === answerText.toLowerCase());
                        
                        if (correctIndex === -1) {
                            const letterMatch = answerText.match(/^[A-Z]|\d/i);
                            if (letterMatch) {
                                const letterOrNumber = letterMatch[0].toUpperCase();
                                const index = isNaN(parseInt(letterOrNumber)) ? letterOrNumber.charCodeAt(0) - 'A'.charCodeAt(0) : parseInt(letterOrNumber) - 1;
                                if (index >= 0 && index < currentQuestion.options.length) {
                                    correctIndex = index;
                                }
                            }
                        }

                        if (correctIndex !== -1) {
                            currentQuestion.correctAnswerIndex = correctIndex;
                            i++; // تحديث المؤشر ليتجاوز سطر الإجابة
                        }
                    }
                }
                
                if (currentQuestion.options.length > 0 && currentQuestion.correctAnswerIndex !== undefined) {
                    questions.push(currentQuestion);
                }
            }
        }
        i++;
    }
    return questions;
}
