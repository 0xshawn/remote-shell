package com.remoteshell.android.net

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Result of a login attempt against the remote-shell server. */
sealed class LoginResult {
    data class Success(val token: String) : LoginResult()
    object InvalidCredentials : LoginResult()
    data class Error(val message: String) : LoginResult()
}

/** Result of a change-password attempt. */
sealed class ChangePasswordResult {
    /** Succeeded. [warning] is a non-null server note when the change won't survive a restart. */
    data class Success(val warning: String?) : ChangePasswordResult()
    data class Error(val message: String) : ChangePasswordResult()
}

/**
 * Talks to the remote-shell HTTP API: POST /api/login to obtain an HMAC token, and
 * GET /api/me to check whether a token is still valid (used to tell a token expiry
 * apart from a transient network drop, exactly like the web client does).
 */
class AuthClient(private val http: OkHttpClient) {

    /** POST /api/login -> { token }. */
    fun login(serverUrl: String, username: String, password: String, remember: Boolean): LoginResult {
        val base = serverUrl.trim().trimEnd('/')
        if (base.isEmpty()) return LoginResult.Error("Server URL is empty")
        val body = JSONObject()
            .put("username", username)
            .put("password", password)
            .put("remember", remember)
            .toString()
            .toRequestBody(JSON)
        val req = Request.Builder().url("$base/api/login").post(body).build()
        return try {
            http.newCall(req).execute().use { res ->
                when {
                    res.code == 401 -> LoginResult.InvalidCredentials
                    !res.isSuccessful -> LoginResult.Error("HTTP ${res.code}")
                    else -> {
                        val token = JSONObject(res.body?.string() ?: "{}").optString("token")
                        if (token.isEmpty()) LoginResult.Error("No token in response")
                        else LoginResult.Success(token)
                    }
                }
            }
        } catch (e: Exception) {
            LoginResult.Error(e.message ?: "Network error")
        }
    }

    /**
     * GET /api/me with a Bearer token.
     * @return true if valid, false if the server rejected it (401), null on network error.
     */
    fun verifyToken(serverUrl: String, token: String): Boolean? {
        val base = serverUrl.trim().trimEnd('/')
        if (base.isEmpty() || token.isEmpty()) return false
        val req = Request.Builder()
            .url("$base/api/me")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        return try {
            http.newCall(req).execute().use { res ->
                if (res.code == 401) false else res.isSuccessful
            }
        } catch (e: Exception) {
            null // network error: keep the token, let reconnect logic retry
        }
    }

    /** POST /api/password with a Bearer token. Returns Success (with optional warning) or Error. */
    fun changePassword(serverUrl: String, token: String, oldPassword: String, newPassword: String): ChangePasswordResult {
        val base = serverUrl.trim().trimEnd('/')
        if (base.isEmpty() || token.isEmpty()) return ChangePasswordResult.Error("Not signed in")
        val body = JSONObject()
            .put("oldPassword", oldPassword)
            .put("newPassword", newPassword)
            .toString()
            .toRequestBody(JSON)
        val req = Request.Builder()
            .url("$base/api/password")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        return try {
            http.newCall(req).execute().use { res ->
                val json = JSONObject(res.body?.string() ?: "{}")
                if (res.isSuccessful) {
                    val warn = json.optString("warning").ifEmpty { null }
                    ChangePasswordResult.Success(warn)
                } else {
                    ChangePasswordResult.Error(json.optString("error").ifEmpty { "HTTP ${res.code}" })
                }
            }
        } catch (e: Exception) {
            ChangePasswordResult.Error(e.message ?: "Network error")
        }
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
