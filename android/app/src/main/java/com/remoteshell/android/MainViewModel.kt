package com.remoteshell.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.remoteshell.android.net.AuthClient
import com.remoteshell.android.net.HttpClients
import com.remoteshell.android.net.LoginResult
import com.remoteshell.android.net.Prefs
import com.remoteshell.android.term.ConnStatus
import com.remoteshell.android.term.Modifiers
import com.remoteshell.android.term.SessionController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Screen { LOGIN, TERMINAL }

data class UiState(
    val screen: Screen = Screen.LOGIN,
    val booting: Boolean = true,
    val status: ConnStatus = ConnStatus.OFFLINE,
    val sessionLabel: String = "",
    val modifiers: Modifiers = Modifiers(),
    val serverUrl: String = "",
    val username: String = "",
    val password: String = "",
    val saveCredentials: Boolean = false,
    val loggingIn: Boolean = false,
    val loginError: String? = null,
    val darkTheme: Boolean = true,
)

/**
 * Top-level state holder. Owns the [Prefs] / [AuthClient] / [SessionController] and drives
 * the login -> terminal flow, mirroring the web client's boot logic: a stored token is
 * verified before reconnecting; an expired one bounces back to the login screen.
 */
class MainViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = Prefs(app)
    private val auth = AuthClient(HttpClients.build(forWebSocket = false))

    private val _state = MutableStateFlow(
        UiState(
            serverUrl = prefs.serverUrl,
            username = prefs.username,
            password = prefs.password,
            saveCredentials = prefs.saveCredentials,
            darkTheme = prefs.darkTheme,
        ),
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    var controller: SessionController? = null
        private set

    init {
        bootstrap()
    }

    private fun bootstrap() {
        if (prefs.token.isEmpty() || prefs.serverUrl.isEmpty()) {
            _state.update { it.copy(screen = Screen.LOGIN, booting = false) }
            return
        }
        viewModelScope.launch {
            val valid = withContext(Dispatchers.IO) { auth.verifyToken(prefs.serverUrl, prefs.token) }
            if (valid == false) {
                prefs.clearToken()
                _state.update { it.copy(screen = Screen.LOGIN, booting = false) }
            } else {
                enterTerminal()
            }
        }
    }

    fun login(serverUrl: String, username: String, password: String, save: Boolean) {
        if (_state.value.loggingIn) return
        _state.update { it.copy(loggingIn = true, loginError = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { auth.login(serverUrl, username, password, save) }
            when (result) {
                is LoginResult.Success -> {
                    prefs.storeCredentials(serverUrl, username, password, save)
                    prefs.token = result.token
                    _state.update { it.copy(loggingIn = false, loginError = null, saveCredentials = save) }
                    enterTerminal()
                }
                is LoginResult.InvalidCredentials ->
                    _state.update { it.copy(loggingIn = false, loginError = "Invalid credentials") }
                is LoginResult.Error ->
                    _state.update { it.copy(loggingIn = false, loginError = result.message) }
            }
        }
    }

    private fun enterTerminal() {
        val c = controller ?: SessionController(
            context = getApplication(),
            prefs = prefs,
            auth = auth,
            scope = viewModelScope,
            onStatus = { s -> _state.update { it.copy(status = s) } },
            onSessionLabel = { label -> _state.update { it.copy(sessionLabel = label) } },
            onNeedLogin = { onNeedLogin() },
        ).also {
            it.onModifiersChanged = { m -> _state.update { s -> s.copy(modifiers = m) } }
            controller = it
        }
        _state.update {
            it.copy(
                screen = Screen.TERMINAL,
                booting = false,
                serverUrl = prefs.serverUrl,
                username = prefs.username,
                password = prefs.password,
                saveCredentials = prefs.saveCredentials,
            )
        }
        c.connect()
    }

    private fun onNeedLogin() {
        controller?.shutdown()
        controller = null
        _state.update { it.copy(screen = Screen.LOGIN, status = ConnStatus.OFFLINE) }
    }

    // ---- Toolbar actions ----
    fun reconnect() = controller?.reconnect()
    fun disconnect() = controller?.disconnect()
    fun changeFont(increase: Boolean) = controller?.changeFontSize(increase)
    fun clearScreen() = controller?.clearScreen()

    /** Flip the dark/light terminal theme, persist it, and repaint the live emulator. */
    fun toggleTheme() {
        val dark = !_state.value.darkTheme
        prefs.darkTheme = dark
        controller?.applyTerminalTheme(dark)
        _state.update { it.copy(darkTheme = dark) }
    }

    fun killSession() {
        controller?.killSession()
        controller?.shutdown()
        controller = null
        _state.update { it.copy(screen = Screen.LOGIN, status = ConnStatus.OFFLINE, sessionLabel = "") }
    }

    fun logout() {
        controller?.disconnect()
        controller?.shutdown()
        controller = null
        prefs.clearToken()
        _state.update { it.copy(screen = Screen.LOGIN, status = ConnStatus.OFFLINE, sessionLabel = "") }
    }

    override fun onCleared() {
        controller?.shutdown()
        controller = null
    }
}
