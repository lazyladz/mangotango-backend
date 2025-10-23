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

// Helper function to extract technicianId from conversationId
function extractTechnicianIdFromConversation(conversationId, senderId) {
  if (!conversationId || !senderId) return '';
  
  console.log(`🔄 Extracting technicianId from conversation: ${conversationId}, sender: ${senderId}`);
  
  const parts = conversationId.split('_');
  if (parts.length === 2) {
    // Return the part that is NOT the sender
    const technicianId = parts[0] === senderId ? parts[1] : parts[0];
    console.log(`✅ Extracted technicianId: ${technicianId}`);
    return technicianId;
  }
  
  console.log('❌ Could not extract technicianId from conversation');
  return '';
}

module.exports = async (req, res) => {
  // 🔥 COMPLETE CORS HEADERS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
  
  // Handle preflight requests
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
      senderId,
      technicianId  // This might be undefined initially
    } = req.body;

    // ✅ ADD DEBUG LOGGING HERE
    console.log('📨 PUSH NOTIFICATION REQUEST RECEIVED:');
    console.log('   - conversationId:', conversationId);
    console.log('   - technicianName:', technicianName);
    console.log('   - technicianId (from request):', technicianId);
    console.log('   - message:', message);
    console.log('   - recipientId:', recipientId);
    console.log('   - senderId:', senderId);

    if (!conversationId || !technicianName || !message || !recipientId) {
      return res.status(400).json({ 
        success: false, 
        message: 'All fields are required: conversationId, technicianName, message, recipientId' 
      });
    }

    // ✅ FIX: Extract technicianId if not provided
    const finalTechnicianId = technicianId || extractTechnicianIdFromConversation(conversationId, senderId);
    
    console.log(`📤 Sending FCM to: ${recipientId}`);
    console.log(`👨‍💻 From: ${technicianName}`);
    console.log(`🆔 Using technicianId: ${finalTechnicianId}`);
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
        technicianId: finalTechnicianId, // ✅ Now this will always have a value
        conversationId: conversationId,
        message: message,
        senderId: senderId || 'unknown',
        from_fcm: 'true'
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

    // ✅ ADD DEBUG LOGGING BEFORE SENDING FCM
    console.log('🚀 SENDING FCM MESSAGE:');
    console.log('   - Token:', recipientToken ? `${recipientToken.substring(0, 20)}...` : 'MISSING');
    console.log('   - FCM Payload:', JSON.stringify(messagePayload, null, 2));

    // 3. Send via FCM
    const response = await admin.messaging().send(messagePayload);
    
    console.log(`✅ Push notification sent successfully`);
    console.log(`🎯 FCM Message ID: ${response}`);

    return res.status(200).json({
      success: true,
      message: 'Push notification sent successfully',
      messageId: response,
      recipientId: recipientId,
      technicianId: finalTechnicianId
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