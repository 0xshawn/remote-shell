package com.remoteshell.android.ui

import android.content.Context
import android.graphics.Typeface
import android.graphics.fonts.Font
import android.graphics.fonts.FontFamily as GraphicsFontFamily
import android.os.Build
import android.view.KeyEvent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.runtime.DisposableEffect
import com.remoteshell.android.UiState
import com.remoteshell.android.net.ChangePasswordResult
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
    onChangeFont: (Boolean) -> Unit,
    onClearScreen: () -> Unit,
    onToggleTheme: () -> Unit,
    onChangePassword: (old: String, new: String, onResult: (ChangePasswordResult) -> Unit) -> Unit,
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
        // Must run after attachView (which calls setTextSize and creates the renderer):
        // setTypeface NPEs if the renderer is null. The bundled symbol font is primary so
        // U+23F5 (Claude Code's ⏵ indicator) resolves there; all other glyphs fall through
        // to the system monospace fallback, preserving the monospace look and row height.
        installSymbolTypeface(context, view)
        onDispose { controller.detachView() }
    }

    Scaffold(
        topBar = {
            TerminalTopBar(
                state, onReconnect, onDisconnect, onKill, onLogout,
                onChangeFont, onClearScreen, onToggleTheme, onChangePassword,
            ) { controller.showKeyboard() }
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
                    .background(if (state.darkTheme) Color(0xFF1E1E1E) else Color.White),
            )
            KeyBar(controller, state.modifiers)
        }
    }
}

/**
 * Install a typeface whose explicit fallback chain reaches the bundled symbol font, so glyphs
 * like U+23F5 render instead of tofu. The FontFamily/CustomFallbackBuilder APIs need API 29+;
 * below that we leave MONOSPACE untouched. runCatching guards the (near-impossible) asset load
 * failure from crashing terminal startup.
 */
private fun installSymbolTypeface(context: Context, view: TerminalView) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    runCatching {
        val symbolFont = Font.Builder(context.assets, "fonts/SymbolsMedia.ttf").build()
        val symbolFamily = GraphicsFontFamily.Builder(symbolFont).build()
        val tf = Typeface.CustomFallbackBuilder(symbolFamily)
            .setSystemFallback("monospace")
            .build()
        view.setTypeface(tf)
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
    onChangeFont: (Boolean) -> Unit,
    onClearScreen: () -> Unit,
    onToggleTheme: () -> Unit,
    onChangePassword: (old: String, new: String, onResult: (ChangePasswordResult) -> Unit) -> Unit,
    onShowKeyboard: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    var showChangePw by remember { mutableStateOf(false) }
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
            IconButton(onClick = { onChangeFont(false) }) { Text("A-", fontSize = 16.sp) }
            IconButton(onClick = { onChangeFont(true) }) { Text("A+", fontSize = 16.sp) }
            IconButton(onClick = onShowKeyboard) {
                Icon(Icons.Filled.Keyboard, contentDescription = "Keyboard")
            }
            IconButton(onClick = { menu = true }) {
                Icon(Icons.Filled.MoreVert, contentDescription = "Menu")
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text(if (state.darkTheme) "Light theme" else "Dark theme") },
                    onClick = { menu = false; onToggleTheme() },
                )
                DropdownMenuItem(text = { Text("Clear screen") }, onClick = { menu = false; onClearScreen() })
                DropdownMenuItem(text = { Text("Reconnect") }, onClick = { menu = false; onReconnect() })
                DropdownMenuItem(text = { Text("Disconnect") }, onClick = { menu = false; onDisconnect() })
                DropdownMenuItem(text = { Text("Kill session") }, onClick = { menu = false; onKill() })
                DropdownMenuItem(
                    text = { Text("Change password") },
                    onClick = { menu = false; showChangePw = true },
                )
                DropdownMenuItem(text = { Text("Logout") }, onClick = { menu = false; onLogout() })
            }
        },
    )
    if (showChangePw) {
        ChangePasswordDialog(onDismiss = { showChangePw = false }, onSubmit = onChangePassword)
    }
}

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
            ModButton("Ctrl", mods.ctrl) { controller.toggleCtrl() }
            ModButton("Alt", mods.alt) { controller.toggleAlt() }
            ModButton("Shift", mods.shift) { controller.toggleShift() }
            KeyButton("Esc") { controller.sendKeyCode(KeyEvent.KEYCODE_ESCAPE) }
            KeyButton("Tab") { controller.sendKeyCode(KeyEvent.KEYCODE_TAB) }
            KeyButton("^C") { controller.writeBytes(byteArrayOf(3)) }
            KeyButton("^D") { controller.writeBytes(byteArrayOf(4)) }
            KeyButton("^Z") { controller.writeBytes(byteArrayOf(26)) }
            KeyButton("↑") { controller.sendKeyCode(KeyEvent.KEYCODE_DPAD_UP) }
            KeyButton("↓") { controller.sendKeyCode(KeyEvent.KEYCODE_DPAD_DOWN) }
            KeyButton("←") { controller.sendKeyCode(KeyEvent.KEYCODE_DPAD_LEFT) }
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

@Composable
private fun ModButton(label: String, stateValue: Int, onTap: () -> Unit) {
    val bg = when (stateValue) {
        2 -> MaterialTheme.colorScheme.primary // locked
        1 -> MaterialTheme.colorScheme.primary.copy(alpha = 0.4f) // latched
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    Surface(
        color = bg,
        shape = RoundedCornerShape(6.dp),
        modifier = Modifier.clickable(onClick = onTap),
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

@Composable
private fun ChangePasswordDialog(
    onDismiss: () -> Unit,
    onSubmit: (old: String, new: String, onResult: (ChangePasswordResult) -> Unit) -> Unit,
) {
    var oldPw by remember { mutableStateOf("") }
    var newPw by remember { mutableStateOf("") }
    var confirmPw by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    val pwField: @Composable (String, String, (String) -> Unit) -> Unit = { value, label, onChange ->
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            label = { Text(label) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Change password") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                pwField(oldPw, "Current password") { oldPw = it }
                pwField(newPw, "New password (min 6)") { newPw = it }
                pwField(confirmPw, "Confirm new password") { confirmPw = it }
                message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = {
                    when {
                        newPw.length < 6 -> message = "New password must be at least 6 characters"
                        newPw != confirmPw -> message = "New passwords do not match"
                        else -> {
                            busy = true
                            message = null
                            onSubmit(oldPw, newPw) { result ->
                                busy = false
                                when (result) {
                                    is ChangePasswordResult.Success ->
                                        if (result.warning != null) message = result.warning else onDismiss()
                                    is ChangePasswordResult.Error -> message = result.message
                                }
                            }
                        }
                    }
                },
            ) { Text("Save") }
        },
        dismissButton = {
            TextButton(enabled = !busy, onClick = onDismiss) { Text("Cancel") }
        },
    )
}
