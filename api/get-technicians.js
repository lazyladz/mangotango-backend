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

  if (req.method === 'GET') {
    try {
      console.log('DEBUG_TECHNICIANS: Fetching approved technicians');

      // Get approved technicians from Firestore
      const techniciansSnapshot = await firestore.collection('technician')
        .where('status', '==', 'Approved')
        .get();

      const technicians = [];
      
      techniciansSnapshot.forEach(doc => {
        const techData = doc.data();
        technicians.push({
          id: doc.id,
          authUID: techData.authUID,
          firstName: techData.firstName,
          lastName: techData.lastName,
          fullName: `${techData.firstName || ''} ${techData.lastName || ''}`.trim(),
          department: techData.department,
          address: techData.address,
          deptAddress: [techData.department, techData.address].filter(Boolean).join(' '),
          profilePhoto: techData.profilePhoto,
          expertise: techData.expertise,
          role: techData.role
        });
      });

      console.log('DEBUG_TECHNICIANS: Found', technicians.length, 'technicians');

      return res.status(200).json({
        success: true,
        message: 'Technicians fetched successfully',
        technicians: technicians
      });

    } catch (error) {
      console.error('Get technicians error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
};