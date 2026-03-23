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
    new transports.File({
      filename: path.join(logsDir, 'trades.log'),
      level: 'info',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 10,
      tailable: true,
      format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), fileFormat)
    }),
    new transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 10,
      tailable: true,
      format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), fileFormat)
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
