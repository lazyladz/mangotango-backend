// weather-cron.js - COMPLETE RECODE FOR VERCEL CRON JOBS
// Updated: ${new Date().toISOString()}

const admin = require('firebase-admin');
const axios = require('axios');

// Initialize Firebase Admin
function initializeFirebase() {
    if (!admin.apps.length) {
        console.log('🔥 Initializing Firebase Admin...');
        try {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
                }),
                databaseURL: process.env.FIREBASE_DATABASE_URL
            });
            console.log('✅ Firebase Admin initialized successfully');
        } catch (error) {
            console.error('❌ Firebase Admin initialization failed:', error.message);
            throw error;
        }
    }
    return admin.database();
}

// Initialize Firebase
const db = initializeFirebase();

// ==================== HELPER FUNCTIONS ====================

/**
 * Get pest alerts based on weather conditions
 */
function getPestAlerts(temp, condition, humidity, windSpeed) {
    const pests = [];
    
    // Mango-specific pests
    if (temp > 28 && condition === 'Sunny') pests.push('Mango hopper');
    if (temp > 25 && condition === 'Cloudy') pests.push('Mealybug');
    if (temp >= 22 && temp <= 30 && condition === 'Rainy') pests.push('Cecid Fly');
    if (condition === 'Rainy') pests.push('Anthracnose');
    if (temp > 30) pests.push('Leaf Hopper');
    
    // General farm pests
    if (condition === 'Rainy' && temp > 25) pests.push('Fungal diseases');
    if (condition === 'Sunny' && temp > 32) pests.push('Heat stress');
    if (humidity > 85) pests.push('Powdery mildew risk');
    if (windSpeed > 5) pests.push('Wind may spread pests');
    
    return pests;
}

/**
 * Get farming advice based on weather conditions
 */
function getFarmingAdvice(temp, condition, humidity, windSpeed) {
    const advice = [];
    
    if (condition === 'Rainy') advice.push('Avoid field work.');
    if (condition === 'Stormy') advice.push('Secure farm equipment.');
    if (temp > 30) advice.push('Water plants early morning.');
    if (temp < 20) advice.push('Protect sensitive plants.');
    if (humidity > 85) advice.push('Monitor for fungal diseases.');
    if (windSpeed > 6) advice.push('Check for wind damage.');
    
    return advice.length > 0 ? advice.join(' ') : 'Normal farming activities.';
}

/**
 * Fetch weather data from OpenWeatherMap API
 */
async function fetchWeatherForCity(city) {
    try {
        const WEATHER_API_KEY = process.env.WEATHER_API_KEY || 'fbc049c0ab6883e70eb66f800322b567';
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)},PH&appid=${WEATHER_API_KEY}&units=metric`;
        
        console.log(`🌤️ Fetching weather for: ${city}`);
        const response = await axios.get(url, { timeout: 10000 });
        
        const data = response.data;
        const temp = Math.round(data.main.temp);
        const condition = data.weather[0].main;
        const humidity = data.main.humidity;
        const windSpeed = data.wind.speed;
        
        // Normalize condition
        const normalizedCondition = condition.includes('Rain') ? 'Rainy' : 
                                  condition.includes('Cloud') ? 'Cloudy' : 
                                  condition.includes('Thunderstorm') ? 'Stormy' : 'Sunny';
        
        const pests = getPestAlerts(temp, normalizedCondition, humidity, windSpeed);
        
        return {
            city,
            temp,
            condition: normalizedCondition,
            humidity,
            windSpeed: Math.round(windSpeed * 10) / 10,
            pests,
            timestamp: new Date().toISOString(),
            fetchedAt: new Date().toLocaleTimeString('en-PH', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Manila'
            }),
            originalCondition: condition
        };
        
    } catch (error) {
        console.error(`❌ Error fetching weather for ${city}:`, error.message);
        return null;
    }
}

/**
 * Send weather notification to user via FCM
 */
async function sendWeatherNotificationToUser(userId, city, weatherData, isTest = false) {
    try {
        console.log(`🌤️ Sending weather notification to user: ${userId} for ${city} (Test: ${isTest})`);
        
        // Get user's FCM token
        const tokenRef = db.ref(`user_tokens/${userId}`);
        const tokenSnapshot = await tokenRef.once('value');
        const tokenData = tokenSnapshot.val();
        
        if (!tokenData || !tokenData.fcmToken) {
            console.log(`❌ No FCM token for user: ${userId}`);
            return false;
        }
        
        const { temp, condition, humidity, windSpeed, pests, fetchedAt } = weatherData;
        
        // Create notification message
        const title = isTest 
            ? `🧪 Weather Test: ${city}` 
            : `🌤️ Weather Update: ${city}`;
        
        const weatherMessage = `🌡️ ${temp}°C | ${condition}\n💧 ${humidity}% | 💨 ${windSpeed}m/s\n⏰ ${fetchedAt}`;
        
        const pestMessage = pests.length > 0 
            ? `\n\n⚠️ Pest Alert:\n${pests.map(p => `• ${p}`).join('\n')}`
            : '\n\n✅ No major pest threats';
        
        const advice = getFarmingAdvice(temp, condition, humidity, windSpeed);
        const fullMessage = `${weatherMessage}${pestMessage}\n\n💡 ${advice}`;
        
        // Prepare FCM message
        const messagePayload = {
            token: tokenData.fcmToken,
            notification: {
                title: title,
                body: `${temp}°C | ${condition}`,
                sound: 'default'
            },
            data: {
                type: 'weather',
                city: city,
                temperature: temp.toString(),
                condition: condition,
                humidity: humidity.toString(),
                wind_speed: windSpeed.toString(),
                pests: JSON.stringify(pests),
                timestamp: new Date().toISOString(),
                message: fullMessage,
                test: isTest.toString(),
                source: 'weather-cron'
            },
            android: {
                priority: 'high',
                notification: {
                    channelId: 'weather_alerts',
                    sound: 'default',
                    icon: 'ic_notification',
                    color: '#4CAF50'
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1,
                        category: 'WEATHER_ALERT'
                    }
                }
            },
            webpush: {
                headers: {
                    Urgency: 'high'
                }
            }
        };
        
        console.log(`🚀 Sending FCM to ${userId} for ${city}`);
        const response = await admin.messaging().send(messagePayload);
        console.log(`✅ Weather notification sent to ${userId}:`, response);
        
        return true;
        
    } catch (error) {
        console.error(`❌ Error sending weather notification to ${userId}:`, error.message);
        
        // Remove invalid token
        if (error.code === 'messaging/registration-token-not-registered' || 
            error.code === 'messaging/invalid-registration-token') {
            await db.ref(`user_tokens/${userId}`).remove();
            console.log(`🗑️ Removed invalid FCM token for user: ${userId}`);
        }
        
        return false;
    }
}

// ==================== MAIN FUNCTIONS ====================

/**
 * Manual test endpoint
 */
async function handleManualTest(userId, city = 'Manila') {
    console.log('🧪 MANUAL WEATHER TEST REQUESTED');
    console.log(`User: ${userId}, City: ${city}`);
    
    const weatherData = await fetchWeatherForCity(city);
    
    if (!weatherData) {
        throw new Error(`Failed to fetch weather for ${city}`);
    }
    
    const success = await sendWeatherNotificationToUser(userId, city, weatherData, true);
    
    return {
        success,
        city,
        weather: weatherData,
        message: success ? 'Test notification sent successfully' : 'Failed to send test notification',
        timestamp: new Date().toISOString()
    };
}

/**
 * Cron job function - runs every 5 minutes
 */
async function handleCronJob() {
    console.log('⏰ CRON JOB TRIGGERED:', new Date().toISOString());
    console.log('📍 Timezone: Asia/Manila');
    
    try {
        // Get all users with their preferred cities
        const usersRef = db.ref('users');
        const usersSnapshot = await usersRef.once('value');
        const users = usersSnapshot.val();
        
        if (!users) {
            console.log('❌ Cron job: No users found in database');
            return { 
                success: false, 
                error: 'No users found',
                timestamp: new Date().toISOString()
            };
        }
        
        const userCount = Object.keys(users).length;
        console.log(`📢 Cron job: Found ${userCount} users`);
        
        let successCount = 0;
        let failCount = 0;
        const results = [];
        const errors = [];
        
        // Process each user
        for (const [userId, userData] of Object.entries(users)) {
            try {
                if (!userData) {
                    console.log(`  ⚠️ Skipping user ${userId}: No user data`);
                    continue;
                }
                
                // Get user's preferred city, default to Manila
                const userCity = userData.preferredCity || 'Manila';
                
                console.log(`  👤 Processing: ${userId.substring(0, 8)}..., City: ${userCity}`);
                
                // Fetch weather for user's city
                const weatherData = await fetchWeatherForCity(userCity);
                
                if (!weatherData) {
                    console.log(`  ❌ Failed to fetch weather for ${userCity}`);
                    failCount++;
                    errors.push({ userId, city: userCity, error: 'Weather API failed' });
                    continue;
                }
                
                // Send notification
                const success = await sendWeatherNotificationToUser(userId, userCity, weatherData, false);
                
                if (success) {
                    successCount++;
                    results.push({ 
                        userId: userId.substring(0, 8) + '...', 
                        city: userCity, 
                        success: true,
                        temp: weatherData.temp,
                        condition: weatherData.condition
                    });
                    console.log(`  ✅ Sent ${userCity} weather to user`);
                } else {
                    failCount++;
                    errors.push({ userId, city: userCity, error: 'FCM failed' });
                    console.log(`  ❌ FCM failed for ${userId}`);
                }
                
                // Small delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 50));
                
            } catch (userError) {
                console.error(`  ❌ Error processing user ${userId}:`, userError.message);
                failCount++;
                errors.push({ userId, error: userError.message });
            }
        }
        
        const summary = {
            totalUsers: userCount,
            processedUsers: successCount + failCount,
            successful: successCount,
            failed: failCount,
            successRate: userCount > 0 ? Math.round((successCount / userCount) * 100) : 0,
            timestamp: new Date().toISOString(),
            nextRun: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            timezone: 'Asia/Manila'
        };
        
        console.log('📊 Cron Job Summary:', summary);
        
        return {
            success: true,
            summary,
            results: results.slice(0, 5), // Return only first 5 results
            errors: errors.slice(0, 5),   // Return only first 5 errors
            message: `Cron job completed. ${successCount} notifications sent, ${failCount} failed.`
        };
        
    } catch (error) {
        console.error('❌ Cron job fatal error:', error);
        return {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
            message: 'Cron job failed due to fatal error'
        };
    }
}

/**
 * Quick test without FCM
 */
async function handleQuickTest(city = 'Manila') {
    console.log('⚡ QUICK WEATHER TEST');
    console.log(`City: ${city}`);
    
    const weatherData = await fetchWeatherForCity(city);
    
    if (!weatherData) {
        throw new Error(`Failed to fetch weather for ${city}`);
    }
    
    return {
        success: true,
        city,
        weather: weatherData,
        message: 'Weather data fetched successfully',
        timestamp: new Date().toISOString()
    };
}

/**
 * Get system status
 */
async function handleStatus() {
    const firebaseStatus = admin.apps.length > 0 ? 'connected' : 'disconnected';
    const memoryUsage = process.memoryUsage();
    
    return {
        service: 'Weather Cron Service',
        status: 'running',
        firebase: firebaseStatus,
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        timezone: 'Asia/Manila',
        memory: {
            rss: Math.round(memoryUsage.rss / 1024 / 1024) + 'MB',
            heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB',
            heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB'
        },
        endpoints: [
            { action: 'test', method: 'POST', desc: 'Send test notification' },
            { action: 'quick-test', method: 'POST', desc: 'Fetch weather only' },
            { action: 'cron-simulate', method: 'POST', desc: 'Manual cron trigger' },
            { action: 'status', method: 'GET', desc: 'System status' }
        ],
        note: 'Cron runs every 5 minutes. Check Vercel logs for details.'
    };
}

// ==================== MAIN HANDLER ====================

module.exports = async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    console.log(`📨 [${req.method}] Weather Cron Request at ${new Date().toISOString()}`);
    console.log(`🔗 URL: ${req.url}`);
    console.log(`📝 Method: ${req.method}`);
    
    try {
        // Parse request body
        let requestBody = {};
        if (req.body) {
            try {
                requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            } catch (parseError) {
                console.warn('⚠️ Could not parse request body:', parseError.message);
            }
        }
        
        const { action, userId, city, secret } = requestBody;
        
        // Check if it's a cron job call
        const isCronJob = req.headers['cron-secret'] === process.env.CRON_SECRET || 
                         req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}` ||
                         secret === process.env.CRON_SECRET ||
                         req.headers['user-agent']?.includes('Vercel Cron') ||
                         req.headers['x-vercel-cron'] === 'true';
        
        // If it's a cron job call, execute immediately
        if (isCronJob) {
            console.log('🔐 Cron job authenticated via Vercel scheduler');
            const result = await handleCronJob();
            return res.status(200).json(result);
        }
        
        // Handle manual API requests
        switch (action) {
            case 'test':
                if (!userId) {
                    return res.status(400).json({ 
                        error: 'userId is required for test action',
                        example: '{"action":"test","userId":"YOUR_USER_ID","city":"Manila"}' 
                    });
                }
                const testResult = await handleManualTest(userId, city || 'Manila');
                return res.status(200).json(testResult);
                
            case 'quick-test':
                const quickResult = await handleQuickTest(city || 'Manila');
                return res.status(200).json(quickResult);
                
            case 'cron-simulate':
                // Simulate cron job manually (requires secret)
                if (secret !== process.env.CRON_SECRET) {
                    return res.status(401).json({ 
                        error: 'Authentication required',
                        message: 'Provide CRON_SECRET in request body' 
                    });
                }
                const cronResult = await handleCronJob();
                return res.status(200).json(cronResult);
                
            case 'status':
                const statusResult = await handleStatus();
                return res.status(200).json(statusResult);
                
            default:
                // Default response
                if (req.method === 'GET') {
                    const status = await handleStatus();
                    return res.status(200).json(status);
                }
                
                return res.status(200).json({
                    service: 'Weather Cron Service',
                    status: 'active',
                    timestamp: new Date().toISOString(),
                    message: 'Send a POST request with action parameter',
                    available_actions: [
                        { action: 'test', desc: 'Send test notification to user' },
                        { action: 'quick-test', desc: 'Fetch weather data only' },
                        { action: 'cron-simulate', desc: 'Manually trigger cron job (requires secret)' },
                        { action: 'status', desc: 'Get system status' }
                    ],
                    example_test: 'curl -X POST -H "Content-Type: application/json" -d \'{"action":"test","userId":"YOUR_USER_ID","city":"Manila"}\' https://your-app.vercel.app/api/weather-cron',
                    cron_schedule: 'Every 5 minutes',
                    timezone: 'Asia/Manila'
                });
        }
        
    } catch (error) {
        console.error('❌ Weather Cron Handler Error:', error);
        
        return res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};