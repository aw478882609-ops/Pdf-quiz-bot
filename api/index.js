// ==== بداية كود Vercel الكامل والصحيح (api/index.js) ====

const TelegramBot = require('node-telegram-bot-api');
const pdf = require('pdf-parse');
const axios = require('axios');
const micro = require('micro');

// تهيئة البوت
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

// متغيرات لتخزين حالة المستخدم مؤقتًا
const userState = {};
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// ✨ مجموعة لتتبع الرسائل قيد المعالجة لمنع تكرار التحليل
const processingUpdates = new Set();

/**
 * دالة لإرسال إشعار للمشرف.
 */
async function sendAdminNotification(status, user, fileId, details = '') {
  if (String(user.id) === ADMIN_CHAT_ID) {
    console.log("User is the admin. Skipping self-notification.");
    return;
  }
  if (!ADMIN_CHAT_ID) {
    console.log("ADMIN_CHAT_ID is not set. Skipping notification.");
    return;
  }
  const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  const userUsername = user.username ? `@${user.username}` : 'لا يوجد';
  let captionText = `🔔 *إشعار معالجة ملف* 🔔\n\n`;
  captionText += `*الحالة:* ${status}\n\n`;
  captionText += `*من المستخدم:* ${userName} (${userUsername})\n\n`;
  captionText += `*ID المستخدم:* \`${user.id}\`\n\n`;
  if (details) {
    captionText += `*تفاصيل:* ${details}\n`;
  }
  try {
    await bot.sendDocument(ADMIN_CHAT_ID, fileId, {
        caption: captionText,
        parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error("Failed to send document notification to admin:", error.message);
  }
}

// وحدة التعامل مع الطلبات (النسخة النهائية مع حل مشكلة التكرار)
module.exports = async (req, res) => {
    // ✨ الخطوة 1: أرسل رد النجاح لتليجرام فورًا لمنع إعادة الإرسال
    res.status(200).send('OK');

    try {
        if (req.method !== 'POST') {
            return; // الخروج بصمت لأن الرد تم إرساله بالفعل
        }
        const body = await micro.json(req);
        const update = body;

        // تجاهل أي تحديث لا يحتوي على رسالة أو استعلام
        if (!update.message && !update.callback_query) {
            return;
        }

        // تحديد المعرف الفريد للتحديث لمنع التكرار
        const uniqueId = update.message ? `${update.message.chat.id}-${update.message.message_id}` : update.callback_query.id;
        
        // ✨ الخطوة 2: التحقق مما إذا كان هذا التحديث قيد المعالجة بالفعل
        if (processingUpdates.has(uniqueId)) {
            console.log(`Skipping duplicate update ID: ${uniqueId}`);
            return; // تجاهل التحديث المكرر
        }

        try {
            // ✨ الخطوة 3: قفل هذا التحديث لمنع معالجته مرة أخرى
            processingUpdates.add(uniqueId);

            // 1️⃣ التعامل مع الملفات المرسلة (PDF)
            if (update.message && update.message.document) {
                const message = update.message;
                const chatId = message.chat.id;
                const user = message.from;
                const fileId = message.document.file_id;
                let adminNotificationStatus = '';
                let adminNotificationDetails = '';
                const VERCEL_LIMIT_BYTES = 10 * 1024 * 1024;

                if (message.document.file_size > VERCEL_LIMIT_BYTES) {
                    await bot.sendMessage(chatId, `⚠️ عذرًا، حجم الملف يتجاوز الحد المسموح به (${'10 MB'}).`);
                    adminNotificationStatus = 'ملف مرفوض 🐘';
                    adminNotificationDetails = 'السبب: حجم الملف أكبر من 10 ميجا.';
                } else if (message.document.mime_type !== 'application/pdf') {
                    await bot.sendMessage(chatId, '⚠️ يرجى إرسال ملف بصيغة PDF فقط.');
                    adminNotificationStatus = 'ملف مرفوض 📄';
                    adminNotificationDetails = `السبب: نوع الملف ليس PDF (النوع المرسل: ${message.document.mime_type}).`;
                } else {
                    await bot.sendMessage(chatId, '📑 استلمت الملف، جاري تحليله واستخراج الأسئلة...');
                    try {
                        const fileLink = await bot.getFileLink(fileId);
                        const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
                        const dataBuffer = Buffer.from(response.data);
                        const pdfData = await pdf(dataBuffer);
                        
                        // استدعاء الدالة المُعدّلة (تبدأ بالـ AI)
                        const questions = await extractQuestions(pdfData.text);

                        if (questions.length > 0) {
                            userState[user.id] = { questions: questions };
                            const keyboard = {
                                inline_keyboard: [
                                    [{ text: 'إرسال هنا 📤', callback_data: 'send_here' }],
                                    [{ text: 'إرسال وإغلاق هنا 🔒', callback_data: 'send_and_close_here'}],
                                    [{ text: 'إرسال لقناة/مجموعة 📢', callback_data: 'send_to_channel' }]
                                ]
                            };
                            await bot.sendMessage(chatId, `✅ تم العثور على ${questions.length} سؤالًا.\n\nاختر أين وكيف تريد إرسالها:`, {
                                reply_markup: keyboard
                            });
                            adminNotificationStatus = 'نجاح ✅';
                            adminNotificationDetails = `تم العثور على ${questions.length} سؤال.`;
                        } else {
                            await bot.sendMessage(chatId, '❌ لم أتمكن من العثور على أي أسئلة بصيغة صحيحة في الملف. تأكد أن النص داخل الملف قابل للنسخ وأنه يشبه إحدى الصيغ المدعومة في دليل المستخدم. للمساعدة اضغط /help');
                            adminNotificationStatus = 'نجاح (لكن فارغ) 🤷‍♂️';
                            adminNotificationDetails = 'تمت معالجة الملف لكن لم يتم العثور على أسئلة.';
                        }
                    } catch (error) {
                        console.error("Error processing PDF:", error);
                        await bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء معالجة الملف. يرجى التأكد من أن الملف سليم وغير تالف وتأكد أنه بصيغة pdf. للمساعدة اضغط /help');
                        adminNotificationStatus = 'فشل ❌';
                        adminNotificationDetails = `السبب: ${error.message}`;
                    }
                }
                if (adminNotificationStatus) {
                    await sendAdminNotification(adminNotificationStatus, user, fileId, adminNotificationDetails);
                }
            }

            // 2️⃣ التعامل مع الاختبارات (Quizzes) المعاد توجيهها
            else if (update.message && update.message.poll) {
                // ... (الكود الخاص بهذا الجزء يبقى كما هو)
            }

            // 3️⃣ التعامل مع الضغط على الأزرار (Callback Query)
            else if (update.callback_query) {
                // ... (الكود الخاص بهذا الجزء يبقى كما هو)
            }

            // 4️⃣ التعامل مع الرسائل النصية (ID القناة، /help، إلخ)
            else if (update.message && update.message.text) {
                // ... (الكود الخاص بهذا الجزء يبقى كما هو)
            }

        } finally {
            // ✨ الخطوة 4: إزالة القفل بعد انتهاء المعالجة
            processingUpdates.delete(uniqueId);
        }
    } catch (error) {
        console.error("General error after acknowledging Telegram:", error);
    }
};

// =================================================================
// ✨✨ === قسم الدوال الخاصة باستخراج الأسئلة === ✨✨
// =================================================================

/**
 * ✨✨ === الدالة المُعدّلة: تبدأ بالذكاء الاصطناعي أولاً === ✨✨
 * @param {string} text The text extracted from the PDF.
 * @returns {Promise<Array>} A promise that resolves to an array of question objects.
 */
async function extractQuestions(text) {
    let questions = [];

    // لا نحاول استدعاء الذكاء الاصطناعي إذا كان النص قصيرًا جدًا
    if (text.trim().length > 50) {
        console.log("Attempting AI extraction first...");
        try {
            // نبدأ بمحاولة الاستخراج عبر الـ AI
            questions = await extractWithAI(text);
        } catch (error) {
            console.error("AI extraction failed:", error.message);
            // لا نرجع خطأ، بل نترك الفرصة للطريقة الثانية
            questions = []; 
        }
    }

    // إذا فشل الذكاء الاصطناعي أو لم يجد شيئًا، نلجأ إلى طريقة Regex كخطة بديلة
    if (questions.length === 0) {
        console.log("AI method failed or found 0 questions. Falling back to Regex extraction...");
        try {
            questions = extractWithRegex(text);
        } catch (e) {
            console.error("Regex extraction also failed with an error:", e);
            return []; // هنا فشلت كلتا الطريقتين
        }
    }

    return questions;
}

async function extractWithAI(text) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.log("GEMINI_API_KEY is not set. Skipping AI extraction.");
        return [];
    }
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const prompt = `
    Analyze the following text and extract all multiple-choice questions.
    For each question, provide:
    1. The full question text.
    2. A list of all possible options.
    3. The index of the correct answer (starting from 0).
    VERY IMPORTANT: Respond ONLY with a valid JSON array of objects. Each object should have these exact keys: "question", "options", "correctAnswerIndex". Do not include any text, notes, or markdown formatting before or after the JSON array.
    Example Response Format:
    [
      {
        "question": "What is the capital of France?",
        "options": ["Berlin", "Madrid", "Paris", "Rome"],
        "correctAnswerIndex": 2
      }
    ]
    Here is the text to analyze:
    ---
    ${text}
    ---
    `;
    const payload = {
        contents: [{
            parts: [{ text: prompt }]
        }]
    };
    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        if (!response.data.candidates || response.data.candidates.length === 0 || !response.data.candidates[0].content) {
            console.error("AI responded but with no valid content or candidates.");
            return [];
        }
        const aiResponseText = response.data.candidates[0].content.parts[0].text;
        const cleanedJsonString = aiResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const questions = JSON.parse(cleanedJsonString);
        if (Array.isArray(questions) && questions.length > 0) {
            console.log(`AI successfully extracted ${questions.length} questions.`);
            return questions;
        }
        return [];
    } catch (error) {
        console.error("Error calling or parsing Gemini API response:", error.response ? error.response.data : error.message);
        // نلقي خطأ ليتم التقاطه في دالة extractQuestions
        throw new Error("Failed to get a valid response from AI.");
    }
}

function extractWithRegex(text) {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\f/g, '\n').replace(/\u2028|\u2029/g, '\n');
    text = text.replace(/\n{2,}/g, '\n');
    const lines = text.split('\n').map(l => l.trim());
    const questions = [];
    let i = 0;
    const questionPatterns = [/^(Q|Question|Problem|Quiz|السؤال)?\s*\d+[\s\.\)\]\-\ـ]/];
    const letterOptionPatterns = [
        /^\s*[\-\*]?\s*([A-Z])[\.\)\-:]\s*(.+)/i,
        /^\s*([A-Z])\s*-\s*(.+)/i,
        /^\s*[\(\[\{]([A-Z])[\)\]\}]\s*(.+)/i,
    ];
    const numberOptionPatterns = [
        /^\s*[\-\*]?\s*(\d+)[\.\)\-:]\s*(.+)/,
        /^\s*(\d+)\s*-\s*(.+)/,
        /^\s*[\(\[\{](\d+)[\)\]\}]\s*(.+)/,
    ];
    const romanOptionPatterns = [
        /^\s*([IVXLCDM]+)[\.\)\-]\s*(.+)/i,
    ];
    const optionPatterns = [...letterOptionPatterns, ...numberOptionPatterns, ...romanOptionPatterns];
    const answerPatterns = [/^\s*[\-\*]?\s*(Answer|Correct Answer|Solution|Ans|Sol)\s*[:\-\.,;\/]?\s*/i];
    function findMatch(line, patterns) { for (const pattern of patterns) { const match = line.match(pattern); if (match) return match; } return null; }
    function romanToNumber(roman) {
        const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
        let num = 0;
        for (let i = 0; i < roman.length; i++) {
            const current = map[roman[i].toUpperCase()];
            const next = i + 1 < roman.length ? map[roman[i + 1].toUpperCase()] : 0;
            if (next > current) {
                num -= current;
            } else {
                num += current;
            }
        }
        return num;
    }
    function validateOptionsSequence(optionLines) {
        if (optionLines.length < 2) return true;
        let style = null;
        let lastValue = null;
        for (let j = 0; j < optionLines.length; j++) {
            const line = optionLines[j];
            let currentStyle = null;
            let currentValue = null;
            let identifier = '';
            if (findMatch(line, numberOptionPatterns)) {
                currentStyle = 'numbers';
                identifier = findMatch(line, numberOptionPatterns)[1];
                currentValue = parseInt(identifier, 10);
            } else if (findMatch(line, letterOptionPatterns)) {
                currentStyle = 'letters';
                identifier = findMatch(line, letterOptionPatterns)[1].toUpperCase();
                currentValue = identifier.charCodeAt(0);
            } else if (findMatch(line, romanOptionPatterns)) {
                currentStyle = 'roman';
                identifier = findMatch(line, romanOptionPatterns)[1].toUpperCase();
                currentValue = romanToNumber(identifier);
            } else {
                return false;
            }
            if (j === 0) {
                style = currentStyle;
                lastValue = currentValue;
            } else {
                if (currentStyle !== style || currentValue !== lastValue + 1) {
                    return false;
                }
                lastValue = currentValue;
            }
        }
        return true;
    }
    while (i < lines.length) {
        const line = lines[i];
        if (!line) { i++; continue; }
        const optionInFollowingLines = lines.slice(i + 1, i + 6).some(l => findMatch(l, optionPatterns));
        const isQuestionStart = findMatch(line, questionPatterns) || (optionInFollowingLines && !findMatch(line, optionPatterns) && !findMatch(line, answerPatterns));
        if (!isQuestionStart) { i++; continue; }
        let questionText = line;
        let potentialOptionsIndex = i + 1;
        let j = i + 1;
        while (j < lines.length && !findMatch(lines[j], optionPatterns) && !findMatch(lines[j], answerPatterns)) {
            questionText += ' ' + lines[j].trim();
            potentialOptionsIndex = j + 1;
            j++;
        }
        if (potentialOptionsIndex < lines.length && findMatch(lines[potentialOptionsIndex], optionPatterns)) {
            const currentQuestion = { question: questionText.trim(), options: [], correctAnswerIndex: undefined };
            let k = potentialOptionsIndex;
            const optionLines = [];
            while (k < lines.length) {
                const optLine = lines[k];
                if (!optLine || findMatch(optLine, answerPatterns)) break;
                const optionMatch = findMatch(optLine, optionPatterns);
                if (optionMatch) {
                    optionLines.push(optLine);
                    currentQuestion.options.push(optionMatch[2].trim());
                    k++;
                } else {
                    break;
                }
            }
            if (!validateOptionsSequence(optionLines)) { i++; continue; }
            if (k < lines.length && findMatch(lines[k], answerPatterns)) {
                const answerLine = lines[k];
                let answerText = answerLine.replace(answerPatterns[0], '').trim();
                let correctIndex = -1;
                const cleanAnswerText = answerText.replace(/^[A-Z\dIVXLCDM]+[\.\)]\s*/i, '').trim();
                correctIndex = currentQuestion.options.findIndex(opt => opt.toLowerCase() === cleanAnswerText.toLowerCase());
                if (correctIndex === -1) {
                    const identifierMatch = answerText.match(/^[A-Z\dIVXLCDM]+/i);
                    if (identifierMatch) {
                        const firstOptionLine = optionLines[0];
                        if (findMatch(firstOptionLine, numberOptionPatterns)) {
                            correctIndex = parseInt(identifierMatch[0], 10) - 1;
                        } else if (findMatch(firstOptionLine, letterOptionPatterns)) {
                            correctIndex = identifierMatch[0].toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
                        } else if (findMatch(firstOptionLine, romanOptionPatterns)) {
                             correctIndex = romanToNumber(identifierMatch[0].toUpperCase()) - 1;
                        }
                    }
                }
                 if (correctIndex >= 0 && correctIndex < currentQuestion.options.length) {
                    currentQuestion.correctAnswerIndex = correctIndex;
                 }
                i = k + 1;
            } else {
                i = k;
            }
            if (currentQuestion.options.length > 1 && currentQuestion.correctAnswerIndex !== undefined) {
                questions.push(currentQuestion);
            }
        } else {
            i++;
        }
    }
    return questions;
}

function formatQuizText(quizData) {
    let formattedText = ` ${quizData.question}\n\n`;
    const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const formattedOptions = quizData.options.map((optionText, optIndex) => {
        return `${optionLetters[optIndex]}) ${optionText}`;
    });
    formattedText += formattedOptions.join('\n');
    if (quizData.correctOptionId !== null && quizData.correctOptionId >= 0) {
        const correctLetter = optionLetters[quizData.correctOptionId];
        const correctText = quizData.options[quizData.correctOptionId];
        formattedText += `\n\nAnswer: ${correctLetter}) ${correctText}`;
    }
    if (quizData.explanation) {
        formattedText += `\nExplanation: ${quizData.explanation}`;
    }
    return formattedText;
}
