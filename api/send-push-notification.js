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
          farmerId, 
          technicianName, 
          message, 
          conversationId 
        } = JSON.parse(body);

        if (!farmerId || !technicianName || !message) {
          return res.status(400).json({ 
            success: false, 
            message: 'Farmer ID, technician name, and message are required' 
          });
        }

        console.log(`📤 Sending push to farmer: ${farmerId}`);

        // 1. Get farmer's FCM token from database
        const tokenRef = db.ref(`user_tokens/${farmerId}`);
        const tokenSnapshot = await tokenRef.once('value');
        const tokenData = tokenSnapshot.val();
        
        if (!tokenData || !tokenData.fcmToken) {
          return res.status(404).json({ 
            success: false, 
            message: 'Farmer FCM token not found' 
          });
        }

        const farmerToken = tokenData.fcmToken;

        // 2. Prepare FCM message
        const messagePayload = {
          token: farmerToken,
          notification: {
            title: `💬 ${technicianName}`,
            body: message
          },
          data: {
            type: 'message',
            technicianName: technicianName,
            message: message,
            conversationId: conversationId || ''
          },
          android: {
            priority: 'high'
          }
        };

        // 3. Send via FCM
        const response = await admin.messaging().send(messagePayload);
        
        console.log(`✅ Push sent to farmer: ${farmerId}`);
        console.log(`👨‍💼 From: ${technicianName}`);
        console.log(`💬 Message: ${message}`);

        return res.status(200).json({
          success: true,
          message: 'Push notification sent successfully',
          messageId: response
        });

      } catch (err) {
        console.error('FCM Error:', err);
        
        // Remove invalid token
        if (err.code === 'messaging/registration-token-not-registered') {
          const { farmerId } = JSON.parse(body);
          await db.ref(`user_tokens/${farmerId}`).remove();
          console.log(`🗑️ Removed invalid token for: ${farmerId}`);
        }

        return res.status(500).json({ 
          success: false, 
          message: 'Failed to send push notification',
          error: err.message 
        });
      }
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error', 
      error: error.message 
    });
  }
};