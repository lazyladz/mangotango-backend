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
  // Enable CORS
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
        const requestData = JSON.parse(body);
        const { conversationId, userId, technicianId } = requestData;

        console.log('DELETE_CONVERSATION: Received request -', { conversationId, userId, technicianId });

        // Validate required fields
        if (!conversationId || !userId) {
          return res.status(400).json({
            success: false,
            message: 'Conversation ID and User ID are required'
          });
        }

        // Verify the user is part of this conversation
        const conversationRef = db.ref(`conversations/${conversationId}`);
        const conversationSnapshot = await conversationRef.once('value');
        
        if (!conversationSnapshot.exists()) {
          return res.status(404).json({
            success: false,
            message: 'Conversation not found'
          });
        }

        const conversation = conversationSnapshot.val();
        
        // Check if user is a participant in this conversation
        if (!conversation.participants || !conversation.participants.includes(userId)) {
          return res.status(403).json({
            success: false,
            message: 'You are not authorized to delete this conversation'
          });
        }

        // Delete messages and conversation
        await deleteConversationData(conversationId);

        console.log('DELETE_CONVERSATION: Successfully deleted conversation:', conversationId);

        return res.status(200).json({
          success: true,
          message: 'Conversation deleted successfully',
          deletedConversationId: conversationId,
          deletedTechnicianId: technicianId
        });

      } catch (parseError) {
        console.error('DELETE_CONVERSATION: JSON parse error:', parseError);
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('DELETE_CONVERSATION Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Function to delete conversation data
async function deleteConversationData(conversationId) {
  try {
    // Delete messages
    const messagesRef = db.ref(`messages/${conversationId}`);
    await messagesRef.remove();
    
    console.log(`DELETE_CONVERSATION: Deleted messages for conversation: ${conversationId}`);

    // Delete conversation
    const conversationRef = db.ref(`conversations/${conversationId}`);
    await conversationRef.remove();
    
    console.log(`DELETE_CONVERSATION: Deleted conversation: ${conversationId}`);

    return true;
  } catch (error) {
    console.error('DELETE_CONVERSATION: Error deleting data:', error);
    throw error;
  }
}