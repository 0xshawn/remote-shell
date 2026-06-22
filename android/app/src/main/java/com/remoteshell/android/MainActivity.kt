package com.remoteshell.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import com.remoteshell.android.ui.LoginScreen
import com.remoteshell.android.ui.TerminalScreen
import com.remoteshell.android.ui.theme.RemoteShellTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge so Compose receives IME insets and the keybar floats above the keyboard.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContent {
            val vm: MainViewModel = viewModel()
            val state by vm.state.collectAsState()
            RemoteShellTheme(darkTheme = state.darkTheme) {
                Surface(modifier = Modifier.fillMaxSize()) {
                    AppRoot(vm, state)
                }
            }
        }
    }
}

@Composable
private fun AppRoot(vm: MainViewModel, state: UiState) {
    when {
        state.booting -> Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        state.screen == Screen.LOGIN -> LoginScreen(
            initialServer = state.serverUrl,
            initialUser = state.username,
            initialPassword = state.password,
            initialSave = state.saveCredentials,
            loggingIn = state.loggingIn,
            error = state.loginError,
            onLogin = vm::login,
        )
        else -> {
            val controller = vm.controller
            if (controller != null) {
                TerminalScreen(
                    state = state,
                    controller = controller,
                    onReconnect = vm::reconnect,
                    onDisconnect = vm::disconnect,
                    onKill = vm::killSession,
                    onLogout = vm::logout,
                    onChangeFont = vm::changeFont,
                    onClearScreen = vm::clearScreen,
                    onToggleTheme = vm::toggleTheme,
                )
            }
        }
    }
}
