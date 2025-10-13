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
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    
    req.on('end', async () => {
      try {
        const { 
          conversationId, 
          technicianName, 
          message,
          recipientId
        } = JSON.parse(body);

        if (!conversationId || !technicianName || !message || !recipientId) {
          return res.status(400).json({ 
            success: false, 
            message: 'All fields are required' 
          });
        }

        console.log(`📤 Checking FCM token for recipient: ${recipientId}`);

        // 1. Check if recipient has FCM token (mobile user)
        const tokenRef = db.ref(`user_tokens/${recipientId}`);
        const tokenSnapshot = await tokenRef.once('value');
        const tokenData = tokenSnapshot.val();
        
        if (!tokenData || !tokenData.fcmToken) {
          console.log(`📱 No FCM token found for recipient: ${recipientId} (likely web user)`);
          return res.status(200).json({ 
            success: true, 
            message: 'Recipient is web user - no push notification sent' 
          });
        }

        const recipientToken = tokenData.fcmToken;
        console.log(`✅ Found FCM token for mobile user: ${recipientId}`);

        // 2. Prepare FCM message
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
            conversationId: conversationId
          },
          android: {
            priority: 'high'
          }
        };

        // 3. Send via FCM
        const response = await admin.messaging().send(messagePayload);
        
        console.log(`✅ Push notification sent to mobile user: ${recipientId}`);
        console.log(`👨‍💻 From: ${technicianName}`);
        console.log(`💬 Message: ${message}`);
        console.log(`🎯 FCM Response: ${response}`);

        return res.status(200).json({
          success: true,
          message: 'Push notification sent successfully to mobile user',
          messageId: response
        });

      } catch (err) {
        console.error('❌ FCM Error:', err);
        
        // Remove invalid token
        if (err.code === 'messaging/registration-token-not-registered') {
          const { recipientId } = JSON.parse(body);
          await db.ref(`user_tokens/${recipientId}`).remove();
          console.log(`🗑️ Removed invalid FCM token for user: ${recipientId}`);
        }

        return res.status(500).json({ 
          success: false, 
          message: 'Failed to send push notification',
          error: err.message 
        });
      }
    });

  } catch (error) {
    console.error('❌ Server error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error', 
      error: error.message 
    });
  }
};