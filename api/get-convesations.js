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
    const { userId } = req.body;

    console.log('GET_CONVERSATIONS: Fetching data for user:', userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Get all approved technicians
    const techniciansSnapshot = await firestore.collection('technician')
      .where('status', '==', 'Approved')
      .get();

    const allTechnicians = [];
    
    // 🔥 NEW: Fetch profile images for each technician
    for (const doc of techniciansSnapshot.docs) {
      const techData = doc.data();
      const techId = techData.authUID || doc.id;
      
      let profileImageUrl = null;
      let profilePhotoPath = techData.profilePhoto || '';
      
      // If profilePhoto exists and points to Realtime DB, fetch the actual image
      if (profilePhotoPath && profilePhotoPath.startsWith('technician_images/')) {
        try {
          console.log(`🖼️ Fetching profile image for technician ${techId} from path: ${profilePhotoPath}`);
          
          const imageRef = db.ref(profilePhotoPath);
          const imageSnapshot = await imageRef.once('value');
          
          if (imageSnapshot.exists()) {
            const imageData = imageSnapshot.val();
            if (imageData.base64) {
              // Create data URL from base64 that Android can use directly
              profileImageUrl = `data:${imageData.imageType || 'image/jpeg'};base64,${imageData.base64}`;
              console.log(`✅ Successfully loaded profile image for ${techId}`);
            } else {
              console.log(`❌ No base64 data found for technician ${techId}`);
            }
          } else {
            console.log(`❌ No image data found at path: ${profilePhotoPath}`);
          }
        } catch (imageError) {
          console.warn(`⚠️ Failed to fetch profile image for technician ${techId}:`, imageError.message);
        }
      } else if (profilePhotoPath) {
        console.log(`ℹ️ Profile photo path for ${techId} is not a Realtime DB path: ${profilePhotoPath}`);
      }
      
      const technician = {
        id: doc.id,
        authUID: techId,
        firstName: techData.firstName || '',
        lastName: techData.lastName || '',
        department: techData.department || '',
        address: techData.address || '',
        profilePhoto: profileImageUrl, // Now contains actual image data URL or null
        profilePhotoPath: profilePhotoPath, // Keep original path for reference
        expertise: techData.expertise || '',
        role: techData.role || 'technician',
        status: techData.status || 'Approved'
      };
      allTechnicians.push(technician);
    }

    console.log('GET_CONVERSATIONS: Found', allTechnicians.length, 'approved technicians');

    // Get user's conversations
    const conversationsRef = db.ref('conversations');
    const conversationsSnapshot = await conversationsRef.once('value');
    
    const userConversations = [];
    const techniciansWithChats = [];

    if (conversationsSnapshot.exists()) {
      conversationsSnapshot.forEach(conversationSnapshot => {
        const conversation = conversationSnapshot.val();
        
        if (conversation.participants && conversation.participants.includes(userId)) {
          const otherParticipantId = conversation.participants.find(pid => pid !== userId);
          
          if (otherParticipantId) {
            // ✅ FIX: Only include conversations with actual messages
            const hasMessages = conversation.lastMessage && 
                              conversation.lastMessage.content &&
                              conversation.lastMessage.content.trim() !== '';
            
            if (!hasMessages) {
              console.log('GET_CONVERSATIONS: Skipping conversation - no messages');
              return;
            }

            const lastMessage = conversation.lastMessage.content;
            const lastMessageTime = conversation.lastMessageTime || conversation.updatedAt || 0;

            // Find technician details
            const technician = allTechnicians.find(t => t.authUID === otherParticipantId);
            if (technician) {
              const chatItem = {
                technicianId: otherParticipantId,
                technician: technician,
                lastMessage: lastMessage,
                lastMessageTime: lastMessageTime
              };
              userConversations.push(chatItem);
              techniciansWithChats.push({
                id: otherParticipantId,
                technician: technician
              });
            }
          }
        }
      });
    }

    // Sort conversations by last message time (most recent first)
    userConversations.sort((a, b) => b.lastMessageTime - a.lastMessageTime);

    // Log image loading statistics
    const techniciansWithImages = allTechnicians.filter(t => t.profilePhoto !== null).length;
    console.log(`🖼️ Image loading results: ${techniciansWithImages}/${allTechnicians.length} technicians have profile images`);

    console.log('GET_CONVERSATIONS: Found', userConversations.length, 'conversations with messages');

    return res.status(200).json({
      success: true,
      message: 'Data fetched successfully',
      data: {
        allTechnicians: allTechnicians,
        conversations: userConversations,
        techniciansWithChats: techniciansWithChats,
        imageStats: {
          totalTechnicians: allTechnicians.length,
          withProfileImages: techniciansWithImages
        }
      }
    });

  } catch (error) {
    console.error('GET_CONVERSATIONS Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};