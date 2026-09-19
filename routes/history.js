const express = require('express');
const router = express.Router();
const { fetchHistory } = require('../controllers/historyController');
const { authenticate } = require('../middleware/auth'); // Import auth

// Ab ye route check karega ki user logged in hai ya nahi
router.post('/fetch', authenticate, fetchHistory);

module.exports = router;
