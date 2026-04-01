const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Firebase Admin
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
    }
} catch (error) {
    console.error('Firebase error:', error.message);
}

// Subscribe - запазва FCM токен
app.post('/api/subscribe', async (req, res) => {
    const { token, userId = 'default' } = req.body;
    
    if (!token) {
        return res.status(400).json({ error: 'Token required' });
    }
    
    try {
        if (db) {
            await db.collection('subscriptions').doc(userId).set({
                fcmToken: token,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        console.log('✅ FCM Token запазен:', token.substring(0, 50) + '...');
        res.json({ success: true });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Ask - изпраща въпрос чрез FCM
app.post('/api/ask', async (req, res) => {
    const { question } = req.body;
    
    if (!question) {
        return res.status(400).json({ error: 'Question required' });
    }
    
    try {
        // Вземи всички FCM токени
        let tokens = [];
        if (db) {
            const snapshot = await db.collection('subscriptions').get();
            tokens = snapshot.docs.map(doc => doc.data().fcmToken).filter(t => t);
        }
        
        if (tokens.length === 0) {
            return res.status(404).json({ error: 'No subscribers found' });
        }
        
        console.log(`📤 Изпращане до ${tokens.length} устройства...`);
        
        // Създай съобщението
        const message = {
            notification: {
                title: '🤖 AI Assistant',
                body: question,
            },
            data: {
                question: question,
                questionId: Date.now().toString(),
            },
            tokens: tokens
        };
        
        // Изпрати чрез Firebase Admin SDK
        const response = await admin.messaging().sendEachForMulticast(message);
        
        console.log(`📤 Изпратени: ${response.successCount} успешни, ${response.failureCount} неуспешни`);
        
        // Лог на грешките
        if (response.failureCount > 0) {
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    console.error(`Грешка за токен ${idx}:`, resp.error);
                }
            });
        }
        
        res.json({ 
            success: true, 
            sent: response.successCount, 
            total: tokens.length 
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: error.message });
    }
});

// Answer - получава отговор
app.post('/api/answer', async (req, res) => {
    const { answer, questionId, token, userId } = req.body;
    
    console.log(`📝 Отговор от ${userId || 'anonymous'}: "${answer}"`);
    
    const lowerAnswer = answer?.toLowerCase() || '';
    
    if (lowerAnswer.includes('да')) {
        console.log('🎯 ДЕЙСТВИЕ: Включвам отоплението! 🔥');
        
        // Изпрати потвърждение обратно
        if (token) {
            const confirmMessage = {
                notification: {
                    title: '✅ Действие изпълнено',
                    body: 'Включвам отоплението! 🔥',
                },
                data: {
                    action: 'heating_on',
                    status: 'success'
                },
                token: token
            };
            
            try {
                await admin.messaging().send(confirmMessage);
                console.log('✅ Потвърждение изпратено');
            } catch (err) {
                console.error('Грешка при потвърждение:', err.message);
            }
        }
    } else if (lowerAnswer.includes('не')) {
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
    
    res.json({ success: true });
});

// Root
app.get('/', (req, res) => {
    res.json({
        name: 'Notifications Backend',
        version: '2.0.0',
        status: 'running',
        endpoints: ['/health', '/api/subscribe', '/api/ask', '/api/answer']
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
