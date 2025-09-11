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

                // ✅ استدعاء دالة Debug هنا
                debugPdfText(text);

                // بعد ما تشوف الـ Console وتفهم شكل البيانات
                // تقدر تفعل extractQuestions
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

// =====================
// Debug Function
// =====================
function debugPdfText(text) {
    // 🧹 تنظيف مبدئي
    text = text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\f/g, '\n')
        .replace(/\u2028|\u2029/g, '\n');

    const lines = text.split('\n');

    console.log("\n=== أول 20 سطر بعد استخراج النص ===");
    lines.slice(0, 20).forEach((line, idx) => {
        console.log(`${idx + 1}: [${line}]`);
    });
}

// =====================
// Question Extractor
// =====================
function extractQuestions(text) {
    // (خليها فاضية دلوقتي أو حط النسخة القديمة)
    return [];
}
