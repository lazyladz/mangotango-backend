const admin = require('firebase-admin');
const axios = require('axios');

// Initialize Firebase
try {
    if (!admin.apps.length) {
        console.log('🔥 Initializing Firebase Admin...');
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            }),
            databaseURL: process.env.FIREBASE_DATABASE_URL
        });
        console.log('✅ Firebase initialized');
    }
} catch (error) {
    console.error('❌ Firebase init error:', error.message);
}

const db = admin.database();

// ==================== HELPER FUNCTIONS ====================

function getPestAlerts(temp, condition, humidity, windSpeed) {
    const pests = [];
    
    if (temp > 28 && condition === 'Sunny') pests.push('Mango hopper');
    if (temp > 25 && condition === 'Cloudy') pests.push('Mealybug');
    if (temp >= 22 && temp <= 30 && condition === 'Rainy') pests.push('Cecid Fly');
    if (condition === 'Rainy') pests.push('Anthracnose');
    if (temp > 30) pests.push('Leaf Hopper');
    
    if (condition === 'Rainy' && temp > 25) pests.push('Fungal diseases');
    if (condition === 'Sunny' && temp > 32) pests.push('Heat stress');
    if (humidity > 85) pests.push('Powdery mildew risk');
    if (windSpeed > 5) pests.push('Wind may spread pests');
    
    return pests;
}

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

function createNotificationSummary(temp, condition, pests, advice) {
    // Create a compact summary for notification
    let summary = `${temp}°C | ${condition}`;
    
    if (pests.length > 0) {
        // Add pest indicator
        summary += ` | ⚠️ ${pests.length} pest${pests.length > 1 ? 's' : ''}`;
    } else {
        summary += ` | ✅ No pests`;
    }
    
    // Add first advice
    const firstAdvice = advice.split('.')[0];
    if (firstAdvice !== 'Normal farming activities') {
        summary += ` | ${firstAdvice}`;
    }
    
    // Limit length
    if (summary.length > 100) {
        summary = summary.substring(0, 97) + '...';
    }
    
    return summary;
}

async function fetchWeatherForCity(city) {
    try {
        const WEATHER_API_KEY = process.env.WEATHER_API_KEY || 'fbc049c0ab6883e70eb66f800322b567';
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${city},PH&appid=${WEATHER_API_KEY}&units=metric`;
        
        console.log(`🌤️ Fetching weather for: ${city}`);
        const response = await axios.get(url);
        
        const data = response.data;
        const temp = Math.round(data.main.temp);
        const condition = data.weather[0].main;
        const humidity = data.main.humidity;
        const windSpeed = data.wind.speed;
        
        const pests = getPestAlerts(temp, condition, humidity, windSpeed);
        const advice = getFarmingAdvice(temp, condition, humidity, windSpeed);
        
        return {
            city,
            temp,
            condition,
            humidity,
            windSpeed: Math.round(windSpeed * 10) / 10,
            pests,
            advice,
            timestamp: new Date().toISOString(),
            fetchedAt: new Date().toLocaleTimeString('en-PH', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Manila'
            })
        };
        
    } catch (error) {
        console.error(`❌ Error fetching weather for ${city}:`, error.message);
        return null;
    }
}

async function sendWeatherNotificationToUser(userId, city, weatherData, isTest = false) {
    try {
        console.log(`🌤️ Sending to user: ${userId} for ${city}`);
        
        // Get user's FCM token
        const tokenRef = db.ref(`user_tokens/${userId}`);
        const tokenSnapshot = await tokenRef.once('value');
        const tokenData = tokenSnapshot.val();
        
        if (!tokenData || !tokenData.fcmToken) {
            console.log(`❌ No FCM token for user: ${userId}`);
            return false;
        }
        
        const { temp, condition, humidity, windSpeed, pests, advice, fetchedAt } = weatherData;
        
        // Create notification message
        const title = isTest 
            ? `🧪 Weather Test: ${city}` 
            : `🌤️ Weather Update: ${city}`;
        
        // Create detailed message
        const weatherMessage = `🌡️ ${temp}°C | ${condition}\n💧 ${humidity}% | 💨 ${windSpeed}m/s\n⏰ ${fetchedAt}`;
        
        const pestMessage = pests.length > 0 
            ? `\n\n⚠️ Pest Alert:\n${pests.map(p => `• ${p}`).join('\n')}`
            : '\n\n✅ No major pest threats';
        
        const fullMessage = `${weatherMessage}${pestMessage}\n\n💡 ${advice}`;
        
        // Create notification summary (what shows on screen)
        const notificationBody = createNotificationSummary(temp, condition, pests, advice);
        
        // ✅ SIMPLE FIXED VERSION - No problematic Android fields
        const messagePayload = {
            token: tokenData.fcmToken,
            notification: {
                title: title,
                body: notificationBody
            },
            data: {
                type: 'weather',
                city: city,
                temperature: temp.toString(),
                condition: condition,
                humidity: humidity.toString(),
                wind_speed: windSpeed.toString(),
                pests: JSON.stringify(pests),
                advice: advice,
                timestamp: new Date().toISOString(),
                message: fullMessage,
                test: isTest.toString(),
                source: 'github-actions-cron'
            },
            android: {
                priority: 'high'
            }
        };
        
        console.log(`🚀 Sending FCM to ${userId}`);
        console.log(`📱 Notification: ${title} - ${notificationBody}`);
        
        const response = await admin.messaging().send(messagePayload);
        console.log(`✅ Sent successfully to ${userId}`);
        
        return true;
        
    } catch (error) {
        console.error(`❌ Error sending to ${userId}:`, error.message);
        
        // Remove invalid token
        if (error.code === 'messaging/registration-token-not-registered') {
            await db.ref(`user_tokens/${userId}`).remove();
            console.log(`🗑️ Removed invalid token for: ${userId}`);
        }
        
        return false;
    }
}

// ==================== MAIN FUNCTIONS ====================

async function handleCronJob() {
    console.log('⏰ CRON JOB STARTED via GitHub Actions');
    console.log('🕒 Time:', new Date().toISOString());
    
    try {
        // Get all users with their preferred cities
        const usersRef = db.ref('users');
        const usersSnapshot = await usersRef.once('value');
        const users = usersSnapshot.val();
        
        if (!users) {
            console.log('❌ No users found');
            return { 
                success: false, 
                error: 'No users found',
                timestamp: new Date().toISOString()
            };
        }
        
        const userCount = Object.keys(users).length;
        console.log(`📢 Found ${userCount} users`);
        
        let successCount = 0;
        let failCount = 0;
        const results = [];
        const userEntries = Object.entries(users);
        
        for (const [userId, userData] of userEntries) {
            if (!userData) continue;
            
            try {
                // Get user's preferred city from Firebase
                let userCity = userData.preferredCity;
                
                // FIX: Don't default to Manila if user hasn't selected a city
                if (!userCity || userCity === 'Manila') {
                    console.log(`  ⚠️ User ${userId.substring(0, 8)}... hasn't selected a city, skipping`);
                    continue;  // Skip users who haven't selected a city
                }
                
                console.log(`  👤 Processing: ${userId.substring(0, 8)}..., City: ${userCity}`);
                
                // Fetch weather for user's city
                const weatherData = await fetchWeatherForCity(userCity);
                
                if (!weatherData) {
                    console.log(`  ❌ Failed to fetch weather for ${userCity}`);
                    failCount++;
                    continue;
                }
                
                // Send notification
                const success = await sendWeatherNotificationToUser(userId, userCity, weatherData, false);
                
                if (success) {
                    successCount++;
                    results.push({ 
                        userId: userId.substring(0, 8) + '...', 
                        city: userCity,
                        temp: weatherData.temp,
                        condition: weatherData.condition,
                        pests: weatherData.pests.length,
                        advice: weatherData.advice.substring(0, 30) + '...'
                    });
                    console.log(`  ✅ Sent weather for ${userCity} (${weatherData.temp}°C, ${weatherData.pests.length} pests)`);
                } else {
                    failCount++;
                    console.log(`  ❌ Failed to send to ${userId}`);
                }
                
                // Small delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (userError) {
                console.error(`  ❌ Error processing ${userId}:`, userError.message);
                failCount++;
            }
        }
        
        const summary = {
            totalUsers: userCount,
            usersWithCity: userEntries.filter(([_, data]) => data.preferredCity && data.preferredCity !== 'Manila').length,
            processed: successCount + failCount,
            successful: successCount,
            failed: failCount,
            successRate: userCount > 0 ? Math.round((successCount / userCount) * 100) : 0,
            timestamp: new Date().toISOString(),
            nextRun: 'in 5 minutes via GitHub Actions'
        };
        
        console.log('📊 Cron Job Summary:', summary);
        
        return {
            success: true,
            summary,
            results: results.slice(0, 5),
            message: `Processed ${successCount + failCount} users with selected cities, ${successCount} successful`
        };
        
    } catch (error) {
        console.error('❌ Cron job error:', error);
        return {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        };
    }
}

async function handleManualTest(userId, city = 'Manila') {
    console.log('🧪 Manual test requested');
    
    const weatherData = await fetchWeatherForCity(city);
    
    if (!weatherData) {
        throw new Error(`Failed to fetch weather for ${city}`);
    }
    
    const success = await sendWeatherNotificationToUser(userId, city, weatherData, true);
    
    return {
        success,
        city,
        weather: weatherData,
        notification: {
            title: `🧪 Weather Test: ${city}`,
            body: createNotificationSummary(weatherData.temp, weatherData.condition, weatherData.pests, weatherData.advice),
            details: `🌡️ ${weatherData.temp}°C | ${weatherData.condition}\n💧 ${weatherData.humidity}% | 💨 ${weatherData.windSpeed}m/s\n⏰ ${weatherData.fetchedAt}\n\n⚠️ Pests: ${weatherData.pests.length > 0 ? weatherData.pests.join(', ') : 'None'}\n💡 Advice: ${weatherData.advice}`
        },
        message: success ? 'Test notification sent successfully with pest alerts and advice' : 'Failed to send test'
    };
}

async function handleQuickTest(city = 'Manila') {
    console.log('⚡ Quick test requested');
    
    const weatherData = await fetchWeatherForCity(city);
    
    if (!weatherData) {
        throw new Error(`Failed to fetch weather for ${city}`);
    }
    
    return {
        success: true,
        city,
        weather: weatherData,
        notification_preview: createNotificationSummary(weatherData.temp, weatherData.condition, weatherData.pests, weatherData.advice),
        message: 'Weather data fetched with pest analysis'
    };
}

// ==================== MAIN HANDLER ====================

module.exports = async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    console.log(`📨 Request: ${req.method} ${new Date().toISOString()}`);
    console.log(`👤 User-Agent: ${req.headers['user-agent'] || 'Unknown'}`);
    
    try {
        // Parse request body
        let requestBody = {};
        if (req.body) {
            requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        }
        
        const { action, userId, city, secret, source } = requestBody;
        
        // Handle GitHub Actions cron trigger
        if (action === 'cron-simulate' && secret === process.env.CRON_SECRET) {
            console.log('🔐 Authenticated via GitHub Actions');
            console.log(`🌐 Source: ${source || 'unknown'}`);
            
            const result = await handleCronJob();
            return res.status(200).json(result);
        }
        
        // Handle manual API requests
        switch (action) {
            case 'test':
                if (!userId) {
                    return res.status(400).json({ 
                        error: 'userId required',
                        example: '{"action":"test","userId":"USER_ID","city":"Manila"}' 
                    });
                }
                const testResult = await handleManualTest(userId, city || 'Manila');
                return res.status(200).json(testResult);
                
            case 'quick-test':
                const quickResult = await handleQuickTest(city || 'Manila');
                return res.status(200).json(quickResult);
                
            case 'status':
                // Check database for user cities
                const usersRef = db.ref('users');
                const usersSnapshot = await usersRef.once('value');
                const users = usersSnapshot.val() || {};
                
                const usersWithCity = Object.values(users).filter(user => 
                    user.preferredCity && user.preferredCity !== 'Manila'
                ).length;
                
                return res.status(200).json({
                    service: 'MangoTango Weather Cron',
                    status: 'running',
                    timestamp: new Date().toISOString(),
                    firebase: admin.apps.length > 0 ? 'connected' : 'disconnected',
                    scheduler: 'GitHub Actions',
                    schedule: 'Every 5 minutes',
                    stats: {
                        totalUsers: Object.keys(users).length,
                        usersWithSelectedCity: usersWithCity,
                        usersDefaultManila: Object.keys(users).length - usersWithCity
                    },
                    endpoints: [
                        { action: 'test', method: 'POST', desc: 'Send test notification with pests & advice' },
                        { action: 'quick-test', method: 'POST', desc: 'Fetch weather with pest analysis' },
                        { action: 'cron-simulate', method: 'POST', desc: 'Trigger cron (requires secret)' }
                    ]
                });
                
            default:
                // Default GET response
                if (req.method === 'GET') {
                    return res.status(200).json({
                        service: 'MangoTango Weather Cron',
                        status: 'active',
                        features: [
                            'Personalized city weather',
                            'Pest alerts based on conditions',
                            'Farming advice',
                            'Expanded notification details',
                            'Skips users without selected city'
                        ],
                        timestamp: new Date().toISOString(),
                        note: 'This endpoint is triggered by GitHub Actions every 5 minutes',
                        manual_test: 'curl -X POST https://mangotango-backend.vercel.app/api/weather-cron -d \'{"action":"test","userId":"YOUR_USER_ID","city":"Manila"}\''
                    });
                }
                
                return res.status(200).json({
                    message: 'Weather cron service is running',
                    next_cron: 'Triggered by GitHub Actions every 5 minutes',
                    features: 'Now includes pest alerts and farming advice in notifications',
                    timestamp: new Date().toISOString()
                });
        }
        
    } catch (error) {
        console.error('❌ Handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
};