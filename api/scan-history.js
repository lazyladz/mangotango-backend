const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// Initialize Firebase Admin if not already initialized
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
        req.on('data', chunk => { body += chunk.toString(); });
        
        req.on('end', async () => {
            try {
                const requestData = JSON.parse(body);
                const { action } = requestData;

                console.log('📱 Scan History API - Action:', action);

                if (!action) {
                    return res.status(400).json({
                        success: false,
                        message: 'Action is required (get_recommendations, save_history, or get_history)'
                    });
                }

                switch (action) {
                    case 'get_recommendations':
                        await handleGetRecommendations(requestData, res);
                        break;
                    
                    case 'save_history':
                        await handleSaveHistory(requestData, res);
                        break;
                    
                    case 'get_history':
                        await handleGetHistory(requestData, res);
                        break;
                    
                    default:
                        return res.status(400).json({
                            success: false,
                            message: 'Invalid action. Supported: get_recommendations, save_history, get_history'
                        });
                }

            } catch (parseError) {
                console.error('JSON parse error:', parseError);
                return res.status(400).json({
                    success: false,
                    message: 'Invalid JSON in request body'
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

// Handle getting AI recommendations
async function handleGetRecommendations(requestData, res) {
    try {
        const { diseaseName, confidence } = requestData;

        if (!diseaseName) {
            return res.status(400).json({
                success: false,
                message: 'diseaseName is required'
            });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({
                success: false,
                message: 'Gemini API key not configured'
            });
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });

        const prompt = `
        You are an agricultural expert specializing in mango cultivation.
        Provide practical, actionable advice for "${diseaseName}" in mango crops.

        Please structure your response with clear sections using these exact headers:
        CAUSE:
        SYMPTOMS: 
        TREATMENT:
        PREVENTION:

        For each section:
        - Use bullet points for lists
        - Be concise and practical
        - Focus on immediate actionable steps
        - Include both organic and chemical options where applicable

        CAUSE: Provide a brief 1-2 sentence explanation of what causes this disease.

        SYMPTOMS: List the key visible symptoms farmers should look for.

        TREATMENT: Provide step-by-step practical solutions including both organic and chemical options.

        PREVENTION: Suggest long-term prevention strategies.

        Maximum 300 words.
        Do not use any asterisks, markdown, or special formatting characters.
        Use bullet points with dashes (-) for lists.
        `;

        console.log(`🔄 Getting AI recommendations for: ${diseaseName}`);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const recommendations = response.text();

        console.log('✅ Recommendations generated successfully');

        return res.json({
            success: true,
            action: 'get_recommendations',
            disease: diseaseName,
            confidence: confidence || 0,
            recommendations: recommendations,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Recommendations error:', error);
        return res.status(500).json({
            success: false,
            action: 'get_recommendations',
            message: 'Failed to get recommendations',
            error: error.message
        });
    }
}

// Handle saving scan history
async function handleSaveHistory(requestData, res) {
    try {
        const { 
            userId, 
            diseaseName, 
            recommendations, 
            confidence, 
            imageUri,
            cause = "AI Analysis"
        } = requestData;

        // Validate required fields
        if (!userId || !diseaseName) {
            return res.status(400).json({
                success: false,
                message: 'userId and diseaseName are required'
            });
        }

        console.log(`💾 Saving scan history for user: ${userId}`);

        // Generate unique ID and timestamp
        const historyId = db.ref().child('history').push().key;
        const date = new Date().toISOString();
        const timestamp = Date.now();

        const historyItem = {
            id: historyId,
            diseaseName: diseaseName,
            recommendation: recommendations || '',
            date: date,
            timestamp: timestamp,
            confidence: confidence || 0,
            imageUri: imageUri || '',
            cause: cause,
            userId: userId
        };

        // Save to Firebase
        await db.ref(`history/${userId}/${historyId}`).set(historyItem);

        console.log('✅ Scan history saved successfully');

        return res.json({
            success: true,
            action: 'save_history',
            message: 'Scan history saved successfully',
            historyId: historyId,
            timestamp: date
        });

    } catch (error) {
        console.error('Save history error:', error);
        return res.status(500).json({
            success: false,
            action: 'save_history',
            message: 'Failed to save scan history',
            error: error.message
        });
    }
}

// Handle getting scan history
async function handleGetHistory(requestData, res) {
    try {
        const { userId } = requestData;

        // Validate required fields
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'userId is required'
            });
        }

        console.log(`📱 Fetching history for user: ${userId}`);

        // Get user's scan history from Firebase
        const historyRef = db.ref(`history/${userId}`);
        const snapshot = await historyRef.orderByChild('timestamp').once('value');
        
        const history = [];
        snapshot.forEach((childSnapshot) => {
            const scanData = childSnapshot.val();
            if (scanData) {
                history.push({
                    diseaseName: scanData.diseaseName || '',
                    recommendation: scanData.recommendation || '',
                    date: scanData.date || '',
                    confidence: scanData.confidence || 0,
                    imageUri: scanData.imageUri || ''
                });
            }
        });

        // Sort by timestamp (newest first)
        history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        console.log(`✅ Found ${history.length} history items for user: ${userId}`);

        return res.json({
            success: true,
            action: 'get_history',
            message: 'History fetched successfully',
            history: history,
            count: history.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Get history error:', error);
        return res.status(500).json({
            success: false,
            action: 'get_history',
            message: 'Failed to fetch history',
            error: error.message
        });
    }
}