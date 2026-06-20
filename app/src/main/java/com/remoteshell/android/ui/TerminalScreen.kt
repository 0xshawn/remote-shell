package com.remoteshell.android.ui

import android.view.KeyEvent
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.runtime.DisposableEffect
import com.remoteshell.android.UiState
import com.remoteshell.android.term.ConnStatus
import com.remoteshell.android.term.Modifiers
import com.remoteshell.android.term.SessionController
import com.termux.view.TerminalView

@Composable
fun TerminalScreen(
    state: UiState,
    controller: SessionController,
    onReconnect: () -> Unit,
    onDisconnect: () -> Unit,
    onKill: () -> Unit,
    onLogout: () -> Unit,
) {
    val context = LocalContext.current
    val view = remember {
        TerminalView(context, null).apply {
            isFocusableInTouchMode = true
            isFocusable = true
            keepScreenOn = true
        }
    }

    DisposableEffect(controller, view) {
        controller.attachView(view)
        onDispose { controller.detachView() }
    }

    Scaffold(
        topBar = {
            TerminalTopBar(state, onReconnect, onDisconnect, onKill, onLogout) { controller.showKeyboard() }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .imePadding(),
        ) {
            AndroidView(
                factory = { view },
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .background(Color.Black),
            )
            KeyBar(controller, state.modifiers)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TerminalTopBar(
    state: UiState,
    onReconnect: () -> Unit,
    onDisconnect: () -> Unit,
    onKill: () -> Unit,
    onLogout: () -> Unit,
    onShowKeyboard: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val (statusText, statusColor) = when (state.status) {
        ConnStatus.ONLINE -> "online" to Color(0xFF4CAF50)
        ConnStatus.CONNECTING -> "connecting…" to Color(0xFFFFC107)
        ConnStatus.ENDED -> "ended" to Color(0xFFF44336)
        ConnStatus.OFFLINE -> "offline" to Color(0xFF9E9E9E)
    }
    TopAppBar(
        colors = TopAppBarDefaults.topAppBarColors(),
        title = {
            Column {
                Text(statusText, color = statusColor, fontSize = 16.sp)
                if (state.sessionLabel.isNotEmpty()) {
                    Text(state.sessionLabel, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                }
            }
        },
        actions = {
            IconButton(onClick = onShowKeyboard) {
                Icon(Icons.Filled.Keyboard, contentDescription = "Keyboard")
            }
            IconButton(onClick = { menu = true }) {
                Icon(Icons.Filled.MoreVert, contentDescription = "Menu")
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("Reconnect") }, onClick = { menu = false; onReconnect() })
                DropdownMenuItem(text = { Text("Disconnect") }, onClick = { menu = false; onDisconnect() })
                DropdownMenuItem(text = { Text("Kill session") }, onClick = { menu = false; onKill() })
                DropdownMenuItem(text = { Text("Logout") }, onClick = { menu = false; onLogout() })
            }
        },
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun KeyBar(controller: SessionController, mods: Modifiers) {
    Surface(color = MaterialTheme.colorScheme.surface) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = 4.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ModButton("Ctrl", mods.ctrl, { controller.toggleCtrl() }, { controller.lockMod("ctrl") })
            ModButton("Alt", mods.alt, { controller.toggleAlt() }, { controller.lockMod("alt") })
            ModButton("Shift", mods.shift, { controller.toggleShift() }, { controller.lockMod("shift") })
            KeyButton("Esc") { controller.sendKeyCode(KeyEvent.KEYCODE_ESCAPE) }
            KeyButton("Tab") { controller.sendKeyCode(KeyEvent.KEYCODE_TAB) }
            KeyButton("^C") { controller.writeBytes(byteArrayOf(3)) }
            KeyButton("^D") { controller.writeBytes(byteArrayOf(4)) }
            KeyButton("^Z") { controller.writeBytes(byteArrayOf(26)) }
            KeyButton("←") { controller.sendKeyCode(KeyEvent.KEYCODE_DPAD_LEFT) }
            KeyButton("↓") { controller.sendKeyCode(KeyEvent.KEYCODE_DPAD_DOWN) }
            KeyButton("↑") { controller.sendKeyCode(KeyEvent.KEYCODE_DPAD_UP) }
            KeyButton("→") { controller.sendKeyCode(KeyEvent.KEYCODE_DPAD_RIGHT) }
            KeyButton("Home") { controller.sendKeyCode(KeyEvent.KEYCODE_MOVE_HOME) }
            KeyButton("End") { controller.sendKeyCode(KeyEvent.KEYCODE_MOVE_END) }
            KeyButton("Paste") { controller.paste() }
            KeyButton("|") { controller.sendCodePoint('|'.code) }
            KeyButton("~") { controller.sendCodePoint('~'.code) }
            KeyButton("/") { controller.sendCodePoint('/'.code) }
            KeyButton("-") { controller.sendCodePoint('-'.code) }
        }
    }
}

@Composable
private fun KeyButton(label: String, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(label, fontFamily = FontFamily.Monospace, fontSize = 14.sp)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ModButton(label: String, stateValue: Int, onTap: () -> Unit, onLock: () -> Unit) {
    val bg = when (stateValue) {
        2 -> MaterialTheme.colorScheme.primary // locked
        1 -> MaterialTheme.colorScheme.primary.copy(alpha = 0.4f) // latched
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    Surface(
        color = bg,
        shape = RoundedCornerShape(6.dp),
        modifier = Modifier.combinedClickable(onClick = onTap, onLongClick = onLock),
    ) {
        Text(
            label,
            fontFamily = FontFamily.Monospace,
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}
