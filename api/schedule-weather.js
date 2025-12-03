// schedule-weather.js (Run hourly via cron job)
const admin = require('firebase-admin');
const axios = require('axios');

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

// Major cities in Philippines
const PH_CITIES = [
  'Manila', 'Quezon City', 'Cebu City', 'Davao City', 
  'Iloilo City', 'Baguio', 'Zamboanga City', 'Taguig', 
  'Pasig', 'Cagayan de Oro'
];

// Check weather and send alerts
async function checkWeatherAndSendAlerts() {
  console.log('⏰ Running hourly weather check...');
  
  for (const city of PH_CITIES) {
    try {
      // Fetch weather
      const WEATHER_API_KEY = process.env.WEATHER_API_KEY || 'fbc049c0ab6883e70eb66f800322b567';
      const url = `https://api.openweathermap.org/data/2.5/weather?q=${city},PH&appid=${WEATHER_API_KEY}&units=metric`;
      
      const response = await axios.get(url);
      const data = response.data;
      
      const temp = Math.round(data.main.temp);
      const condition = data.weather[0].main;
      const humidity = data.main.humidity;
      const windSpeed = data.wind.speed;
      
      // Get pest alerts
      const pests = [];
      if (temp > 28 && condition === 'Sunny') pests.push('Mango hopper');
      if (temp > 25 && condition === 'Cloudy') pests.push('Mealybug');
      if (temp >= 22 && temp <= 30 && condition === 'Rainy') pests.push('Cecid Fly');
      if (condition === 'Rainy') pests.push('Anthracnose');
      if (temp > 30) pests.push('Leaf Hopper');
      if (condition === 'Rainy' && temp > 25) pests.push('Fungal diseases');
      if (condition === 'Sunny' && temp > 32) pests.push('Heat stress');
      
      // Check if notification is needed
      const needsNotification = pests.length > 0 || 
                               condition === 'Thunderstorm' || 
                               temp > 35 || 
                               temp < 15 ||
                               windSpeed > 10;
      
      if (needsNotification) {
        console.log(`⚠️ Sending weather alert for ${city}:`, { temp, condition, pests });
        await sendWeatherAlert(city, { temp, condition, humidity, windSpeed, pests });
      } else {
        console.log(`✅ ${city}: No alerts needed (${temp}°C, ${condition})`);
      }
      
    } catch (error) {
      console.error(`❌ Error checking ${city}:`, error.message);
    }
  }
}

// Send weather alert to all users
async function sendWeatherAlert(city, weatherData) {
  try {
    // Get all users
    const usersRef = db.ref('user_tokens');
    const usersSnapshot = await usersRef.once('value');
    const users = usersSnapshot.val();
    
    if (!users) {
      console.log('❌ No users found');
      return;
    }
    
    const currentTime = new Date().toLocaleTimeString('en-PH', { 
      hour: '2-digit', 
      minute: '2-digit',
      timeZone: 'Asia/Manila'
    });
    
    const userIds = Object.keys(users);
    console.log(`📢 Sending to ${userIds.length} users`);
    
    for (const userId of userIds) {
      const userToken = users[userId].fcmToken;
      
      if (!userToken) continue;
      
      const message = {
        token: userToken,
        data: {
          type: 'weather',
          city: city,
          temperature: weatherData.temp.toString(),
          condition: weatherData.condition,
          humidity: weatherData.humidity.toString(),
          wind_speed: weatherData.windSpeed.toString(),
          pests: JSON.stringify(weatherData.pests),
          timestamp: currentTime
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'weather_alerts',
            title: `🌤️ Weather Alert: ${city}`,
            body: `${weatherData.temp}°C | ${weatherData.condition}`
          }
        }
      };
      
      try {
        await admin.messaging().send(message);
        console.log(`✅ Sent to ${userId}`);
      } catch (error) {
        console.error(`❌ Failed to send to ${userId}:`, error.message);
        // Remove invalid token
        if (error.code === 'messaging/registration-token-not-registered') {
          await db.ref(`user_tokens/${userId}`).remove();
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Error sending weather alert:', error);
  }
}

// Run immediately
checkWeatherAndSendAlerts().then(() => {
  console.log('✅ Weather check completed');
  process.exit(0);
}).catch(error => {
  console.error('❌ Weather check failed:', error);
  process.exit(1);
});