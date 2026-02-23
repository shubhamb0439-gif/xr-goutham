# Platform Admin Feature

This document describes the Super Admin `/platform` feature added to the XR Messaging System.

## Overview

The platform admin feature provides a secure, environment-variable-based authentication system for Super Admin access. It is designed to work with both dummy credentials (for preview/development) and real Azure SQL Database credentials (for production).

## Features

- **Environment-based Authentication**: No signup; credentials come from `.env` only
- **Session Management**: Secure HTTP-only session cookies
- **Azure SQL Integration**: Connects to existing Azure SQL database using Azure AD authentication
- **Graceful Fallback**: Works in mock mode when database is unavailable
- **Protected Routes**: Middleware to secure admin-only endpoints

## File Structure

### New Files Added

```
frontend/
  views/
    platform.html              # Platform admin UI
  public/
    js/
      platform.js               # Platform frontend logic

backend/
  database/
    azure-db-helper.js          # Azure SQL connection helper

.env                            # Environment configuration (updated)
```

### Modified Files

- `backend/server.js` - Added platform routes and session middleware
- `backend/package.json` - Added bcryptjs and express-session dependencies

## Environment Variables

Add these variables to `.env`:

```bash
# Session Secret
SESSION_SECRET=your_secure_session_secret_here

# Super Admin Credentials
SUPERADMIN_EMAIL=super@xrbase.local
SUPERADMIN_PASSWORD_BCRYPT=$2b$10$mIclBHrvJSw0./tz9qBNTe9HJFapY6BbmJwZfa8lakOR3kGDR0iFW

# Azure SQL Database (already exists)
DB_ENGINE=mssql
DB_NAME=XRbase
DB_PORT=1433
DB_CLIENT_ID=your-client-id
DB_CLIENT_SECRET=your-client-secret
DB_TENANT_ID=your-tenant-id
DB_SERVER=your-server.database.windows.net
DEBUG_DB=false
```

### Generating Password Hash

To generate a new bcrypt hash for the super admin password:

```bash
node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('YourPassword123', 10).then(h => console.log(h));"
```

## API Endpoints

### Public Endpoints

- `GET /platform` - Platform admin UI page

### Authentication Endpoints

- `POST /api/platform/login` - Login with email and password
  ```json
  {
    "email": "super@xrbase.local",
    "password": "Super@123"
  }
  ```

- `GET /api/platform/me` - Get current session info
- `POST /api/platform/logout` - Logout and destroy session

### Protected Endpoints

- `GET /platform/secure/ping` - Test endpoint (requires super admin auth)

## Usage

### Local Development with Dummy Credentials

The system works out-of-the-box with dummy credentials:

1. Start the server:
   ```bash
   npm start
   ```

2. Navigate to `http://localhost:8080/platform`

3. Login with:
   - Email: `super@xrbase.local`
   - Password: `Super@123`

### Production with Real Azure SQL

1. Replace the dummy values in `.env` with your real Azure SQL credentials:
   ```bash
   DB_CLIENT_ID=<your-real-client-id>
   DB_CLIENT_SECRET=<your-real-secret>
   DB_TENANT_ID=<your-real-tenant-id>
   DB_SERVER=<your-server>.database.windows.net
   ```

2. Update the super admin password hash:
   ```bash
   SUPERADMIN_PASSWORD_BCRYPT=<your-generated-hash>
   ```

3. Restart the server - it will automatically connect to Azure SQL

## Database Integration

### Azure AD Authentication

The system supports two authentication modes:

1. **Managed Identity** (for Azure-hosted apps):
   - Set `AZURE_ENV=PRODUCTION` (or `DEVELOPMENT`, `STAGING`)
   - Provide `AZURE_CLIENT_ID_MI`

2. **Service Principal** (for local development):
   - Provide `DB_CLIENT_ID`, `DB_CLIENT_SECRET`, `DB_TENANT_ID`

### Existing Schema

The feature connects to your existing Azure SQL database with these tables:

- `users` - User accounts
- `accessuser` - Access control
- `assignusers` - User assignments
- `levelsuser` - User levels
- `rightsuser` - User permissions
- `statususer` - User statuses
- `typeuser` - User types

**No DDL changes are made.** The platform admin simply connects to read/query existing data.

### Mock Mode

If database credentials are invalid or unavailable:
- The server logs a warning and continues
- Super admin login still works (credentials are env-based)
- Database-dependent features return mock/empty data

## Security

### Best Practices

1. **Never commit real credentials** to version control
2. **Use strong passwords** and rotate regularly
3. **Set secure SESSION_SECRET** in production
4. **Enable HTTPS** in production for secure cookies
5. **Monitor access logs** for suspicious activity

### Session Configuration

Sessions are configured with:
- `httpOnly: true` - Prevents JavaScript access
- `sameSite: 'lax'` - CSRF protection
- `maxAge: 24h` - Auto-logout after 24 hours

## Testing

Test the authentication logic:

```bash
cd backend
node -e "const bcrypt = require('bcryptjs'); const hash = process.env.SUPERADMIN_PASSWORD_BCRYPT; bcrypt.compare('Super@123', hash).then(r => console.log('Valid:', r));"
```

Expected output: `Valid: true`

## Troubleshooting

### Login fails with "Invalid credentials"

- Check `SUPERADMIN_EMAIL` matches exactly (case-insensitive)
- Verify `SUPERADMIN_PASSWORD_BCRYPT` is correctly set
- Ensure `.env` file is being loaded
- Check server logs for `[PLATFORM]` messages

### Database connection errors

- Verify Azure SQL credentials are correct
- Check firewall rules allow your IP
- Confirm the server name format: `<name>.database.windows.net`
- Review `DEBUG_DB=true` logs for details

### Session not persisting

- Ensure `SESSION_SECRET` is set
- Check cookies are enabled in browser
- Verify server is not restarting between requests

## Compatibility

- All existing routes (`/dashboard`, `/scribecockpit`, etc.) remain unchanged
- No impact on WebRTC, Socket.IO, or device connections
- Database operations use existing Sequelize connection pool
- Compatible with Redis adapter for multi-instance deployments

## Future Enhancements

Potential improvements:

- [ ] Admin dashboard with user management
- [ ] Database query interface
- [ ] System metrics and monitoring
- [ ] Role-based access control (multiple admin levels)
- [ ] Audit logging for admin actions
- [ ] Two-factor authentication (2FA)
