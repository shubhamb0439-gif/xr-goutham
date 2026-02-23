const { Sequelize } = require('sequelize');

let sequelize = null;

function getAzureSqlConnection() {
  if (sequelize) return sequelize;

  const dbServer = process.env.DB_SERVER;
  const dbName = process.env.DB_NAME;
  const dbPort = parseInt(process.env.DB_PORT || '1433', 10);
  const dbClientId = process.env.DB_CLIENT_ID;
  const dbClientSecret = process.env.DB_CLIENT_SECRET;
  const dbTenantId = process.env.DB_TENANT_ID;
  const debugDb = (process.env.DEBUG_DB || 'false').toLowerCase() === 'true';

  if (!dbServer || !dbName) {
    if (debugDb) {
      console.warn('[AZURE_DB] Missing DB_SERVER or DB_NAME. Running in mock mode.');
    }
    return null;
  }

  const azureEnv = process.env.AZURE_ENV;

  try {
    if (azureEnv === 'DEVELOPMENT' || azureEnv === 'PRODUCTION' || azureEnv === 'STAGING') {
      const clientIdMI = process.env.AZURE_CLIENT_ID_MI;
      sequelize = new Sequelize(dbName, clientIdMI, '', {
        host: dbServer,
        port: dbPort,
        dialect: 'mssql',
        dialectOptions: {
          authentication: {
            type: 'azure-active-directory-msi-app-service',
            options: {
              clientId: clientIdMI,
            },
          },
          encrypt: true,
        },
        logging: debugDb ? console.log : false,
      });

      if (debugDb) {
        console.log(`[AZURE_DB] Configured with Managed Identity for ${azureEnv}`);
      }
    } else {
      if (!dbClientId || !dbClientSecret || !dbTenantId) {
        if (debugDb) {
          console.warn('[AZURE_DB] Missing client credentials. Running in mock mode.');
        }
        return null;
      }

      sequelize = new Sequelize(dbName, dbClientId, dbClientSecret, {
        host: dbServer,
        port: dbPort,
        dialect: 'mssql',
        dialectOptions: {
          authentication: {
            type: 'azure-active-directory-service-principal-secret',
            options: {
              clientId: dbClientId,
              clientSecret: dbClientSecret,
              tenantId: dbTenantId,
            },
          },
          encrypt: true,
        },
        logging: debugDb ? console.log : false,
      });

      if (debugDb) {
        console.log('[AZURE_DB] Configured with Service Principal credentials');
      }
    }

    return sequelize;
  } catch (err) {
    console.error('[AZURE_DB] Configuration error:', err.message);
    return null;
  }
}

async function testConnection() {
  const conn = getAzureSqlConnection();
  if (!conn) {
    console.warn('[AZURE_DB] No connection available (mock mode)');
    return false;
  }

  try {
    await conn.authenticate();
    console.log('[AZURE_DB] Connection test successful');
    return true;
  } catch (err) {
    console.error('[AZURE_DB] Connection test failed:', err.message);
    return false;
  }
}

async function closeConnection() {
  if (sequelize) {
    try {
      await sequelize.close();
      console.log('[AZURE_DB] Connection closed');
      sequelize = null;
    } catch (err) {
      console.error('[AZURE_DB] Error closing connection:', err.message);
    }
  }
}

module.exports = {
  getAzureSqlConnection,
  testConnection,
  closeConnection,
};
