// دالة مساعدة لإرسال الأسئلة (النسخة المحسنة والأسرع)
async function sendPolls(targetChatId, questions) {
    const chunkSize = 20; // إرسال 20 سؤالًا في كل دفعة
    const delay = 1000; // الانتظار لمدة ثانية واحدة بين كل دفعة

    for (let i = 0; i < questions.length; i += chunkSize) {
        const chunk = questions.slice(i, i + chunkSize);
        
        // إنشاء مجموعة من الوعود لإرسال الدفعة الحالية بالتوازي
        const promises = chunk.map(q => {
            if (q.question.length > 255) {
                // إذا كان السؤال طويلاً، أرسل النص أولاً ثم الاستطلاع
                return bot.sendMessage(targetChatId, q.question)
                    .then(() => bot.sendPoll(targetChatId, '.', q.options, {
                        type: 'quiz',
                        correct_option_id: q.correctAnswerIndex,
                        is_anonymous: true
                    }));
            } else {
                // أرسل الاستطلاع مباشرة
                return bot.sendPoll(targetChatId, q.question, q.options, {
                    type: 'quiz',
                    correct_option_id: q.correctAnswerIndex,
                    is_anonymous: true
                });
            }
        });

        // انتظار اكتمال إرسال الدفعة الحالية
        await Promise.all(promises);

        // الانتظار قبل إرسال الدفعة التالية (إذا كانت هناك دفعات متبقية)
        if (i + chunkSize < questions.length) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
