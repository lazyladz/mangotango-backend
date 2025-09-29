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
const firestore = admin.firestore(); // Add this line

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
        const { 
          conversationId, 
          senderId, 
          senderName, 
          content, 
          technicianId,
          userId 
        } = JSON.parse(body);

        console.log('DEBUG_SEND_MESSAGE: Sending message for conversation:', conversationId);
        console.log('DEBUG_SEND_MESSAGE: senderName received:', senderName); // ADD THIS

        if (!conversationId || !senderId || !content) {
          return res.status(400).json({
            success: false,
            message: 'Conversation ID, sender ID, and content are required'
          });
        }

        // 🔥 CRITICAL FIX: Get actual user name from database if senderName is "User"
        let actualSenderName = senderName;
        if (!actualSenderName || actualSenderName === 'User') {
          console.log('DEBUG_SEND_MESSAGE: senderName is "User", fetching actual name from database');
          try {
            const userSnapshot = await db.ref(`users/${senderId}`).once('value');
            if (userSnapshot.exists()) {
              const userData = userSnapshot.val();
              actualSenderName = userData.name || senderName;
              console.log('DEBUG_SEND_MESSAGE: Found actual name:', actualSenderName);
            }
          } catch (error) {
            console.log('DEBUG_SEND_MESSAGE: Error fetching user name:', error);
          }
        }

        const messagesRef = db.ref(`messages/${conversationId}`);
        const newMessageRef = messagesRef.push();
        const messageId = newMessageRef.key;

        const messageData = {
          id: messageId,
          content: content,
          senderId: senderId,
          senderName: actualSenderName, // 🔥 Use the validated name, NOT "User"
          senderAvatar: "/profilepic.jpg",
          timestamp: Date.now(),
          status: "sent",
          readBy: { [senderId]: true }
        };

        // Update conversation last message
        const conversationRef = db.ref(`conversations/${conversationId}`);
        const conversationUpdate = {
          lastMessage: {
            content: content,
            senderId: senderId,
            senderName: actualSenderName, // 🔥 Use the validated name
            timestamp: Date.now()
          },
          lastMessageTime: Date.now(),
          updatedAt: Date.now()
        };

        // If conversation doesn't exist, create it
        const conversationSnapshot = await conversationRef.once('value');
        if (!conversationSnapshot.exists()) {
          const participants = [userId, technicianId].sort();
          
          let actualUserName = actualSenderName; // Use the validated name
          let actualTechName = "Technician";
          
          try {
            // Get technician's actual name from Firestore
            const techSnapshot = await firestore.collection('technician')
              .where('authUID', '==', technicianId)
              .get();
            if (!techSnapshot.empty) {
              const techData = techSnapshot.docs[0].data();
              actualTechName = `${techData.firstName || ''} ${techData.lastName || ''}`.trim() || "Technician";
              console.log('DEBUG_SEND_MESSAGE: Found technician name:', actualTechName);
            }
          } catch (error) {
            console.log('DEBUG_SEND_MESSAGE: Error fetching technician name:', error);
          }

          const participantDetails = {
            [userId]: {
              name: actualUserName, // App user's REAL name
              avatar: "/profilepic.jpg",
              role: "User", 
              id: userId
            },
            [technicianId]: {
              name: actualTechName, // Technician's real name
              avatar: "/profilepic.jpg", 
              role: "Technician",
              id: technicianId
            }
          };

          await conversationRef.set({
            id: conversationId,
            participants: participants,
            participantDetails: participantDetails,
            lastMessage: conversationUpdate.lastMessage,
            lastMessageTime: conversationUpdate.lastMessageTime,
            createdAt: Date.now(),
            updatedAt: Date.now()
          });
        } else {
          // Conversation exists, just update last message
          await conversationRef.update(conversationUpdate);
        }

        // Save the message
        await newMessageRef.set(messageData);

        console.log('DEBUG_SEND_MESSAGE: Message sent successfully with name:', actualSenderName);

        return res.status(200).json({
          success: true,
          message: 'Message sent successfully',
          messageId: messageId,
          timestamp: messageData.timestamp
        });

      } catch (parseError) {
        console.error('DEBUG_SEND_MESSAGE: JSON parse error:', parseError);
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('Send message error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};