// ========================================
// Environment Variable Loader
// ========================================
// This MUST be the first module loaded by server.js
// to ensure all environment variables are available
// before any other module reads process.env

const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// Try to find and load .env from multiple possible locations
const envCandidates = [
  path.resolve(__dirname, '..', '.env'),           // backend/.env
  path.resolve(__dirname, '..', '..', '.env'),     // project root/.env
  path.resolve(process.cwd(), '.env'),             // current working directory/.env
];

let loadedFrom = null;
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    const result = dotenv.config({ path: envPath });
    if (result.error) {
      console.error(`[ENV] Failed to load from ${envPath}:`, result.error.message);
    } else {
      loadedFrom = envPath;
      break;
    }
  }
}

if (loadedFrom) {
  console.log(`[ENV] ✅ Loaded from: ${loadedFrom}`);
} else {
  console.warn('[ENV] ⚠️  No .env file found. Using process.env only.');
}

// Validate critical environment variables
function validateEnv() {
  const checks = {
    // Platform auth
    SESSION_SECRET: !!process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length > 0,
    SUPERADMIN_EMAIL: !!process.env.SUPERADMIN_EMAIL && process.env.SUPERADMIN_EMAIL.trim().length > 0,
    SUPERADMIN_PASSWORD_BCRYPT: !!process.env.SUPERADMIN_PASSWORD_BCRYPT && process.env.SUPERADMIN_PASSWORD_BCRYPT.trim().length > 0,

    // Database (optional - will work with mock data if missing)
    DB_SERVER: !!process.env.DB_SERVER,
    DB_NAME: !!process.env.DB_NAME,
  };

  const missing = Object.entries(checks)
    .filter(([key, exists]) => !exists && ['SESSION_SECRET', 'SUPERADMIN_EMAIL', 'SUPERADMIN_PASSWORD_BCRYPT'].includes(key))
    .map(([key]) => key);

  if (missing.length > 0) {
    console.warn('[ENV] ⚠️  Missing required environment variables:', missing.join(', '));
    console.warn('[ENV] Platform admin authentication will not work until these are set.');
  } else {
    console.log('[ENV] ✅ All required platform variables present');
  }

  return checks;
}

// Export validation results
const envStatus = validateEnv();

module.exports = {
  loadedFrom,
  envStatus,
  isReady: envStatus.SESSION_SECRET && envStatus.SUPERADMIN_EMAIL && envStatus.SUPERADMIN_PASSWORD_BCRYPT,
};
