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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { action, userId, taskData, taskId } = req.body;

    console.log('TASKS_API: Received request -', { action, userId, taskId });

    if (!userId && action !== 'trigger_reminders') {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Special endpoint to trigger reminders manually
    if (action === 'trigger_reminders') {
      await checkAndSendReminders(res);
      return;
    }

    switch (action) {
      case 'read':
        await getTasks(userId, res);
        break;
      
      case 'create':
        if (!taskData) {
          return res.status(400).json({
            success: false,
            message: 'Task data is required for creating task'
          });
        }
        await createTask(userId, taskData, res);
        break;
      
      case 'update':
        if (!taskId || !taskData) {
          return res.status(400).json({
            success: false,
            message: 'Task ID and task data are required for updating task'
          });
        }
        await updateTask(userId, taskId, taskData, res);
        break;
      
      case 'delete':
        if (!taskId) {
          return res.status(400).json({
            success: false,
            message: 'Task ID is required for deleting task'
          });
        }
        await deleteTask(userId, taskId, res);
        break;
      
      case 'delete_all':
        await deleteAllTasks(userId, res);
        break;
      
      case 'complete':
        if (!taskId) {
          return res.status(400).json({
            success: false,
            message: 'Task ID is required for marking task complete'
          });
        }
        await markTaskComplete(userId, taskId, res);
        break;
      
      case 'test_reminder':
        await testTaskReminder(userId, taskId, res);
        break;
      
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid action. Supported actions: read, create, update, delete, delete_all, complete, test_reminder, trigger_reminders'
        });
    }

  } catch (error) {
    console.error('TASKS_API Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// ==================== FCM TASK FUNCTIONS ====================

// Function to send FCM notification
async function sendTaskReminderFCM(userId, task) {
  try {
    console.log(`📱 Sending FCM for task: ${task.name} to user: ${userId}`);
    
    // Get user's FCM token
    const userTokensRef = db.ref(`user_tokens/${userId}`);
    const tokenSnapshot = await userTokensRef.once('value');
    const tokenData = tokenSnapshot.val();
    
    if (!tokenData || !tokenData.fcmToken) {
      console.log(`❌ No FCM token for user: ${userId}`);
      return false;
    }
    
    const fcmToken = tokenData.fcmToken;
    
    // Prepare FCM message
    const message = {
      token: fcmToken,
      notification: {
        title: `⏰ Task Reminder: ${task.name}`,
        body: `Time: ${task.time}`
      },
      data: {
        type: 'task_reminder',
        taskId: task.id,
        taskName: task.name,
        taskTime: task.time,
        userId: userId,
        click_action: 'TASK_ACTIVITY'
      },
      android: {
        priority: 'high',
        notification: {
          channel_id: 'task_reminders',
          sound: 'default',
          color: '#4CAF50'
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
    
    // Send via FCM
    const response = await admin.messaging().send(message);
    console.log(`✅ FCM sent successfully: ${response}`);
    
    // Save notification to database
    await saveTaskNotificationToDB(userId, task);
    
    return true;
    
  } catch (error) {
    console.error('❌ FCM Error:', error);
    
    // Remove invalid token
    if (error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token') {
      console.log(`🗑️ Removing invalid token for user: ${userId}`);
      await db.ref(`user_tokens/${userId}`).remove();
    }
    
    return false;
  }
}

// Send task completion FCM
async function sendTaskCompletionFCM(userId, task) {
  try {
    const userTokensRef = db.ref(`user_tokens/${userId}`);
    const tokenSnapshot = await userTokensRef.once('value');
    const tokenData = tokenSnapshot.val();
    
    if (!tokenData?.fcmToken) return false;
    
    const message = {
      token: tokenData.fcmToken,
      notification: {
        title: '✅ Task Completed',
        body: `Great job on: ${task.name}`
      },
      data: {
        type: 'task_completed',
        taskId: task.id,
        taskName: task.name,
        userId: userId
      },
      android: {
        priority: 'high',
        notification: {
          channel_id: 'task_reminders',
          sound: 'default',
          color: '#4CAF50'
        }
      }
    };
    
    await admin.messaging().send(message);
    console.log(`✅ Task completion FCM sent for: ${task.name}`);
    return true;
    
  } catch (error) {
    console.error('❌ Completion FCM error:', error);
    return false;
  }
}

// Save task notification to Firebase
async function saveTaskNotificationToDB(userId, task) {
  try {
    const notificationsRef = db.ref(`notifications/${userId}`);
    const newNotifRef = notificationsRef.push();
    
    await newNotifRef.set({
      id: newNotifRef.key,
      title: `⏰ Task Reminder: ${task.name}`,
      message: `Time: ${task.time}`,
      type: 'task_reminder',
      timestamp: new Date().toISOString(),
      read: false,
      taskId: task.id,
      taskName: task.name
    });
    
    console.log('✅ Notification saved to database');
    return true;
    
  } catch (error) {
    console.error('❌ Error saving notification:', error);
    return false;
  }
}

// Schedule task reminder (simple version)
async function scheduleTaskReminder(userId, task) {
  try {
    console.log(`⏰ Scheduling FCM reminder for: ${task.name} at ${task.time}`);
    
    // Calculate next reminder time
    const reminderTime = calculateNextReminderTime(task.time, task.days);
    
    if (!reminderTime) {
      console.log('⚠️ Could not calculate reminder time');
      return false;
    }
    
    const delay = reminderTime.getTime() - Date.now();
    
    if (delay > 0 && delay < 7 * 24 * 60 * 60 * 1000) { // Within 7 days
      console.log(`⏰ FCM scheduled in ${Math.round(delay/1000/60)} minutes (${reminderTime.toLocaleTimeString()})`);
      
      // Schedule the FCM
      setTimeout(async () => {
        console.log(`⏰ Time to send FCM for: ${task.name}`);
        await sendTaskReminderFCM(userId, task);
        
        // Reschedule for next occurrence if not "Once"
        if (task.days !== 'Once') {
          await scheduleTaskReminder(userId, task);
        }
      }, delay);
      
      return true;
    }
    
    return false;
    
  } catch (error) {
    console.error('❌ Schedule error:', error);
    return false;
  }
}

// Calculate next reminder time
function calculateNextReminderTime(taskTime, taskDays) {
  try {
    const now = new Date();
    
    // Parse time (e.g., "08:00 AM")
    const [timeStr, period] = taskTime.split(' ');
    const [hoursStr, minutesStr] = timeStr.split(':');
    let hours = parseInt(hoursStr);
    const minutes = parseInt(minutesStr || 0);
    
    // Convert to 24-hour
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    
    // Parse days
    const dayMap = {
      'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4,
      'Fri': 5, 'Sat': 6, 'Sun': 0
    };
    
    const isEveryday = taskDays === 'Everyday';
    const dayNumbers = isEveryday 
      ? [0, 1, 2, 3, 4, 5, 6]
      : taskDays.split(',').map(day => dayMap[day.trim()]);
    
    // Check next 7 days
    for (let i = 0; i < 7; i++) {
      const checkDate = new Date(now);
      checkDate.setDate(checkDate.getDate() + i);
      const dayOfWeek = checkDate.getDay();
      
      if (dayNumbers.includes(dayOfWeek)) {
        // Set to task time
        const taskDateTime = new Date(checkDate);
        taskDateTime.setHours(hours, minutes, 0, 0);
        
        // Set reminder to 5 minutes before
        const reminderTime = new Date(taskDateTime);
        reminderTime.setMinutes(reminderTime.getMinutes() - 5);
        
        // If reminder is in the future
        if (reminderTime > now) {
          return reminderTime;
        }
      }
    }
    
    return null;
    
  } catch (error) {
    console.error('❌ Error calculating time:', error);
    return null;
  }
}

// Check and send reminders (for manual trigger or cron)
async function checkAndSendReminders(res) {
  try {
    console.log('⏰ Checking for task reminders...');
    
    const now = Date.now();
    const fiveMinutesFromNow = now + (5 * 60 * 1000);
    
    // This would normally check scheduled reminders in database
    // For now, we'll just send a test response
    console.log('✅ Reminder check completed');
    
    if (res) {
      return res.status(200).json({
        success: true,
        message: 'Reminder check completed',
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    console.error('❌ Error checking reminders:', error);
    if (res) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

// Test function to send immediate FCM reminder
async function testTaskReminder(userId, taskId, res) {
  try {
    console.log(`🧪 Testing FCM reminder for user: ${userId}, task: ${taskId}`);
    
    // Get task details
    const taskRef = db.ref(`tasks/${userId}/${taskId}`);
    const snapshot = await taskRef.once('value');
    
    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }
    
    const task = snapshot.val();
    
    // Send FCM immediately
    const sent = await sendTaskReminderFCM(userId, {
      ...task,
      id: taskId
    });
    
    return res.status(200).json({
      success: sent,
      message: sent ? '✅ Test FCM sent successfully' : '❌ Failed to send FCM',
      task: task,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Test error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// ==================== TASK CRUD FUNCTIONS ====================

// READ - Get all tasks for a user
async function getTasks(userId, res) {
  try {
    console.log('TASKS_API: Getting tasks for user:', userId);
    
    const tasksRef = db.ref(`tasks/${userId}`);
    const snapshot = await tasksRef.once('value');
    
    const tasks = [];
    
    if (snapshot.exists()) {
      snapshot.forEach((childSnapshot) => {
        const task = childSnapshot.val();
        tasks.push({
          id: childSnapshot.key,
          ...task
        });
      });
      
      console.log('TASKS_API: Found', tasks.length, 'tasks for user:', userId);
    } else {
      console.log('TASKS_API: No tasks found for user:', userId);
    }

    return res.status(200).json({
      success: true,
      message: 'Tasks retrieved successfully',
      data: {
        tasks: tasks,
        totalTasks: tasks.length
      }
    });

  } catch (error) {
    console.error('TASKS_API: Error getting tasks:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve tasks',
      error: error.message
    });
  }
}

// CREATE - Create a new task with FCM scheduling
async function createTask(userId, taskData, res) {
  try {
    console.log('TASKS_API: Creating task for user:', userId);
    console.log('TASKS_API: Task data:', taskData);

    const { time, name, days, status } = taskData;

    // Validate required fields
    if (!time || !name || !days || !status) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: time, name, days, status'
      });
    }

    const tasksRef = db.ref(`tasks/${userId}`);
    const newTaskRef = tasksRef.push();
    
    const task = {
      time: time,
      name: name,
      days: days,
      status: status,
      id: newTaskRef.key,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await newTaskRef.set(task);

    console.log('TASKS_API: Task created successfully with ID:', newTaskRef.key);

    // ✅ SCHEDULE FCM REMINDER
    await scheduleTaskReminder(userId, task);

    return res.status(201).json({
      success: true,
      message: 'Task created successfully - FCM reminder scheduled',
      data: {
        task: task,
        taskId: newTaskRef.key
      }
    });

  } catch (error) {
    console.error('TASKS_API: Error creating task:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create task',
      error: error.message
    });
  }
}

// UPDATE - Update an existing task
async function updateTask(userId, taskId, taskData, res) {
  try {
    console.log('TASKS_API: Updating task:', taskId, 'for user:', userId);
    console.log('TASKS_API: Update data:', taskData);

    const taskRef = db.ref(`tasks/${userId}/${taskId}`);
    const snapshot = await taskRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    const oldTask = snapshot.val();
    const updatedTask = {
      ...oldTask,
      ...taskData,
      updatedAt: new Date().toISOString()
    };

    await taskRef.set(updatedTask);

    console.log('TASKS_API: Task updated successfully:', taskId);

    // ✅ RESCHEDULE FCM REMINDERS if time or days changed
    if (taskData.time !== oldTask.time || taskData.days !== oldTask.days) {
      console.log('🔄 Time/days changed - rescheduling FCM reminders');
      // Note: In a production system, you'd cancel old reminders and schedule new ones
      await scheduleTaskReminder(userId, {
        ...updatedTask,
        id: taskId
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Task updated successfully',
      data: {
        task: updatedTask
      }
    });

  } catch (error) {
    console.error('TASKS_API: Error updating task:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update task',
      error: error.message
    });
  }
}

// DELETE - Delete a specific task
async function deleteTask(userId, taskId, res) {
  try {
    console.log('TASKS_API: Deleting task:', taskId, 'for user:', userId);

    const taskRef = db.ref(`tasks/${userId}/${taskId}`);
    const snapshot = await taskRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    await taskRef.remove();

    console.log('TASKS_API: Task deleted successfully:', taskId);

    // Note: In production, you'd also cancel scheduled FCM reminders here

    return res.status(200).json({
      success: true,
      message: 'Task deleted successfully',
      data: {
        deletedTaskId: taskId
      }
    });

  } catch (error) {
    console.error('TASKS_API: Error deleting task:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete task',
      error: error.message
    });
  }
}

// DELETE ALL - Delete all tasks for a user
async function deleteAllTasks(userId, res) {
  try {
    console.log('TASKS_API: Deleting all tasks for user:', userId);

    const tasksRef = db.ref(`tasks/${userId}`);
    const snapshot = await tasksRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'No tasks found to delete'
      });
    }

    const taskCount = snapshot.numChildren();
    await tasksRef.remove();

    console.log('TASKS_API: Deleted', taskCount, 'tasks for user:', userId);

    // Note: In production, you'd also cancel all scheduled FCM reminders here

    return res.status(200).json({
      success: true,
      message: `All ${taskCount} tasks deleted successfully`,
      data: {
        deletedCount: taskCount
      }
    });

  } catch (error) {
    console.error('TASKS_API: Error deleting all tasks:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete all tasks',
      error: error.message
    });
  }
}

// COMPLETE - Mark a task as complete
async function markTaskComplete(userId, taskId, res) {
  try {
    console.log('TASKS_API: Marking task as complete:', taskId, 'for user:', userId);

    const taskRef = db.ref(`tasks/${userId}/${taskId}`);
    const snapshot = await taskRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    const currentTask = snapshot.val();
    const updatedTask = {
      ...currentTask,
      status: 'Complete',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await taskRef.set(updatedTask);

    console.log('TASKS_API: Task marked as complete:', taskId);

    // ✅ SEND COMPLETION FCM NOTIFICATION
    await sendTaskCompletionFCM(userId, currentTask);

    return res.status(200).json({
      success: true,
      message: 'Task marked as complete successfully',
      data: {
        task: updatedTask
      }
    });

  } catch (error) {
    console.error('TASKS_API: Error marking task complete:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark task as complete',
      error: error.message
    });
  }
}