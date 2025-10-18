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

  try {
    const { action, userId, taskData, taskId } = req.body;

    console.log('TASKS_API: Received request -', { action, userId, taskId });

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
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
      
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid action. Supported actions: read, create, update, delete, delete_all, complete'
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

// CREATE - Create a new task
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

    return res.status(201).json({
      success: true,
      message: 'Task created successfully',
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

    const updatedTask = {
      ...snapshot.val(),
      ...taskData,
      updatedAt: new Date().toISOString()
    };

    await taskRef.set(updatedTask);

    console.log('TASKS_API: Task updated successfully:', taskId);

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