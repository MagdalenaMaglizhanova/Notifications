const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const webpush = require('web-push');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check за Render
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// 1. FIREBASE ADMIN SDK
// ============================================
let db;

try {
    // Проверка дали сме в production (Render) или development
    if (process.env.FIREBASE_PRIVATE_KEY) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            })
        });
        db = admin.firestore();
        console.log('✅ Firebase Admin SDK инициализиран');
    } else {
        console.warn('⚠️ Firebase не е конфигуриран, използвам mock режим');
        db = {
            collection: () => ({
                doc: () => ({
                    set: async () => console.log('Mock: saving token'),
                    get: async () => ({ exists: false, data: () => null })
                }),
                get: async () => ({ docs: [], empty: true })
            })
        };
    }
} catch (error) {
    console.error('❌ Грешка при Firebase:', error.message);
}

// ============================================
// 2. WEB PUSH (VAPID)
// ============================================
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        'mailto:' + (process.env.VAPID_EMAIL || 'admin@ai-assistant.com'),
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
    console.log('✅ Web Push инициализиран');
} else {
    console.warn('⚠️ VAPID ключове не са конфигурирани');
}

// ============================================
// 3. API ENDPOINTS
// ============================================

// Запазване на FCM токен от клиента
app.post('/api/subscribe', async (req, res) => {
    const { token, userId = 'default' } = req.body;
    
    if (!token) {
        return res.status(400).json({ error: 'Token is required' });
    }
    
    try {
        if (db && !db.isDummy) {
            await db.collection('subscriptions').doc(userId).set({
                token: token,
                endpoint: token,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        
        console.log(`✅ Токен запазен за user: ${userId}`);
        res.json({ success: true, message: 'Subscribed successfully' });
    } catch (error) {
        console.error('❌ Грешка:', error);
        res.status(500).json({ error: error.message });
    }
});

// Изпращане на въпрос до всички потребители
app.post('/api/ask', async (req, res) => {
    const { question } = req.body;
    
    if (!question) {
        return res.status(400).json({ error: 'Question is required' });
    }
    
    try {
        let tokens = [];
        
        // Вземи всички токени от Firestore
        if (db && !db.isDummy) {
            const snapshot = await db.collection('subscriptions').get();
            tokens = snapshot.docs.map(doc => doc.data().token).filter(t => t);
        }
        
        if (tokens.length === 0) {
            return res.status(404).json({ error: 'No subscribers found' });
        }
        
        const payload = JSON.stringify({
            title: '🤖 AI Assistant',
            body: question,
            data: {
                question: question,
                questionId: Date.now().toString()
            }
        });
        
        let successCount = 0;
        
        for (const token of tokens) {
            try {
                // За FCM token трябва да е във формат { endpoint, keys }
                // За опростяване, тук приемаме че token е endpoint
                const subscription = {
                    endpoint: token,
                    keys: {
                        auth: '',
                        p256dh: ''
                    }
                };
                
                await webpush.sendNotification(subscription, payload);
                successCount++;
                console.log(`✅ Изпратено до: ${token.substring(0, 20)}...`);
            } catch (err) {
                console.error(`❌ Грешка за токен ${token.substring(0, 20)}...:`, err.message);
            }
        }
        
        res.json({ success: true, sent: successCount, total: tokens.length });
    } catch (error) {
        console.error('❌ Грешка при изпращане:', error);
        res.status(500).json({ error: error.message });
    }
});

// Получаване на отговор от потребителя
app.post('/api/answer', async (req, res) => {
    const { answer, questionId, token, userId } = req.body;
    
    console.log(`📝 Отговор от ${userId || 'anonymous'}: "${answer}" на въпрос ${questionId}`);
    
    // 🔥 AI ЛОГИКАТА Е ТУК
    try {
        const lowerAnswer = answer?.toLowerCase() || '';
        
        if (lowerAnswer.includes('да') || lowerAnswer.includes('yes')) {
            console.log('🎯 ДЕЙСТВИЕ: Потребителят каза ДА!');
            
            // Тук добави каквото действие искаш:
            // - Включи отопление
            // - Изпрати SMS
            // - Запази в календар
            // - Изпрати email и т.н.
            
            // Пример: Изпрати потвърждение обратно
            if (token) {
                const confirmPayload = JSON.stringify({
                    title: '✅ Действие изпълнено',
                    body: 'Разбрах, че се прибираш. Включвам отоплението! 🔥',
                    data: { action: 'heating_on', status: 'success' }
                });
                
                try {
                    const subscription = {
                        endpoint: token,
                        keys: { auth: '', p256dh: '' }
                    };
                    await webpush.sendNotification(subscription, confirmPayload);
                } catch (err) {
                    console.error('Грешка при потвърждение:', err.message);
                }
            }
        } else if (lowerAnswer.includes('не') || lowerAnswer.includes('no')) {
            console.log('ℹ️ ДЕЙСТВИЕ: Потребителят каза НЕ, нищо не правя');
        } else {
            console.log(`🤔 Неразпознат отговор: "${answer}"`);
        }
        
        // Запази отговора в базата (ако има Firestore)
        if (db && !db.isDummy) {
            await db.collection('responses').add({
                answer: answer,
                questionId: questionId,
                userId: userId || 'anonymous',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        
        res.json({ success: true, message: 'Answer received' });
    } catch (error) {
        console.error('❌ Грешка при обработка:', error);
        res.status(500).json({ error: error.message });
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'AI Assistant Backend',
        version: '1.0.0',
        status: 'running',
        endpoints: ['/health', '/api/subscribe', '/api/ask', '/api/answer']
    });
});

// ============================================
// 4. СТАРТИРАНЕ
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
});
