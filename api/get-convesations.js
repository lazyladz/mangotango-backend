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
const firestore = admin.firestore();

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
        const { userId } = JSON.parse(body);

        console.log('DEBUG_CONVERSATIONS: Fetching conversations for user:', userId);

        if (!userId) {
          return res.status(400).json({
            success: false,
            message: 'User ID is required'
          });
        }

        // Get conversations from Realtime Database
        const conversationsRef = db.ref('conversations');
        const snapshot = await conversationsRef.orderByChild('participants').once('value');
        
        const conversations = [];
        
        snapshot.forEach((conversationSnapshot) => {
          const conversation = conversationSnapshot.val();
          
          // Check if user is participant in this conversation
          if (conversation.participants && conversation.participants.includes(userId)) {
            // Find the other participant (technician)
            const otherParticipantId = conversation.participants.find(pid => pid !== userId);
            
            if (otherParticipantId) {
              const participantDetails = conversation.participantDetails?.[otherParticipantId] || {};
              
              conversations.push({
                conversationId: conversation.id,
                technicianId: otherParticipantId,
                technicianName: participantDetails.name || 'Technician',
                lastMessage: conversation.lastMessage?.content || '',
                lastMessageTime: conversation.lastMessageTime || conversation.updatedAt || 0,
                unreadCount: 0 // You can implement this later
              });
            }
          }
        });

        // Sort by last message time (most recent first)
        conversations.sort((a, b) => b.lastMessageTime - a.lastMessageTime);

        console.log('DEBUG_CONVERSATIONS: Found', conversations.length, 'conversations');

        return res.status(200).json({
          success: true,
          message: 'Conversations fetched successfully',
          conversations: conversations
        });

      } catch (parseError) {
        console.error('DEBUG_CONVERSATIONS: JSON parse error:', parseError);
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('Get conversations error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};