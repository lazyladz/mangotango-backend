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

        // Get user's actual name first
        let userName = 'User';
        try {
          const userSnapshot = await db.ref(`users/${userId}`).once('value');
          if (userSnapshot.exists()) {
            const userData = userSnapshot.val();
            userName = userData.name || 'User';
            console.log('DEBUG_CONVERSATIONS: Found user name:', userName);
          } else {
            // Try Firestore as fallback (for technicians)
            const techSnapshot = await firestore.collection('technician')
              .where('authUID', '==', userId)
              .get();
            if (!techSnapshot.empty) {
              const techData = techSnapshot.docs[0].data();
              userName = `${techData.firstName || ''} ${techData.lastName || ''}`.trim() || 'User';
              console.log('DEBUG_CONVERSATIONS: Found technician name:', userName);
            }
          }
        } catch (nameError) {
          console.log('DEBUG_CONVERSATIONS: Error fetching user name:', nameError);
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
              
              // Get technician name from participantDetails or use fallback
              let technicianName = participantDetails.name || 'Technician';
              
              // If we don't have a proper name in participantDetails, try to get it
              if (technicianName === 'Technician' || !technicianName) {
                // You could add additional logic here to fetch from Firestore if needed
                console.log('DEBUG_CONVERSATIONS: Using fallback name for technician:', otherParticipantId);
              }

              conversations.push({
  conversationId: conversation.id,
  technicianId: otherParticipantId,
  technicianName: technicianName,
  // ADD THESE FIELDS FOR WEB USERS:
  userId: userId, // The app user's ID
  userName: actualUserName, // The app user's actual name
  lastMessage: conversation.lastMessage?.content || '',
  lastMessageTime: conversation.lastMessageTime || conversation.updatedAt || 0,
  unreadCount: 0,
  userRole: userRole
});
            }
          }
        });

        // Sort by last message time (most recent first)
        conversations.sort((a, b) => b.lastMessageTime - a.lastMessageTime);

        console.log('DEBUG_CONVERSATIONS: Found', conversations.length, 'conversations for user:', userName);

        return res.status(200).json({
          success: true,
          message: 'Conversations fetched successfully',
          userName: userName, // Return the actual user name
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