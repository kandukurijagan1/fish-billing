/**
 * ============================================================================
 * AuthService.gs - Google Apps Script Security & Authentication Module
 * ============================================================================
 */

function getApiSecretKey() {
  var props = PropertiesService.getScriptProperties();
  return props.getProperty("API_SECRET_KEY");
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var result = 0;
  for (var i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function extractRequestToken(e, data) {
  var token = "";
  
  // 1. Check query parameter ?token=... or ?apiKey=... or ?auth=...
  if (e && e.parameter) {
    if (e.parameter.token) token = e.parameter.token;
    else if (e.parameter.apiKey) token = e.parameter.apiKey;
    else if (e.parameter.auth) token = e.parameter.auth;
  }
  
  // 2. Check JSON payload { auth: "...", token: "...", apiKey: "..." }
  if (!token && data && typeof data === 'object') {
    if (data.token) token = data.token;
    else if (data.apiKey) token = data.apiKey;
    else if (data.auth) token = data.auth;
  }
  
  return String(token || "").trim();
}

function authenticateRequest(e, data) {
  var expectedKey = getApiSecretKey();
  var providedToken = extractRequestToken(e, data);

  // If no secret key is configured in Script Properties, fail closed (never allow open access)
  if (!expectedKey) {
    return { 
      ok: false, 
      error: "Server configuration error: 'API_SECRET_KEY' is not configured in Google Apps Script Project Settings -> Script Properties." 
    };
  }

  if (!providedToken) {
    return { 
      ok: false, 
      error: "Unauthorized: Authentication required. Please provide a valid API token in 'auth', 'token', or '?token='." 
    };
  }

  if (!constantTimeEquals(providedToken, expectedKey)) {
    return { 
      ok: false, 
      error: "Unauthorized: Invalid API authentication token." 
    };
  }

  return { ok: true, user: "Authorized_Admin_User" };
}
