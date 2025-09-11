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
//                دالة استخراج الأسئلة من النص
// =================================================================
function extractQuestions(text) {
    const questions = [];

    // 🧹 تنظيف النص
    text = text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\f/g, '\n')
        .replace(/\u2028|\u2029/g, '\n');

    const lines = text.split('\n').map(l => l.trim());
    let i = 0;

    // ✅ أنماط بداية السؤال
    const questionPatterns = [
        /^\s*(q|question)\s*\d+\s*[:\s-]?\s*(.+)/i,  
        /^\d+\.\s(.+)/,                              
        /^(What|Which|Who|How|When|Where|Select|Choose|In the following|Identify|Explain|Define|Describe|List|State|Write|Give)\s(.+)/i, 
        /^(.+)\?$/,                                  
        /^(.+):$/                                    
    ];

    // ✅ أنماط الخيارات
    const optionPatterns = [
        /^\s*([A-Z])[\)\.\/\-_\^&@':;"\\]\s*(.+)/i, 
        /^\s*(\d+)[\)\.\/\-_\^&@':;"\\]\s*(.+)/,   
        /^\s*\[([A-Z])\]\s*(.+)/i,                 
        /^\s*\(\s*([A-Z])\s*\)\s*(.+)/i,           
        /^\s*([A-Z])\s+(.+)/i,                     
        /^\s*(\d+)\s+(.+)/                         
    ];

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

    // ✅ التحقق من تناسق الاختيارات
    function areOptionsConsistent(optionLines) {
        if (optionLines.length === 0) return false;
        let style = null;

        for (const line of optionLines) {
            if (/^[A-Z][\)\.\s]/.test(line)) {
                if (!style) style = "letters";
                if (style !== "letters") return false;
            } else if (/^\d+[\)\.\s]/.test(line)) {
                if (!style) style = "numbers";
                if (style !== "numbers") return false;
            } else {
                return false;
            }
        }
        return true;
    }

    while (i < lines.length) {
        const line = lines[i].trim();
        if (!line) {
            i++;
            continue;
        }

        const questionMatch = findMatch(line, questionPatterns);

        if (questionMatch) {
            // ✅ أول ما يتعرف على بداية سؤال → يبدأ التجميع مباشرة
            let questionText = questionMatch[0].trim();
            let m = i + 1;
            while (m < lines.length) {
                const nextLine = lines[m].trim();
                if (!nextLine) { m++; continue; }

                // وقف عند أول اختيار أو إجابة
                if (findMatch(nextLine, optionPatterns) || findMatch(nextLine, answerPatterns)) {
                    break;
                }
                questionText += ' ' + nextLine;
                m++;
            }

            // 🟡 ابحث عن أول اختيار بعد السؤال
            let potentialOptionsIndex = -1;
            let j = m;
            while (j < lines.length) {
                if (findMatch(lines[j], optionPatterns)) {
                    potentialOptionsIndex = j;
                    break;
                }
                if (findMatch(lines[j], answerPatterns)) {
                    potentialOptionsIndex = -1;
                    break;
                }
                j++;
            }

            if (potentialOptionsIndex !== -1) {
                const currentQuestion = {
                    question: questionText,
                    options: [],
                    correctAnswerIndex: undefined
                };

                // ✅ اجمع الاختيارات لحد ما يقابل إجابة
                let k = potentialOptionsIndex;
                const optionLines = [];
                while (k < lines.length) {
                    if (findMatch(lines[k], answerPatterns)) {
                        break; 
                    }
                    const optionMatch = findMatch(lines[k], optionPatterns);
                    if (optionMatch) {
                        optionLines.push(lines[k]);
                        const optionText = optionMatch[2] ? optionMatch[2].trim() : optionMatch[1].trim();
                        currentQuestion.options.push(optionText);
                        k++;
                    } else {
                        break;
                    }
                }

                // ✅ تحقق من تناسق الاختيارات
                if (!areOptionsConsistent(optionLines)) {
                    console.log("📌 تم تجاهل سؤال (اختيارات غير متناسقة):", questionText);
                    i++;
                    continue;
                }

                i = k - 1;

                // ✅ دور على الإجابة
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

                if (currentQuestion.options.length > 0 && currentQuestion.correctAnswerIndex !== undefined) {
                    questions.push(currentQuestion);
                }
            }
        }

        i++;
    }

    return questions;
}
