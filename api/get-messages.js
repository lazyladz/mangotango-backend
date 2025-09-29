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
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const { conversationId } = JSON.parse(body);

        console.log('DEBUG_MESSAGES: Fetching messages for conversation:', conversationId);

        if (!conversationId) {
          return res.status(400).json({
            success: false,
            message: 'Conversation ID is required'
          });
        }

        // Get messages from Realtime Database
        const messagesRef = db.ref(`messages/${conversationId}`);
        const snapshot = await messagesRef.orderByChild('timestamp').once('value');
        
        const messages = [];
        
        snapshot.forEach((messageSnapshot) => {
          const message = messageSnapshot.val();
          messages.push({
            id: message.id,
            content: message.content,
            senderId: message.senderId,
            senderName: message.senderName,
            timestamp: message.timestamp,
            status: message.status,
            readBy: message.readBy || {}
          });
        });

        console.log('DEBUG_MESSAGES: Found', messages.length, 'messages');

        return res.status(200).json({
          success: true,
          message: 'Messages fetched successfully',
          messages: messages
        });

      } catch (parseError) {
        console.error('DEBUG_MESSAGES: JSON parse error:', parseError);
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('Get messages error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};