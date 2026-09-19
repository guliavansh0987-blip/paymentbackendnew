// Backend/server.js - Production Ready ZetPay Backend Server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const { notFoundHandler } = require('./middleware/errorHandler');
const { generalLimiter } = require('./middleware/rateLimiter');

const app = express();
const PORT = process.env.PORT || 5000;

// Security & Headers
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CORS configuration (supports panel, store, local dev, and any allowed origins)
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Always allow standard origins
allowedOrigins.push(
  'https://panel.zetpay.online',
  'https://zetpay.online',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500'
);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }
      return callback(null, true); // Permissive in deployment to avoid blocking merchant widgets
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-token', 'x-api-key']
  })
);

// Request Logging
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Body Parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global Rate Limiter
if (generalLimiter) {
  app.use(generalLimiter);
}

// Health Check Route
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: `${process.env.SITE_NAME || 'ZetPay'} API Server is running`,
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'UP', timestamp: Date.now() });
});

// Mount Routes
app.use('/api/config', require('./routes/config'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/user', require('./routes/user'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/payment-link', require('./routes/paymentLink'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/withdrawal', require('./routes/withdrawal'));
app.use('/api/developer', require('./routes/developer'));
app.use('/api/store', require('./routes/store'));
app.use('/api/store-public', require('./routes/storePublic'));
app.use('/api/support', require('./routes/support'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/referral', require('./routes/referral'));
app.use('/api/notification', require('./routes/notification'));
app.use('/api/otp', require('./routes/otp'));
app.use('/api/promo', require('./routes/promo'));
app.use('/api/history', require('./routes/history'));
app.use('/api/fampay', require('./routes/fampay'));
app.use('/api/paytm', require('./routes/paytm'));
app.use('/api/sms', require('./routes/sms'));
app.use('/api/agent', require('./routes/agent'));
app.use('/api/gateway-test', require('./routes/gatewayTest'));
app.use('/api/webhook', require('./routes/webhook'));

// 404 & Error Handlers
app.use(notFoundHandler);
app.use(errorHandler);

// Only listen if not imported as a serverless module (Vercel)
if (process.env.VERCEL !== '1' && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, () => {
    logger.info(`🚀 ZetPay Backend Server listening on port ${PORT}`);
    console.log(`🚀 ZetPay Backend listening on http://localhost:${PORT}`);
  });
}

// Export for cPanel Passenger and Vercel Serverless
module.exports = app;
