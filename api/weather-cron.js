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

// ==================== DEBUG FUNCTIONS ====================
async function debugTokenStorage() {
    try {
        const tokensRef = db.ref('user_tokens');
        const snapshot = await tokensRef.once('value');
        const tokens = snapshot.val();
        
        console.log('\n🔍 DEBUG - Current user_tokens structure:');
        if (tokens && Object.keys(tokens).length > 0) {
            Object.entries(tokens).forEach(([userId, tokenData]) => {
                console.log(`   👤 ${userId.substring(0, 8)}...:`, {
                    hasToken: !!tokenData?.fcmToken,
                    timestamp: tokenData?.updatedAt || tokenData?.timestamp || 'None',
                    age: tokenData?.updatedAt || tokenData?.timestamp ? 
                        `${Math.round((Date.now() - (tokenData.updatedAt || tokenData.timestamp || 0))/1000/60)} minutes ago` : 
                        'Unknown',
                    tokenPreview: tokenData?.fcmToken?.substring(0, 15) + '...'
                });
            });
        } else {
            console.log('   ❌ No tokens found in user_tokens');
        }
        
        return tokens;
    } catch (error) {
        console.error('❌ Debug error:', error);
        return null;
    }
}

async function debugUserTokens() {
    console.log('\n🔍 DEBUG - Checking for duplicate tokens...');
    const tokensRef = db.ref('user_tokens');
    const snapshot = await tokensRef.once('value');
    const tokens = snapshot.val();
    
    if (tokens) {
        // Find users with multiple token entries
        const tokenMap = {};
        Object.entries(tokens).forEach(([userId, tokenData]) => {
            if (tokenData?.fcmToken) {
                if (!tokenMap[userId]) tokenMap[userId] = [];
                tokenMap[userId].push(tokenData.fcmToken);
            }
        });
        
        // Check for users with multiple token entries
        let duplicateUserCount = 0;
        Object.entries(tokenMap).forEach(([userId, tokenList]) => {
            if (tokenList.length > 1) {
                duplicateUserCount++;
                console.log(`   ❌ ${userId.substring(0, 8)}... has ${tokenList.length} token entries!`);
                console.log(`      Tokens: ${tokenList.map(t => t.substring(0, 15) + '...').join(', ')}`);
            }
        });
        
        if (duplicateUserCount === 0) {
            console.log('   ✅ No users with multiple token entries found');
        }
        
        // Also check for duplicate tokens across users
        const tokenToUsers = {};
        Object.entries(tokens).forEach(([userId, tokenData]) => {
            if (tokenData?.fcmToken) {
                const token = tokenData.fcmToken;
                if (!tokenToUsers[token]) tokenToUsers[token] = [];
                tokenToUsers[token].push(userId);
            }
        });
        
        let sharedTokenCount = 0;
        Object.entries(tokenToUsers).forEach(([token, users]) => {
            if (users.length > 1) {
                sharedTokenCount++;
                console.log(`   ❌ Token ${token.substring(0, 15)}... shared by ${users.length} users: ${users.map(u => u.substring(0, 8) + '...').join(', ')}`);
            }
        });
        
        if (sharedTokenCount === 0) {
            console.log('   ✅ No tokens shared across multiple users');
        }
    }
    
    return tokens;
}

async function debugDuplicateUsers() {
    console.log('\n🔍 DEBUG - Checking user database...');
    const usersRef = db.ref('users');
    const snapshot = await usersRef.once('value');
    const users = snapshot.val();
    
    if (users) {
        // Check for users with same email or phone
        const emailMap = {};
        const phoneMap = {};
        
        Object.entries(users).forEach(([userId, userData]) => {
            if (userData?.email) {
                if (!emailMap[userData.email]) emailMap[userData.email] = [];
                emailMap[userData.email].push(userId);
            }
            if (userData?.phone) {
                if (!phoneMap[userData.phone]) phoneMap[userData.phone] = [];
                phoneMap[userData.phone].push(userId);
            }
        });
        
        let duplicateEmailCount = 0;
        Object.entries(emailMap).forEach(([email, userIds]) => {
            if (userIds.length > 1) {
                duplicateEmailCount++;
                console.log(`   ❌ Email "${email}" has ${userIds.length} user IDs: ${userIds.map(u => u.substring(0, 8) + '...').join(', ')}`);
            }
        });
        
        if (duplicateEmailCount === 0) {
            console.log('   ✅ No duplicate emails found');
        }
        
        let duplicatePhoneCount = 0;
        Object.entries(phoneMap).forEach(([phone, userIds]) => {
            if (userIds.length > 1) {
                duplicatePhoneCount++;
                console.log(`   ❌ Phone "${phone}" has ${userIds.length} user IDs: ${userIds.map(u => u.substring(0, 8) + '...').join(', ')}`);
            }
        });
        
        if (duplicatePhoneCount === 0) {
            console.log('   ✅ No duplicate phones found');
        }
    }
    
    return users;
}

async function shouldSendWeatherToUser(userId) {
    try {
        console.log(`🔍 Checking user: ${userId.substring(0, 8)}...`);
        
        // 1. Check if user has FCM token in database
        const tokenRef = db.ref(`user_tokens/${userId}`);
        const tokenSnapshot = await tokenRef.once('value');
        const tokenData = tokenSnapshot.val();
        
        if (!tokenData || !tokenData.fcmToken) {
            console.log(`   ❌ No FCM token (user logged out or never saved)`);
            return false;
        }
        
        // 2. Check if user exists and has city
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        const userData = userSnapshot.val();
        
        if (!userData) {
            console.log(`   ❌ User not found`);
            return false;
        }
        
        const userCity = userData.preferredCity;
        
        if (!userCity || userCity === "undefined" || userCity === "null" || userCity.trim() === "") {
            console.log(`   ❌ Invalid city: "${userCity}"`);
            return false;
        }
        
        console.log(`   ✅ User ${userId.substring(0, 8)}... gets weather for ${userCity}`);
        return true;
        
    } catch (error) {
        console.error(`   ❌ Error:`, error.message);
        return false;
    }
}

// ==================== WEATHER FUNCTIONS ====================
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
    let summary = `${temp}°C | ${condition}`;
    
    if (pests.length > 0) {
        summary += ` | ⚠️ ${pests.length} pest${pests.length > 1 ? 's' : ''}`;
    } else {
        summary += ` | ✅ No pests`;
    }
    
    const firstAdvice = advice.split('.')[0];
    if (firstAdvice !== 'Normal farming activities') {
        summary += ` | ${firstAdvice}`;
    }
    
    if (summary.length > 100) {
        summary = summary.substring(0, 97) + '...';
    }
    
    return summary;
}

async function fetchWeatherForCity(city) {
    try {
        const WEATHER_API_KEY = process.env.WEATHER_API_KEY || 'fbc049c0ab6883e70eb66f800322b567';
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${city},PH&appid=${WEATHER_API_KEY}&units=metric`;
        
        console.log(`   🌤️ Fetching weather for: ${city}`);
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
        console.error(`   ❌ Error fetching weather for ${city}:`, error.message);
        return null;
    }
}

async function sendWeatherNotificationToUser(userId, city, weatherData, isTest = false) {
    try {
        console.log(`   📤 Sending to user: ${userId.substring(0, 8)}... for ${city}`);
        
        // Get user's devices and tokens
        const devicesRef = db.ref(`user_tokens/${userId}/devices`);
        const devicesSnapshot = await devicesRef.once('value');
        const devices = devicesSnapshot.val();
        
        if (!devices) {
            console.log(`   ❌ No devices/tokens found for user`);
            return false;
        }
        
        let sentCount = 0;
        const deviceEntries = Object.entries(devices);
        
        console.log(`   📱 Found ${deviceEntries.length} device(s) for user`);
        
        // Send to each active device
        for (const [deviceId, deviceData] of deviceEntries) {
            try {
                if (!deviceData?.fcmToken) {
                    console.log(`   ⚠️ No token for device ${deviceId.substring(0, 8)}...`);
                    continue;
                }
                
                // Check if device is active (logged in within last 48 hours)
                const lastLoginTime = deviceData.loggedInAt || deviceData.updatedAt || 0;
                const hoursSinceLogin = (Date.now() - lastLoginTime) / (1000 * 60 * 60);
                
                if (hoursSinceLogin > 48) {
                    console.log(`   ⏸️ Device ${deviceId.substring(0, 8)}... inactive (${Math.round(hoursSinceLogin)}h ago)`);
                    continue;
                }
                
                // Prepare notification
                const { temp, condition, humidity, windSpeed, pests, advice, fetchedAt } = weatherData;
                
                const title = isTest 
                    ? `🧪 Weather Test: ${city}` 
                    : `🌤️ Weather Update: ${city}`;
                
                const notificationBody = createNotificationSummary(temp, condition, pests, advice);
                
                // Notification payload with device info
                const messagePayload = {
                    token: deviceData.fcmToken,
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
                        userId: userId,
                        deviceId: deviceId,
                        test: isTest.toString(),
                        source: 'github-actions-cron'
                    },
                    android: {
                        priority: 'high'
                    }
                };
                
                console.log(`   📱 Sending to device ${deviceId.substring(0, 8)}...`);
                
                try {
                    const response = await admin.messaging().send(messagePayload);
                    sentCount++;
                    console.log(`   ✅ Sent to device ${deviceId.substring(0, 8)}...`);
                } catch (sendError) {
                    console.error(`   ❌ Error sending to device ${deviceId.substring(0, 8)}...:`, sendError.message);
                    
                    // Remove invalid token for this device
                    if (sendError.code === 'messaging/registration-token-not-registered') {
                        await db.ref(`user_tokens/${userId}/devices/${deviceId}`).remove();
                        console.log(`   🗑️ Removed invalid device token`);
                    }
                }
                
                // Small delay between devices
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (deviceError) {
                console.error(`   ❌ Device ${deviceId.substring(0, 8)}... error:`, deviceError.message);
            }
        }
        
        console.log(`   📊 Sent to ${sentCount} out of ${deviceEntries.length} device(s)`);
        return sentCount > 0;
        
    } catch (error) {
        console.error(`   ❌ Error:`, error.message);
        return false;
    }
}

// ==================== UPDATED MAIN CRON FUNCTION ====================
async function handleCronJob() {
    const jobId = Date.now();
    console.log(`\n⏰ CRON JOB STARTED - Job ID: ${jobId}`);
    console.log('🕒 Time:', new Date().toISOString());
    
    try {
        // Check if another job is running
        const runningRef = db.ref('cron_status/last_run');
        const lastRunSnapshot = await runningRef.once('value');
        
        // If last run was less than 2 minutes ago, skip
        if (lastRunSnapshot.exists()) {
            const lastRun = lastRunSnapshot.val();
            const timeSinceLastRun = Date.now() - lastRun.timestamp;
            
            if (timeSinceLastRun < 2 * 60 * 1000) { // 2 minutes
                console.log(`⏸️ Another job ran ${Math.round(timeSinceLastRun/1000)} seconds ago, skipping`);
                return {
                    skipped: true,
                    reason: 'Another job ran recently',
                    lastRun: new Date(lastRun.timestamp).toISOString(),
                    jobId: jobId
                };
            }
        }
        
        // Mark this job as running
        await runningRef.set({
            timestamp: Date.now(),
            jobId: jobId,
            status: 'running'
        });
        
        // Debug token storage first
        await debugTokenStorage();
        await debugUserTokens();
        await debugDuplicateUsers();
        
        // Get all users with their preferred cities
        const usersRef = db.ref('users');
        const usersSnapshot = await usersRef.once('value');
        const users = usersSnapshot.val();
        
        if (!users) {
            console.log('❌ No users found');
            await runningRef.remove();
            return { 
                success: false, 
                error: 'No users found',
                timestamp: new Date().toISOString(),
                jobId: jobId
            };
        }
        
        const userCount = Object.keys(users).length;
        console.log(`\n📢 Found ${userCount} users in database`);
        
        // Rate limiting: Check last notification time (30 minutes minimum)
        const notificationCooldown = 30 * 60 * 1000; // 30 minutes
        
        // Cache for weather data to avoid duplicate API calls
        const weatherCache = new Map();
        
        // Deduplication tracking
        const processedUsers = new Set();
        const processedTokens = new Set();
        
        let activeUsers = 0;
        let successCount = 0;
        let failCount = 0;
        let skippedCount = 0;
        const results = [];
        const userEntries = Object.entries(users);
        
        console.log(`\n🔄 Processing users...`);
        
        for (const [userId, userData] of userEntries) {
            if (!userData) {
                skippedCount++;
                continue;
            }
            
            try {
                console.log(`\n👤 Processing: ${userId.substring(0, 8)}...`);
                
                // 1. Check if user already processed in this run
                if (processedUsers.has(userId)) {
                    console.log(`   ⏸️ Already processed in this run, skipping`);
                    skippedCount++;
                    continue;
                }
                processedUsers.add(userId);
                
                // 2. Check rate limiting - last notification time
                const lastNotifRef = db.ref(`last_notification/${userId}`);
                const lastNotifSnapshot = await lastNotifRef.once('value');
                const lastNotif = lastNotifSnapshot.val();
                
                if (lastNotif && Date.now() - lastNotif.timestamp < notificationCooldown) {
                    const minutesAgo = Math.round((Date.now() - lastNotif.timestamp) / 60000);
                    console.log(`   ⏸️ User received notification ${minutesAgo} minutes ago (${lastNotif.city})`);
                    skippedCount++;
                    continue;
                }
                
                // 3. CHECK IF USER IS ACTIVE AND HAS SELECTED CITY
                const shouldSend = await shouldSendWeatherToUser(userId);
                
                if (!shouldSend) {
                    console.log(`   ⏸️ User not active or no city selected`);
                    skippedCount++;
                    continue;
                }
                
                activeUsers++;
                
                // 4. Get user's preferred city
                const userCity = userData.preferredCity;
                console.log(`   📍 User's city: ${userCity}`);
                
                // 5. Check user's FCM token for duplicates
                const tokenRef = db.ref(`user_tokens/${userId}`);
                const tokenSnapshot = await tokenRef.once('value');
                const tokenData = tokenSnapshot.val();
                
                if (!tokenData || !tokenData.fcmToken) {
                    console.log(`   ❌ No FCM token found`);
                    failCount++;
                    continue;
                }
                
                const userToken = tokenData.fcmToken;
                
                // Check if token was already used in this run
                if (processedTokens.has(userToken)) {
                    console.log(`   ⚠️ Token already used for another user in this run`);
                    console.log(`   ℹ️ This might be a shared device or duplicate account`);
                    skippedCount++;
                    continue;
                }
                processedTokens.add(userToken);
                
                // 6. Fetch weather (use cache if available)
                let weatherData;
                if (weatherCache.has(userCity)) {
                    console.log(`   🔄 Using cached weather for ${userCity}`);
                    weatherData = weatherCache.get(userCity);
                    
                    // Update timestamp for freshness
                    weatherData.fetchedAt = new Date().toLocaleTimeString('en-PH', {
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: 'Asia/Manila'
                    });
                } else {
                    weatherData = await fetchWeatherForCity(userCity);
                    if (weatherData) {
                        weatherCache.set(userCity, weatherData);
                    }
                }
                
                if (!weatherData) {
                    console.log(`   ❌ Failed to fetch weather`);
                    failCount++;
                    continue;
                }
                
                // 7. Send notification
                const success = await sendWeatherNotificationToUser(userId, userCity, weatherData, false);
                
                if (success) {
                    successCount++;
                    
                    // Update last notification time
                    await lastNotifRef.set({
                        timestamp: Date.now(),
                        city: userCity,
                        jobId: jobId
                    });
                    
                    results.push({ 
                        userId: userId.substring(0, 8) + '...', 
                        city: userCity,
                        temp: weatherData.temp,
                        condition: weatherData.condition,
                        pests: weatherData.pests.length,
                        tokenPreview: userToken.substring(0, 10) + '...'
                    });
                    console.log(`   ✅ Weather sent for ${userCity} (${weatherData.temp}°C)`);
                } else {
                    failCount++;
                    console.log(`   ❌ Failed to send`);
                }
                
                // Small delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 50));
                
            } catch (userError) {
                console.error(`   ❌ Error processing user:`, userError.message);
                failCount++;
            }
        }
        
        // Clean up running job marker
        await runningRef.remove();
        
        // Save job results
        await db.ref('cron_status/last_success').set({
            timestamp: Date.now(),
            jobId: jobId,
            stats: {
                totalUsers: userCount,
                activeUsers: activeUsers,
                successful: successCount,
                failed: failCount,
                skipped: skippedCount
            }
        });
        
        const summary = {
            jobId: jobId,
            totalUsers: userCount,
            activeUsersWithCity: activeUsers,
            processed: successCount + failCount,
            successful: successCount,
            failed: failCount,
            skipped: skippedCount,
            successRate: activeUsers > 0 ? Math.round((successCount / activeUsers) * 100) : 0,
            duplicateProtection: {
                processedUsers: processedUsers.size,
                processedTokens: processedTokens.size,
                weatherCacheHits: weatherCache.size,
                rateLimitEnabled: true,
                cooldownMinutes: 30
            },
            timestamp: new Date().toISOString(),
            nextRun: 'in 5 minutes via GitHub Actions'
        };
        
        console.log('\n📊 Cron Job Summary:', JSON.stringify(summary, null, 2));
        
        return {
            success: true,
            summary,
            results: results.slice(0, 5),
            message: `Processed ${activeUsers} active users, ${successCount} successful notifications sent`
        };
        
    } catch (error) {
        console.error('❌ Cron job error:', error);
        
        // Clean up running job marker on error
        try {
            await db.ref('cron_status/last_run').remove();
        } catch (cleanupError) {
            console.error('Error cleaning up job marker:', cleanupError);
        }
        
        return {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
            jobId: jobId
        };
    }
}

// ==================== TEST FUNCTIONS ====================
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

// ==================== DIAGNOSTIC FUNCTION ====================
async function diagnoseDuplicateIssue() {
    console.log('\n🔍 DIAGNOSING DUPLICATE NOTIFICATION ISSUE...');
    
    const results = {
        timestamp: new Date().toISOString(),
        checks: []
    };
    
    try {
        // 1. Check user tokens
        const tokens = await debugTokenStorage();
        results.checks.push({
            name: 'User Tokens',
            status: tokens ? 'found' : 'not_found',
            count: tokens ? Object.keys(tokens).length : 0
        });
        
        // 2. Check for duplicate tokens
        await debugUserTokens();
        
        // 3. Check for duplicate users
        await debugDuplicateUsers();
        
        // 4. Check cron status
        const cronStatus = await db.ref('cron_status').once('value');
        results.checks.push({
            name: 'Cron Status',
            status: cronStatus.exists() ? 'exists' : 'not_found',
            lastRun: cronStatus.val()?.last_run || 'never'
        });
        
        // 5. Sample a few users to check their setup
        const usersRef = db.ref('users');
        const usersSnapshot = await usersRef.once('value');
        const users = usersSnapshot.val();
        
        if (users) {
            const sampleUsers = Object.entries(users).slice(0, 3);
            results.sampleUsers = sampleUsers.map(([userId, userData]) => ({
                userId: userId.substring(0, 8) + '...',
                city: userData?.preferredCity || 'none',
                hasToken: false // Will be checked below
            }));
            
            // Check tokens for sample users
            for (let user of results.sampleUsers) {
                const userId = Object.keys(users).find(key => key.startsWith(user.userId.substring(0, 8)));
                if (userId) {
                    const tokenRef = db.ref(`user_tokens/${userId}`);
                    const tokenSnapshot = await tokenRef.once('value');
                    user.hasToken = !!tokenSnapshot.val()?.fcmToken;
                }
            }
        }
        
        results.summary = 'Diagnostic complete. Check console for detailed debug information.';
        
        return results;
        
    } catch (error) {
        console.error('❌ Diagnostic error:', error);
        return {
            error: error.message,
            timestamp: new Date().toISOString()
        };
    }
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
    
    console.log(`\n📨 Request: ${req.method} ${new Date().toISOString()}`);
    
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
                
            case 'diagnose':
                const diagnoseResult = await diagnoseDuplicateIssue();
                return res.status(200).json(diagnoseResult);
                
            case 'status':
                // Check database for user cities
                const usersRef = db.ref('users');
                const usersSnapshot = await usersRef.once('value');
                const users = usersSnapshot.val() || {};
                
                const usersWithCity = Object.values(users).filter(user => 
                    user.preferredCity && user.preferredCity !== 'Manila' && user.preferredCity !== ''
                ).length;
                
                // Get last cron run
                const lastRunRef = db.ref('cron_status/last_success');
                const lastRunSnapshot = await lastRunRef.once('value');
                const lastRun = lastRunSnapshot.val();
                
                return res.status(200).json({
                    service: 'MangoTango Weather Cron',
                    status: 'running',
                    timestamp: new Date().toISOString(),
                    firebase: admin.apps.length > 0 ? 'connected' : 'disconnected',
                    scheduler: 'GitHub Actions',
                    schedule: 'Every 5 minutes',
                    duplicateProtection: {
                        enabled: true,
                        features: [
                            '30-minute cooldown per user',
                            'Token deduplication',
                            'User deduplication',
                            'Weather caching',
                            'Job overlap prevention'
                        ]
                    },
                    stats: {
                        totalUsers: Object.keys(users).length,
                        usersWithSelectedCity: usersWithCity,
                        usersDefaultManila: Object.keys(users).length - usersWithCity
                    },
                    lastRun: lastRun ? {
                        timestamp: new Date(lastRun.timestamp).toISOString(),
                        jobId: lastRun.jobId,
                        successful: lastRun.stats?.successful || 0
                    } : 'Never'
                });
                
            default:
                if (req.method === 'GET') {
                    return res.status(200).json({
                        service: 'MangoTango Weather Cron',
                        status: 'active',
                        features: [
                            'Personalized city weather',
                            'Pest alerts based on conditions',
                            'Farming advice',
                            'Active user filtering',
                            'Duplicate notification prevention',
                            '30-minute cooldown per user',
                            'Auto token cleanup'
                        ],
                        endpoints: [
                            'GET / - This info',
                            'POST {action: "test", userId: "..."} - Send test',
                            'POST {action: "quick-test"} - Weather only',
                            'POST {action: "diagnose"} - Debug duplicates',
                            'POST {action: "status"} - Service status'
                        ],
                        timestamp: new Date().toISOString()
                    });
                }
                
                return res.status(200).json({
                    message: 'Weather cron service is running',
                    duplicateProtection: 'Enabled (30-minute cooldown, token/user deduplication)',
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