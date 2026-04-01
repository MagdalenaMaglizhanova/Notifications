const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const webpush = require('web-push');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// 1. FIREBASE ADMIN SDK
// ============================================
let db;

try {
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
        console.warn('⚠️ Firebase не е конфигуриран');
        db = null;
    }
} catch (error) {
    console.error('❌ Грешка при Firebase:', error.message);
    db = null;
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

// Запазване на FCM токен
app.post('/api/subscribe', async (req, res) => {
    const { token, userId = 'default' } = req.body;
    
    if (!token) {
        return res.status(400).json({ error: 'Token is required' });
    }
    
    try {
        if (db) {
            await db.collection('subscriptions').doc(userId).set({
                token: token,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`✅ Токен запазен: ${token.substring(0, 30)}...`);
        } else {
            console.log(`📝 Mock mode - token: ${token.substring(0, 30)}...`);
        }
        
        res.json({ success: true, message: 'Subscribed successfully' });
    } catch (error) {
        console.error('❌ Грешка:', error);
        res.status(500).json({ error: error.message });
    }
});

// Изпращане на въпрос
app.post('/api/ask', async (req, res) => {
    const { question } = req.body;
    
    if (!question) {
        return res.status(400).json({ error: 'Question is required' });
    }
    
    try {
        let tokens = [];
        
        if (db) {
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
                const subscription = {
                    endpoint: token,
                    keys: { auth: '', p256dh: '' }
                };
                
                await webpush.sendNotification(subscription, payload);
                successCount++;
                console.log(`✅ Изпратено до: ${token.substring(0, 30)}...`);
            } catch (err) {
                console.error(`❌ Грешка: ${err.message}`);
            }
        }
        
        res.json({ success: true, sent: successCount, total: tokens.length });
    } catch (error) {
        console.error('❌ Грешка:', error);
        res.status(500).json({ error: error.message });
    }
});

// Получаване на отговор
app.post('/api/answer', async (req, res) => {
    const { answer, questionId, token, userId } = req.body;
    
    console.log(`📝 Отговор от ${userId || 'anonymous'}: "${answer}"`);
    
    // AI логика
    const lowerAnswer = answer?.toLowerCase() || '';
    
    if (lowerAnswer.includes('да') || lowerAnswer.includes('yes')) {
        console.log('🎯 ДЕЙСТВИЕ: Включвам отоплението!');
        
        // Изпрати потвърждение
        if (token && webpush) {
            const confirmPayload = JSON.stringify({
                title: '✅ Действие изпълнено',
                body: 'Включвам отоплението! 🔥',
                data: { action: 'heating_on' }
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
        console.log('ℹ️ ДЕЙСТВИЕ: Нищо не правя');
    }
    
    // Запази отговора
    if (db) {
        try {
            await db.collection('responses').add({
                answer: answer,
                questionId: questionId,
                userId: userId || 'anonymous',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (err) {
            console.error('Грешка при запис:', err.message);
        }
    }
    
    res.json({ success: true, message: 'Answer received' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
