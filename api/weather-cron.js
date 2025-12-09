const admin = require('firebase-admin');
const axios = require('axios');


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

// ==================== NEW: CLEANUP INACTIVE DEVICES ====================
async function cleanupInactiveDevices() {
    console.log('\n🧹 CLEANING UP INACTIVE DEVICES...');
    
    const tokensRef = db.ref('user_tokens');
    const snapshot = await tokensRef.once('value');
    const tokens = snapshot.val();
    
    if (!tokens) {
        console.log('   ✅ No tokens found');
        return { cleaned: 0 };
    }
    
    let cleanedCount = 0;
    
    for (const [userId, tokenData] of Object.entries(tokens)) {
        if (tokenData?.devices) {
            for (const [deviceId, deviceData] of Object.entries(tokenData.devices)) {
                // Remove devices marked as inactive for more than 7 days
                if (deviceData.isActive === false && deviceData.loggedOutAt) {
                    const daysSinceLogout = (Date.now() - deviceData.loggedOutAt) / (1000 * 60 * 60 * 24);
                    
                    if (daysSinceLogout > 7) {
                        console.log(`   🗑️ Removing inactive device ${deviceId.substring(0, 8)}... from user ${userId.substring(0, 8)}... (logged out ${Math.round(daysSinceLogout)} days ago)`);
                        await db.ref(`user_tokens/${userId}/devices/${deviceId}`).remove();
                        cleanedCount++;
                    }
                }
            }
        }
    }
    
    if (cleanedCount === 0) {
        console.log('   ✅ No inactive devices to clean (or all are recent)');
    } else {
        console.log(`   📊 Cleaned ${cleanedCount} inactive devices`);
    }
    
    return { cleaned: cleanedCount };
}

// ==================== CLEANUP FUNCTIONS ====================
async function cleanDuplicateTokens() {
    console.log('\n🧹 CLEANING DUPLICATE TOKENS...');
    
    const tokensRef = db.ref('user_tokens');
    const snapshot = await tokensRef.once('value');
    const tokens = snapshot.val();
    
    if (!tokens) {
        console.log('   ✅ No tokens found to clean');
        return { cleaned: 0, total: 0 };
    }
    
    const totalTokens = Object.keys(tokens).length;
    console.log(`   📊 Found ${totalTokens} token entries`);
    
    // Find all tokens and their users
    const tokenToUsers = {};
    const userTokenInfo = {};
    
    Object.entries(tokens).forEach(([userId, tokenData]) => {
        if (tokenData?.fcmToken) {
            const token = tokenData.fcmToken;
            const updatedAt = tokenData.updatedAt || 0;
            
            if (!tokenToUsers[token]) tokenToUsers[token] = [];
            tokenToUsers[token].push({ userId, updatedAt });
            
            userTokenInfo[userId] = {
                token: token,
                updatedAt: updatedAt,
                hasDevices: !!tokenData.devices,
                deviceCount: tokenData.devices ? Object.keys(tokenData.devices).length : 0
            };
        }
    });
    
    let cleanedCount = 0;
    let duplicateTokens = 0;
    
    // For each token with multiple users, keep only the most recent
    for (const [token, users] of Object.entries(tokenToUsers)) {
        if (users.length > 1) {
            duplicateTokens++;
            console.log(`\n   ⚠️ Token ${token.substring(0, 20)}... shared by ${users.length} users:`);
            
            users.forEach((user, index) => {
                const dateStr = user.updatedAt ? new Date(user.updatedAt).toLocaleString() : 'Never';
                console.log(`      ${index + 1}. ${user.userId.substring(0, 8)}... - Updated: ${dateStr}`);
            });
            
            // Sort by most recent update (newest first)
            users.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            
            // Keep the most recent user
            const keepUserId = users[0].userId;
            const keepTime = users[0].updatedAt || 0;
            console.log(`   ✅ Keeping ${keepUserId.substring(0, 8)}... (most recent: ${new Date(keepTime).toLocaleString()})`);
            
            // Remove from other users
            for (let i = 1; i < users.length; i++) {
                const removeUserId = users[i].userId;
                const removeTime = users[i].updatedAt || 0;
                console.log(`   🗑️ Removing from ${removeUserId.substring(0, 8)}... (older: ${new Date(removeTime).toLocaleString()})`);
                
                // Remove the entire token entry for this user
                await db.ref(`user_tokens/${removeUserId}`).remove();
                cleanedCount++;
            }
        }
    }
    
    if (duplicateTokens === 0) {
        console.log('   ✅ No duplicate tokens found');
    } else {
        console.log(`\n   📊 Summary:`);
        console.log(`      Total token entries: ${totalTokens}`);
        console.log(`      Duplicate tokens found: ${duplicateTokens}`);
        console.log(`      Cleaned entries: ${cleanedCount}`);
        console.log(`      Remaining entries: ${totalTokens - cleanedCount}`);
    }
    
    return {
        cleaned: cleanedCount,
        total: totalTokens,
        duplicateTokens: duplicateTokens,
        remaining: totalTokens - cleanedCount
    };
}

async function cleanEmptyTokenEntries() {
    console.log('\n🧹 CLEANING EMPTY TOKEN ENTRIES...');
    
    const tokensRef = db.ref('user_tokens');
    const snapshot = await tokensRef.once('value');
    const tokens = snapshot.val();
    
    if (!tokens) {
        console.log('   ✅ No token entries found');
        return { cleaned: 0 };
    }
    
    let cleanedCount = 0;
    
    for (const [userId, tokenData] of Object.entries(tokens)) {
        // Check if entry is empty or has no token
        if (!tokenData || 
            (!tokenData.fcmToken && 
             (!tokenData.devices || Object.keys(tokenData.devices).length === 0))) {
            
            console.log(`   🗑️ Removing empty entry for ${userId.substring(0, 8)}...`);
            await db.ref(`user_tokens/${userId}`).remove();
            cleanedCount++;
        }
    }
    
    if (cleanedCount === 0) {
        console.log('   ✅ No empty token entries found');
    } else {
        console.log(`   📊 Cleaned ${cleanedCount} empty entries`);
    }
    
    return { cleaned: cleanedCount };
}

async function cleanInvalidCityUsers() {
    console.log('\n🧹 CLEANING USERS WITH INVALID CITIES...');
    
    const usersRef = db.ref('users');
    const snapshot = await usersRef.once('value');
    const users = snapshot.val();
    
    if (!users) {
        console.log('   ✅ No users found');
        return { cleaned: 0 };
    }
    
    let cleanedCount = 0;
    const invalidCities = ['undefined', 'null', ''];
    
    for (const [userId, userData] of Object.entries(users)) {
        if (userData && userData.preferredCity) {
            const city = userData.preferredCity;
            if (invalidCities.includes(city) || city.trim() === '') {
                console.log(`   🗑️ User ${userId.substring(0, 8)}... has invalid city: "${city}"`);
                
                // Remove their token if exists
                await db.ref(`user_tokens/${userId}`).remove();
                
                // Remove city from user (keep user record, just clear city)
                await db.ref(`users/${userId}/preferredCity`).remove();
                
                cleanedCount++;
            }
        }
    }
    
    if (cleanedCount === 0) {
        console.log('   ✅ No users with invalid cities found');
    } else {
        console.log(`   📊 Cleaned ${cleanedCount} users with invalid cities`);
    }
    
    return { cleaned: cleanedCount };
}

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
                    tokenPreview: tokenData?.fcmToken?.substring(0, 15) + '...',
                    hasDevices: !!tokenData?.devices,
                    deviceCount: tokenData?.devices ? Object.keys(tokenData.devices).length : 0
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

// ==================== UPDATED: shouldSendWeatherToUser ====================
async function shouldSendWeatherToUser(userId) {
    try {
        console.log(`🔍 Checking user: ${userId.substring(0, 8)}...`);
        
        // 1. Get user data FIRST (check login/logout status)
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        const userData = userSnapshot.val();
        
        if (!userData) {
            console.log(`   ❌ User not found in database`);
            return false;
        }
        
        // ✅ CRITICAL CHECK 1: Check if user is marked as inactive
        if (userData.isActive === false) {
            console.log(`   ⏸️ User marked as inactive (isActive: false)`);
            return false;
        }
        
        // ✅ CRITICAL CHECK 2: Check last logout vs last login
        const lastLogin = userData.lastLogin || 0;
        const lastLogout = userData.lastLogout || 0;
        
        if (lastLogout > lastLogin) {
            console.log(`   ⏸️ User logged out recently`);
            console.log(`      Last login: ${new Date(lastLogin).toISOString()}`);
            console.log(`      Last logout: ${new Date(lastLogout).toISOString()}`);
            return false;
        }
        
        // ✅ CRITICAL CHECK 3: Check if user has a valid city
        const userCity = userData.preferredCity;
        
        if (!userCity || userCity === "undefined" || userCity === "null" || userCity.trim() === "") {
            console.log(`   ❌ Invalid city: "${userCity}"`);
            return false;
        }
        
        // 2. Check if user has ACTIVE devices with tokens
        const devicesRef = db.ref(`user_tokens/${userId}/devices`);
        const devicesSnapshot = await devicesRef.once('value');
        const devices = devicesSnapshot.val();
        
        if (!devices) {
            // Check old token format as fallback
            const tokenRef = db.ref(`user_tokens/${userId}`);
            const tokenSnapshot = await tokenRef.once('value');
            const tokenData = tokenSnapshot.val();
            
            if (tokenData?.fcmToken && !tokenData.devices) {
                console.log(`   🔄 Found old format token, will migrate`);
                // Will be migrated in sendWeatherNotificationToUser
            } else {
                console.log(`   ❌ No devices or tokens found for user`);
                return false;
            }
        } else {
            // Find ACTIVE devices (isActive !== false and has FCM token)
            const activeDevices = Object.entries(devices).filter(([deviceId, deviceData]) => {
                // Device must have FCM token
                if (!deviceData?.fcmToken) return false;
                
                // Device must be marked as active (isActive !== false)
                if (deviceData.isActive === false) return false;
                
                // Check if device logged in recently (within 48 hours)
                const lastLoginTime = deviceData.loggedInAt || deviceData.updatedAt || 0;
                const hoursSinceLogin = (Date.now() - lastLoginTime) / (1000 * 60 * 60);
                
                return hoursSinceLogin <= 48;
            });
            
            if (activeDevices.length === 0) {
                console.log(`   ❌ No active devices found`);
                return false;
            }
            
            console.log(`   📱 Found ${activeDevices.length} active device(s)`);
        }
        
        console.log(`   ✅ User ${userId.substring(0, 8)}... gets weather for ${userCity}`);
        console.log(`   🔐 Last login: ${lastLogin ? new Date(lastLogin).toISOString() : 'never'}`);
        console.log(`   🚪 Last logout: ${lastLogout ? new Date(lastLogout).toISOString() : 'never'}`);
        console.log(`   🏙️ City: ${userCity}`);
        
        return true;
        
    } catch (error) {
        console.error(`   ❌ Error checking user ${userId.substring(0, 8)}...:`, error.message);
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
    // Get weather emoji
    const getWeatherEmoji = (cond) => {
        const emojiMap = {
            'Clear': '☀️', 'Sunny': '☀️',
            'Rain': '🌧️', 'Rainy': '🌧️', 'Drizzle': '🌧️',
            'Clouds': '☁️', 'Cloudy': '☁️',
            'Thunderstorm': '⛈️', 'Stormy': '⛈️',
            'Snow': '❄️', 'Fog': '🌫️', 'Mist': '🌫️'
        };
        return emojiMap[cond] || '🌤️';
    };
    
    let summary = `${getWeatherEmoji(condition)} ${temp}°C | ${condition}`;
    
    if (pests.length > 0) {
        const pestsToShow = pests.slice(0, 3);
        const pestEmoji = pests.length > 2 ? '🐛⚠️' : '🐛';
        summary += ` | ${pestEmoji} ${pestsToShow.join(', ')}`;
        
        if (pests.length > 3) {
            summary += ` & ${pests.length - 3} more`;
        }
    } else {
        summary += ` | ✅ No pests`;
    }
    
    // Add brief advice if space allows
    if (summary.length < 70) {
        const firstAdvice = advice.split('.')[0];
        if (firstAdvice !== 'Normal farming activities') {
            summary += ` | 💡 ${firstAdvice.substring(0, 30)}`;
        }
    }
    
    // Ensure it fits notification limits
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

// ==================== UPDATED: sendWeatherNotificationToUser ====================
async function sendWeatherNotificationToUser(userId, city, weatherData, isTest = false) {
    try {
        console.log(`   📤 Sending to user: ${userId.substring(0, 8)}... for ${city}`);
        
        let tokensToSend = [];
        
        // Try new format first: devices structure
        const devicesRef = db.ref(`user_tokens/${userId}/devices`);
        const devicesSnapshot = await devicesRef.once('value');
        const devices = devicesSnapshot.val();
        
        if (devices) {
            console.log(`   📱 Found ${Object.keys(devices).length} device(s) in new format`);
            
            Object.entries(devices).forEach(([deviceId, deviceData]) => {
                if (deviceData?.fcmToken) {
                    // ✅ CRITICAL: Check if device is ACTIVE
                    if (deviceData.isActive === false) {
                        console.log(`   ⏸️ Device ${deviceId.substring(0, 8)}... is marked as inactive, skipping`);
                        return;
                    }
                    
                    // Check if device logged in recently (within 48 hours)
                    const lastLoginTime = deviceData.loggedInAt || deviceData.updatedAt || 0;
                    const hoursSinceLogin = (Date.now() - lastLoginTime) / (1000 * 60 * 60);
                    
                    if (hoursSinceLogin <= 48) {
                        tokensToSend.push({
                            token: deviceData.fcmToken,
                            deviceId: deviceId,
                            source: 'device',
                            lastLogin: lastLoginTime,
                            deviceInfo: `${deviceData.deviceModel || 'Unknown'}`
                        });
                        console.log(`   📱 Device ${deviceId.substring(0, 8)}...: ${deviceData.fcmToken.substring(0, 20)}...`);
                    } else {
                        console.log(`   ⏸️ Device ${deviceId.substring(0, 8)}... inactive (${Math.round(hoursSinceLogin)}h ago)`);
                    }
                }
            });
        }
        
        // If no devices found, try old format
        if (tokensToSend.length === 0) {
            const tokenRef = db.ref(`user_tokens/${userId}`);
            const tokenSnapshot = await tokenRef.once('value');
            const tokenData = tokenSnapshot.val();
            
            if (tokenData?.fcmToken && !tokenData.devices) {
                console.log(`   🔄 Using old token format`);
                console.log(`   🔑 Token: ${tokenData.fcmToken.substring(0, 30)}...`);
                tokensToSend.push({
                    token: tokenData.fcmToken,
                    deviceId: 'legacy_device',
                    source: 'legacy',
                    lastLogin: tokenData.updatedAt || Date.now(),
                    deviceInfo: 'Legacy Device'
                });
                
                // Migrate to new format
                await migrateToDeviceFormat(userId, tokenData.fcmToken);
            }
        }
        
        if (tokensToSend.length === 0) {
            console.log(`   ❌ No valid tokens found for user`);
            return false;
        }
        
        console.log(`   📱 Found ${tokensToSend.length} token(s) to send`);
        
        const { temp, condition, humidity, windSpeed, pests, advice, fetchedAt } = weatherData;
        const title = isTest ? `🧪 Weather Test: ${city}` : `🌤️ Weather Update: ${city}`;
        const notificationBody = createNotificationSummary(temp, condition, pests, advice);
        
        let sentCount = 0;
        let detailedResults = [];
        
        // Send to each token
        for (const tokenInfo of tokensToSend) {
            try {
                const messagePayload = {
                    token: tokenInfo.token,
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
                        deviceId: tokenInfo.deviceId,
                        source: tokenInfo.source,
                        test: isTest.toString(),
                        cronJobId: 'github-actions'
                    },
                    android: {
                        priority: 'high',
                        notification: {
                            channel_id: 'weather_alerts',
                            sound: 'default',
                            color: '#FF9800'
                        }
                    },
                    apns: {
                        payload: {
                            aps: {
                                sound: 'default',
                                badge: 1
                            }
                        }
                    }
                };
                
                console.log(`   📱 Sending to ${tokenInfo.source} device ${tokenInfo.deviceId.substring(0, 8)}...`);
                console.log(`   🔑 Token preview: ${tokenInfo.token.substring(0, 30)}...`);
                
                const response = await admin.messaging().send(messagePayload);
                sentCount++;
                console.log(`   ✅ Sent successfully - Message ID: ${response}`);
                
                detailedResults.push({
                    deviceId: tokenInfo.deviceId,
                    status: 'success',
                    messageId: response,
                    tokenPreview: tokenInfo.token.substring(0, 20) + '...'
                });
                
            } catch (sendError) {
                console.error(`   ❌ Error sending:`, sendError.message);
                console.error(`   🔧 Error code:`, sendError.code);
                console.error(`   🔑 Token: ${tokenInfo.token.substring(0, 30)}...`);
                
                detailedResults.push({
                    deviceId: tokenInfo.deviceId,
                    status: 'failed',
                    error: sendError.message,
                    errorCode: sendError.code,
                    tokenPreview: tokenInfo.token.substring(0, 20) + '...'
                });
                
                // Remove invalid token
                if (sendError.code === 'messaging/registration-token-not-registered' ||
                    sendError.code === 'messaging/invalid-registration-token' ||
                    sendError.code === 'messaging/invalid-argument') {
                    console.log(`   🗑️ Removing invalid token`);
                    
                    if (tokenInfo.source === 'device') {
                        await db.ref(`user_tokens/${userId}/devices/${tokenInfo.deviceId}`).remove();
                    } else if (tokenInfo.source === 'legacy') {
                        await db.ref(`user_tokens/${userId}`).remove();
                    }
                }
            }
            
            // Small delay between sends
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log(`   📊 Sent to ${sentCount} out of ${tokensToSend.length} token(s)`);
        console.log(`   📋 Detailed results:`, JSON.stringify(detailedResults, null, 2));
        
        return {
            success: sentCount > 0,
            sentCount: sentCount,
            totalTokens: tokensToSend.length,
            detailedResults: detailedResults
        };
        
    } catch (error) {
        console.error(`   ❌ Error:`, error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

async function migrateToDeviceFormat(userId, token) {
    try {
        console.log(`   🔄 Migrating user ${userId.substring(0, 8)}... to device format`);
        
        const deviceId = `legacy_${Date.now()}`;
        const deviceData = {
            fcmToken: token,
            deviceId: deviceId,
            deviceModel: 'Unknown',
            deviceBrand: 'Unknown',
            androidVersion: 'Unknown',
            migratedAt: Date.now(),
            loggedInAt: Date.now(),
            updatedAt: Date.now(),
            isActive: true,
            source: 'migrated'
        };
        
        // Create devices structure
        await db.ref(`user_tokens/${userId}/devices`).set({
            [deviceId]: deviceData
        });
        
        // Keep old format for backward compatibility
        await db.ref(`user_tokens/${userId}`).update({
            fcmToken: token,
            updatedAt: Date.now(),
            latestDeviceId: deviceId,
            deviceCount: 1,
            migrated: true
        });
        
        console.log(`   ✅ Migration complete`);
    } catch (error) {
        console.error(`   ❌ Migration failed:`, error.message);
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
        
        // Run cleanup BEFORE processing
        console.log('\n🧹 RUNNING PRE-JOB CLEANUP...');
        const cleanupResult = await cleanDuplicateTokens();
        await cleanEmptyTokenEntries();
        await cleanInvalidCityUsers();
        await cleanupInactiveDevices(); // ✅ NEW: Clean inactive devices
        
        // Debug token storage after cleanup
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
                
                // 2. CHECK IF USER IS ACTIVE AND HAS SELECTED CITY
                const shouldSend = await shouldSendWeatherToUser(userId);
                
                if (!shouldSend) {
                    console.log(`   ⏸️ User not active or no city selected`);
                    skippedCount++;
                    continue;
                }
                
                activeUsers++;
                
                // 3. Get user's preferred city
                const userCity = userData.preferredCity;
                console.log(`   📍 User's city: ${userCity}`);
                
                // 4. Check user's FCM token
                const tokenRef = db.ref(`user_tokens/${userId}`);
                const tokenSnapshot = await tokenRef.once('value');
                const tokenData = tokenSnapshot.val();
                
                if (!tokenData || !tokenData.fcmToken) {
                    console.log(`   ❌ No FCM token found`);
                    failCount++;
                    continue;
                }
                
                const userToken = tokenData.fcmToken;
                
                // Check if token was already used in this run (after cleanup, this should be rare)
                if (processedTokens.has(userToken)) {
                    console.log(`   ⚠️ Token already used for another user in this run`);
                    console.log(`   ℹ️ This might indicate a cleanup issue`);
                    skippedCount++;
                    continue;
                }
                processedTokens.add(userToken);
                
                // 5. Fetch weather (use cache if available)
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
                
                // 6. Send notification
                const success = await sendWeatherNotificationToUser(userId, userCity, weatherData, false);
                
                if (success) {
                    successCount++;
                    
                    // Update last notification time
                    await db.ref(`last_notification/${userId}`).set({
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
            },
            cleanup: cleanupResult
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
                rateLimitEnabled: false,
                cooldownMinutes: 0
            },
            cleanup: cleanupResult,
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

// ==================== NEW: CHECK USER STATUS ====================
async function checkUserStatus(userId) {
    try {
        console.log(`🔍 Checking status for user: ${userId.substring(0, 8)}...`);
        
        // Get user data
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        const userData = userSnapshot.val();
        
        // Get device data
        const devicesRef = db.ref(`user_tokens/${userId}/devices`);
        const devicesSnapshot = await devicesRef.once('value');
        const devices = devicesSnapshot.val();
        
        // Get old token format
        const tokenRef = db.ref(`user_tokens/${userId}`);
        const tokenSnapshot = await tokenRef.once('value');
        const tokenData = tokenSnapshot.val();
        
        // Check if should receive weather
        const shouldReceive = await shouldSendWeatherToUser(userId);
        
        return {
            userId: userId.substring(0, 8) + '...',
            userExists: !!userData,
            userData: userData ? {
                preferredCity: userData.preferredCity,
                lastLogin: userData.lastLogin ? new Date(userData.lastLogin).toISOString() : null,
                lastLogout: userData.lastLogout ? new Date(userData.lastLogout).toISOString() : null,
                isActive: userData.isActive,
                hasCity: !!(userData.preferredCity && userData.preferredCity !== 'undefined' && userData.preferredCity !== 'null')
            } : null,
            devices: devices ? Object.keys(devices).length : 0,
            deviceDetails: devices ? Object.entries(devices).map(([deviceId, device]) => ({
                deviceId: deviceId.substring(0, 8) + '...',
                isActive: device.isActive,
                loggedInAt: device.loggedInAt ? new Date(device.loggedInAt).toISOString() : null,
                loggedOutAt: device.loggedOutAt ? new Date(device.loggedOutAt).toISOString() : null,
                hasToken: !!device.fcmToken
            })) : [],
            oldTokenFormat: tokenData?.fcmToken ? {
                hasToken: true,
                tokenPreview: tokenData.fcmToken.substring(0, 20) + '...'
            } : { hasToken: false },
            shouldReceiveWeather: shouldReceive,
            issues: []
        };
        
    } catch (error) {
        console.error('❌ Error checking user status:', error);
        return {
            error: error.message,
            userId: userId.substring(0, 8) + '...'
        };
    }
}

// ==================== UPDATED: RUN FULL CLEANUP ====================
async function runFullCleanup() {
    console.log('\n🧹 RUNNING FULL CLEANUP...');
    
    const results = {
        timestamp: new Date().toISOString(),
        steps: []
    };
    
    try {
        // Step 1: Clean duplicate tokens
        console.log('\n1️⃣ Cleaning duplicate tokens...');
        const tokenResult = await cleanDuplicateTokens();
        results.steps.push({
            name: 'Duplicate Tokens',
            result: tokenResult
        });
        
        // Step 2: Clean empty entries
        console.log('\n2️⃣ Cleaning empty entries...');
        const emptyResult = await cleanEmptyTokenEntries();
        results.steps.push({
            name: 'Empty Entries',
            result: emptyResult
        });
        
        // Step 3: Clean invalid cities
        console.log('\n3️⃣ Cleaning invalid cities...');
        const cityResult = await cleanInvalidCityUsers();
        results.steps.push({
            name: 'Invalid Cities',
            result: cityResult
        });
        
        // Step 4: Clean inactive devices
        console.log('\n4️⃣ Cleaning inactive devices...');
        const inactiveResult = await cleanupInactiveDevices();
        results.steps.push({
            name: 'Inactive Devices',
            result: inactiveResult
        });
        
        // Step 5: Debug current state
        console.log('\n5️⃣ Debugging current state...');
        await debugTokenStorage();
        await debugUserTokens();
        await debugDuplicateUsers();
        
        results.summary = 'Full cleanup completed successfully';
        results.success = true;
        
        return results;
        
    } catch (error) {
        console.error('❌ Cleanup error:', error);
        results.success = false;
        results.error = error.message;
        return results;
    }
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
                
            case 'cleanup':
                // Check secret for cleanup operations
                if (secret !== process.env.CRON_SECRET) {
                    return res.status(401).json({ error: 'Unauthorized - secret required' });
                }
                const cleanupResult = await runFullCleanup();
                return res.status(200).json(cleanupResult);
                
            case 'fix-issue':
                // Combined cleanup and diagnose
                if (secret !== process.env.CRON_SECRET) {
                    return res.status(401).json({ error: 'Unauthorized - secret required' });
                }
                console.log('🛠️ Running combined fix...');
                const fixResult = await runFullCleanup();
                const diagnoseAfterFix = await diagnoseDuplicateIssue();
                return res.status(200).json({
                    cleanup: fixResult,
                    diagnosis: diagnoseAfterFix,
                    message: 'Fix applied successfully'
                });
                
            case 'check-user-status':
                if (!userId) {
                    return res.status(400).json({ error: 'userId required' });
                }
                const statusResult = await checkUserStatus(userId);
                return res.status(200).json(statusResult);
                
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
                    features: [
                        'Token deduplication',
                        'Automatic cleanup',
                        'Weather caching',
                        'Job overlap prevention',
                        'Inactive device cleanup',
                        'Active user filtering'
                    ],
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
                            'Automatic token cleanup',
                            'Inactive device cleanup',
                            'User activity tracking'
                        ],
                        endpoints: [
                            'GET / - This info',
                            'POST {action: "test", userId: "..."} - Send test',
                            'POST {action: "quick-test"} - Weather only',
                            'POST {action: "diagnose"} - Debug duplicates',
                            'POST {action: "cleanup", secret: "..."} - Run cleanup',
                            'POST {action: "fix-issue", secret: "..."} - Fix all issues',
                            'POST {action: "check-user-status", userId: "..."} - Check user status',
                            'POST {action: "status"} - Service status'
                        ],
                        timestamp: new Date().toISOString()
                    });
                }
                
                return res.status(200).json({
                    message: 'Weather cron service is running',
                    features: 'Automatic cleanup enabled with active user filtering',
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