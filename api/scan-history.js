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
                        message: 'Action is required (save_history, get_history, get_monthly_analytics, or delete_history)'
                    });
                }

                switch (action) {
                    case 'save_history':
                        await handleSaveHistory(requestData, res);
                        break;
                    
                    case 'get_history':
                        await handleGetHistory(requestData, res);
                        break;
                    
                    case 'get_monthly_analytics':
                        await handleGetMonthlyAnalytics(requestData, res);
                        break;
                    
                    case 'delete_history':
                        await handleDeleteHistory(requestData, res);
                        break;
                    
                    default:
                        return res.status(400).json({
                            success: false,
                            message: 'Invalid action. Supported: save_history, get_history, get_monthly_analytics, delete_history'
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

// Handle getting scan history with optional filtering
async function handleGetHistory(requestData, res) {
    try {
        const { userId, limit, offset, diseaseFilter } = requestData;

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
        
        let history = [];
        snapshot.forEach((childSnapshot) => {
            const scanData = childSnapshot.val();
            if (scanData) {
                history.push({
                    id: scanData.id || childSnapshot.key,
                    diseaseName: scanData.diseaseName || '',
                    recommendation: scanData.recommendation || '',
                    date: scanData.date || '',
                    timestamp: scanData.timestamp || 0,
                    confidence: scanData.confidence || 0,
                    imageUri: scanData.imageUri || '',
                    cause: scanData.cause || 'AI Analysis',
                    userId: scanData.userId || userId
                });
            }
        });

        // Sort by timestamp (newest first)
        history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        // Apply filters if provided
        if (diseaseFilter) {
            history = history.filter(scan => 
                scan.diseaseName.toLowerCase().includes(diseaseFilter.toLowerCase())
            );
        }

        // Apply pagination if provided
        const startIndex = offset || 0;
        const endIndex = limit ? startIndex + limit : history.length;
        const paginatedHistory = history.slice(startIndex, endIndex);

        console.log(`✅ Found ${history.length} history items for user: ${userId}`);

        return res.json({
            success: true,
            action: 'get_history',
            message: 'History fetched successfully',
            history: paginatedHistory,
            totalCount: history.length,
            hasMore: endIndex < history.length,
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

// Handle getting monthly analytics data
async function handleGetMonthlyAnalytics(requestData, res) {
    try {
        const { userId, monthKey, year } = requestData;

        // Validate required fields
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'userId is required'
            });
        }

        console.log(`📊 Getting monthly analytics for user: ${userId}, month: ${monthKey}`);

        // Get user's scan history from Firebase
        const historyRef = db.ref(`history/${userId}`);
        const snapshot = await historyRef.orderByChild('timestamp').once('value');
        
        const history = [];
        snapshot.forEach((childSnapshot) => {
            const scanData = childSnapshot.val();
            if (scanData) {
                history.push({
                    diseaseName: scanData.diseaseName || '',
                    date: scanData.date || '',
                    timestamp: scanData.timestamp || 0,
                    confidence: scanData.confidence || 0
                });
            }
        });

        // Filter by month if specified
        let filteredHistory = history;
        if (monthKey) {
            filteredHistory = history.filter(scan => {
                try {
                    const scanDate = new Date(scan.timestamp);
                    const scanMonthKey = `${scanDate.getFullYear()}-${String(scanDate.getMonth() + 1).padStart(2, '0')}`;
                    return scanMonthKey === monthKey;
                } catch (e) {
                    return false;
                }
            });
        } else if (year) {
            filteredHistory = history.filter(scan => {
                try {
                    const scanDate = new Date(scan.timestamp);
                    return scanDate.getFullYear() === parseInt(year);
                } catch (e) {
                    return false;
                }
            });
        }

        // Calculate analytics
        const totalScans = filteredHistory.length;
        
        // Disease frequency
        const diseaseCount = {};
        filteredHistory.forEach(scan => {
            const disease = scan.diseaseName || 'Unknown';
            diseaseCount[disease] = (diseaseCount[disease] || 0) + 1;
        });

        // Most common disease
        const mostCommonDisease = Object.entries(diseaseCount)
            .sort((a, b) => b[1] - a[1])[0] || ['None', 0];

        // Average confidence
        const avgConfidence = filteredHistory.length > 0 
            ? filteredHistory.reduce((sum, scan) => sum + (scan.confidence || 0), 0) / filteredHistory.length
            : 0;

        // Monthly breakdown
        const monthlyBreakdown = {};
        history.forEach(scan => {
            try {
                const scanDate = new Date(scan.timestamp);
                const monthKey = `${scanDate.getFullYear()}-${String(scanDate.getMonth() + 1).padStart(2, '0')}`;
                const monthName = scanDate.toLocaleString('default', { month: 'long', year: 'numeric' });
                
                if (!monthlyBreakdown[monthKey]) {
                    monthlyBreakdown[monthKey] = {
                        monthKey,
                        monthName,
                        totalScans: 0,
                        diseases: {}
                    };
                }
                
                monthlyBreakdown[monthKey].totalScans++;
                const disease = scan.diseaseName || 'Unknown';
                monthlyBreakdown[monthKey].diseases[disease] = (monthlyBreakdown[monthKey].diseases[disease] || 0) + 1;
            } catch (e) {
                // Skip invalid dates
            }
        });

        // Convert to array and sort
        const monthlyData = Object.values(monthlyBreakdown)
            .map(month => ({
                ...month,
                mostCommonDisease: {
                    name: Object.entries(month.diseases).sort((a, b) => b[1] - a[1])[0]?.[0] || 'None',
                    count: Object.entries(month.diseases).sort((a, b) => b[1] - a[1])[0]?.[1] || 0
                }
            }))
            .sort((a, b) => b.monthKey.localeCompare(a.monthKey));

        console.log(`✅ Analytics generated: ${totalScans} scans analyzed`);

        return res.json({
            success: true,
            action: 'get_monthly_analytics',
            message: 'Analytics generated successfully',
            analytics: {
                totalScans,
                diseaseDistribution: diseaseCount,
                mostCommonDisease: {
                    name: mostCommonDisease[0],
                    count: mostCommonDisease[1]
                },
                averageConfidence: Math.round(avgConfidence * 10) / 10,
                monthlyBreakdown: monthlyData,
                filteredCount: filteredHistory.length
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Monthly analytics error:', error);
        return res.status(500).json({
            success: false,
            action: 'get_monthly_analytics',
            message: 'Failed to generate analytics',
            error: error.message
        });
    }
}

// Handle deleting scan history
async function handleDeleteHistory(requestData, res) {
    try {
        const { userId, historyId } = requestData;

        // Validate required fields
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'userId is required'
            });
        }

        if (!historyId) {
            return res.status(400).json({
                success: false,
                message: 'historyId is required'
            });
        }

        console.log(`🗑️ Deleting history item: ${historyId} for user: ${userId}`);

        // Delete from Firebase
        await db.ref(`history/${userId}/${historyId}`).remove();

        console.log('✅ History item deleted successfully');

        return res.json({
            success: true,
            action: 'delete_history',
            message: 'History item deleted successfully',
            deletedId: historyId,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Delete history error:', error);
        return res.status(500).json({
            success: false,
            action: 'delete_history',
            message: 'Failed to delete history item',
            error: error.message
        });
    }
}