// backend/db/database-config.js
require('dotenv').config();
const { Sequelize } = require('sequelize');

let sequelize; // Primary database only

const AZURE_ENV = process.env.AZURE_ENV;

// Create ONLY the Primary DB connection
if (AZURE_ENV === 'DEVELOPMENT' || AZURE_ENV === 'PRODUCTION' || AZURE_ENV === 'STAGING') {
  // Managed Identity (User Assigned) - Primary Database
  sequelize = new Sequelize(process.env.DB_NAME, process.env.AZURE_CLIENT_ID_MI, '', {
    host: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT, 10),
    dialect: 'mssql',
    dialectOptions: {
      authentication: {
        type: 'azure-active-directory-msi-app-service',
        options: { clientId: process.env.AZURE_CLIENT_ID_MI },
      },
      encrypt: true,
    },
    logging: false, 
  });
} else {
  // Service Principal (local/dev fallback) - Primary Database
  sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_CLIENT_ID,
    process.env.DB_CLIENT_SECRET,
    {
      host: process.env.DB_SERVER,
      port: parseInt(process.env.DB_PORT, 10),
      dialect: 'mssql',
      dialectOptions: {
        authentication: {
          type: 'azure-active-directory-service-principal-secret',
          options: {
            clientId: process.env.DB_CLIENT_ID,
            clientSecret: process.env.DB_CLIENT_SECRET,
            tenantId: process.env.DB_TENANT_ID,
          },
        },
        encrypt: true,
      },
      logging: false,
    }
  );
}

// Call this once during server bootstrap
async function connectToDatabase() {
  try {
    await sequelize.authenticate();
    console.log('✅ Primary database connected successfully');

    // Keep this only if you actually use Sequelize models & want sync
    await sequelize.sync({ alter: false });
    console.log('✅ Primary database synced');
  } catch (err) {
    console.error('❌ Database connection/sync error:', err);
    throw err;
  }
}

async function closeDatabase() {
  try {
    await sequelize.close();
    console.log('🛑 Primary database connection closed');
  } catch (err) {
    console.error('Error closing database connection:', err);
  }
}

module.exports = { sequelize, connectToDatabase, closeDatabase };