const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.database();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { 
      conversationId, 
      technicianName, 
      message,
      recipientId,
      senderId 
    } = req.body;

    if (!conversationId || !technicianName || !message || !recipientId) {
      return res.status(400).json({ 
        success: false, 
        message: 'All fields are required: conversationId, technicianName, message, recipientId' 
      });
    }

    console.log(`📤 Sending FCM to: ${recipientId}`);
    console.log(`👨‍💻 From: ${technicianName}`);
    console.log(`💬 Message: ${message.substring(0, 50)}...`);

    // 1. Get recipient's FCM token
    const tokenRef = db.ref(`user_tokens/${recipientId}`);
    const tokenSnapshot = await tokenRef.once('value');
    const tokenData = tokenSnapshot.val();
    
    if (!tokenData || !tokenData.fcmToken) {
      console.log(`📱 No FCM token found for recipient: ${recipientId}`);
      return res.status(404).json({ 
        success: false, 
        message: 'Recipient FCM token not found' 
      });
    }

    const recipientToken = tokenData.fcmToken;
    console.log(`✅ Found FCM token for: ${recipientId}`);

    // 2. Prepare FCM message (FIXED VERSION)
    const messagePayload = {
      token: recipientToken,
      notification: {
        title: `💬 ${technicianName}`,
        body: message
      },
      data: {
        type: 'message',
        technicianName: technicianName,
        message: message,
        conversationId: conversationId,
        senderId: senderId || 'unknown'
      },
      android: {
        priority: 'high'
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: `💬 ${technicianName}`,
              body: message
            },
            sound: 'default',
            badge: 1
          }
        }
      }
    };

    // 3. Send via FCM
    const response = await admin.messaging().send(messagePayload);
    
    console.log(`✅ Push notification sent successfully`);
    console.log(`🎯 FCM Message ID: ${response}`);

    return res.status(200).json({
      success: true,
      message: 'Push notification sent successfully',
      messageId: response,
      recipientId: recipientId
    });

  } catch (error) {
    console.error('❌ FCM Error:', error);
    
    // Remove invalid token
    if (error.code === 'messaging/registration-token-not-registered') {
      const { recipientId } = req.body;
      await db.ref(`user_tokens/${recipientId}`).remove();
      console.log(`🗑️ Removed invalid FCM token for user: ${recipientId}`);
    }

    return res.status(500).json({ 
      success: false, 
      message: 'Failed to send push notification',
      error: error.message 
    });
  }
};