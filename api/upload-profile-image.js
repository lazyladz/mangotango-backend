// api/upload-profile-image.js
module.exports = async (req, res) => {
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
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const { userId, imageData } = JSON.parse(body);
        
        if (!userId || !imageData) {
          return res.status(400).json({
            success: false,
            message: 'User ID and image data are required'
          });
        }

        // Validate base64 image data
        if (!imageData.startsWith('data:image/')) {
          return res.status(400).json({
            success: false,
            message: 'Invalid image format. Please provide base64 image data'
          });
        }

        // Check image size (limit to 2MB to prevent database bloat)
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const imageSize = (base64Data.length * 3) / 4; // Approximate size in bytes
        
        if (imageSize > 2 * 1024 * 1024) { // 2MB limit
          return res.status(400).json({
            success: false,
            message: 'Image too large. Please use images smaller than 2MB'
          });
        }

        // For base64 storage, we just return the base64 string
        // The actual storage will happen in update-profile API
        // This API just validates and processes the image
        
        return res.status(200).json({
          success: true,
          imageUrl: imageData, // Return the base64 string as "imageUrl"
          message: 'Image processed successfully. Ready to save to profile.'
        });

      } catch (parseError) {
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in request body'
        });
      }
    });

  } catch (error) {
    console.error('Upload image error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process image',
      error: error.message
    });
  }
};