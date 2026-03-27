'use strict';
require('dotenv').config();
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, colorize, printf, errors } = format;
const path = require('path');
const fs = require('fs');

const isRailway = !!process.env.RAILWAY_ENVIRONMENT;

const consoleFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}] ${stack || message}`;
});

const fileFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${timestamp} [${level.toUpperCase()}] ${stack || message}${metaStr}`;
});

const loggerTransports = [
  // Console — always on
  new transports.Console({
    format: combine(
      colorize({ all: true }),
      timestamp({ format: 'HH:mm:ss' }),
      consoleFormat
    )
  })
];

if (!isRailway) {
  // File transports only for local dev (Railway filesystem is ephemeral)
  const logsDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  loggerTransports.push(
    // Combined log for all info+ level
    new transports.File({
      filename: path.join(logsDir, 'combined.log'),
      level: 'info',
      maxsize: 10 * 1024 * 1024,  // 10MB
      maxFiles: 10,
      tailable: true,
      format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), fileFormat)
    }),
    // Trades-only log (filter to trade-related messages)
    new transports.File({
      filename: path.join(logsDir, 'trades.log'),
      level: 'info',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 10,
      tailable: true,
      format: combine(
        format((info) => {
          // Only log trade-related messages
          const msg = info.message?.toLowerCase() || '';
          if (msg.includes('trade') || msg.includes('order') || msg.includes('position') || 
              msg.includes('pnl') || msg.includes('fill') || msg.includes('execute')) {
            return info;
          }
          return false;
        })(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), 
        fileFormat
      )
    }),
    // Error log
    new transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 10,
      tailable: true,
      format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), fileFormat)
    }),
    // API calls log (filter to API-related messages)
    new transports.File({
      filename: path.join(logsDir, 'api.log'),
      level: 'info',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
      format: combine(
        format((info) => {
          // Only log API-related messages
          const msg = info.message?.toLowerCase() || '';
          if (msg.includes('api') || msg.includes('request') || msg.includes('response') ||
              msg.includes('gamma') || msg.includes('clob') || msg.includes('polymarket') ||
              msg.includes('retry') || msg.includes('rate limit') || msg.includes('429')) {
            return info;
          }
          return false;
        })(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), 
        fileFormat
      )
    })
  );
}

const logger = createLogger({
  level: 'info',
  format: combine(errors({ stack: true }), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })),
  transports: loggerTransports
});

if (isRailway) {
  logger.info('Running on Railway — file logging disabled, using stdout only');
}

module.exports = logger;
