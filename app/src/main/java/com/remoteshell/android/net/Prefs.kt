package com.remoteshell.android.net

import android.content.Context
import java.util.UUID

/**
 * Lightweight persistent settings, mirroring what the web client keeps in localStorage:
 * the server URL, the auth token, the username, and the session id (so a relaunch
 * resumes the exact same persistent shell).
 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("remote_shell", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString(KEY_SERVER, "") ?: ""
        set(value) = sp.edit().putString(KEY_SERVER, value.trim().trimEnd('/')).apply()

    var token: String
        get() = sp.getString(KEY_TOKEN, "") ?: ""
        set(value) = sp.edit().putString(KEY_TOKEN, value).apply()

    var username: String
        get() = sp.getString(KEY_USER, "") ?: ""
        set(value) = sp.edit().putString(KEY_USER, value).apply()

    /** Saved password — only stored when [saveCredentials] is enabled. */
    var password: String
        get() = sp.getString(KEY_PASS, "") ?: ""
        set(value) = sp.edit().putString(KEY_PASS, value).apply()

    /** Whether to auto-save the server URL, username and password for next launch. */
    var saveCredentials: Boolean
        get() = sp.getBoolean(KEY_SAVE_CREDS, false)
        set(value) = sp.edit().putBoolean(KEY_SAVE_CREDS, value).apply()

    /** Persist or clear the login form fields according to [save]. */
    fun storeCredentials(serverUrl: String, username: String, password: String, save: Boolean) {
        saveCredentials = save
        if (save) {
            this.serverUrl = serverUrl
            this.username = username
            this.password = password
        } else {
            sp.edit()
                .remove(KEY_SERVER)
                .remove(KEY_USER)
                .remove(KEY_PASS)
                .apply()
        }
    }

    /** The persistent session id, generated once and reused so refreshes resume the same shell. */
    val sessionId: String
        get() {
            val existing = sp.getString(KEY_SESSION, null)
            if (!existing.isNullOrEmpty()) return existing
            val fresh = sanitizeSessionId(UUID.randomUUID().toString())
            sp.edit().putString(KEY_SESSION, fresh).apply()
            return fresh
        }

    /** Forget the current session id; a new one is generated on next access (used by "Kill"). */
    fun resetSession() = sp.edit().remove(KEY_SESSION).apply()

    fun clearToken() = sp.edit().remove(KEY_TOKEN).apply()

    companion object {
        private const val KEY_SERVER = "server_url"
        private const val KEY_TOKEN = "token"
        private const val KEY_USER = "username"
        private const val KEY_PASS = "password"
        private const val KEY_SAVE_CREDS = "save_credentials"
        private const val KEY_SESSION = "session_id"

        fun sanitizeSessionId(raw: String): String =
            raw.replace(Regex("[^A-Za-z0-9_-]"), "").take(64)
    }
}
