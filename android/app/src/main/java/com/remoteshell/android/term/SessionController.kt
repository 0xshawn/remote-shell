package com.remoteshell.android.term

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import com.remoteshell.android.net.AuthClient
import com.remoteshell.android.net.HttpClients
import com.remoteshell.android.net.Prefs
import com.remoteshell.android.net.ShellWebSocket
import com.termux.terminal.KeyHandler
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.terminal.TextStyle
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.nio.charset.StandardCharsets

enum class ConnStatus { OFFLINE, CONNECTING, ONLINE, ENDED }

/** Sticky modifier state for the on-screen helper keys: 0=released, 1=latched, 2=locked. */
data class Modifiers(val ctrl: Int = 0, val alt: Int = 0, val shift: Int = 0)

/**
 * Bridges the [ShellWebSocket] to a Termux [TerminalView]/[TerminalSession]:
 *   - bytes from the server -> emulator (on the main thread) -> view redraw,
 *   - keystrokes / resizes from the view -> server,
 *   - auto-reconnect with backoff, distinguishing token expiry from a network drop.
 *
 * It implements the session-output, session-client and view-client contracts so a single
 * object owns the whole terminal lifecycle. The view is attached/detached around the
 * Composable's lifecycle; the session and socket outlive it (surviving rotation).
 */
class SessionController(
    private val context: Context,
    private val prefs: Prefs,
    private val auth: AuthClient,
    private val scope: CoroutineScope,
    private val onStatus: (ConnStatus) -> Unit,
    private val onSessionLabel: (String) -> Unit,
    private val onNeedLogin: () -> Unit,
) : TerminalSession.SessionOutput, TerminalSessionClient, TerminalViewClient {

    private val main = Handler(Looper.getMainLooper())
    private val socket = ShellWebSocket(HttpClients.build(forWebSocket = true))
    val session = TerminalSession(TRANSCRIPT_ROWS, this, this)

    private var view: TerminalView? = null
    private var cols = 80
    private var rows = 24

    private var intentionalClose = false
    private var reconnectJob: Job? = null
    private var reconnectDelayMs = 1000L

    // Modifier state machine, mirrored to the UI so the keybar can highlight latched/locked.
    private var ctrl = 0
    private var alt = 0
    private var shift = 0
    private var lastCtrlTap = 0L
    private var lastAltTap = 0L
    private var lastShiftTap = 0L
    var onModifiersChanged: (Modifiers) -> Unit = {}

    var fontSizePx = prefs.fontSize
        private set

    private var darkTheme = prefs.darkTheme

    // ---- View attach/detach (called from the Composable) -------------------------------

    fun attachView(v: TerminalView) {
        view = v
        v.setTerminalViewClient(this)
        v.attachSession(session)
        v.setTextSize(fontSizePx)
        v.setTerminalCursorBlinkerRate(CURSOR_BLINK_MS)
        v.onScreenUpdated()
    }

    fun detachView() {
        view = null
    }

    // ---- Connection lifecycle ----------------------------------------------------------

    fun connect() {
        reconnectJob?.cancel()
        intentionalClose = false
        // Ensure an emulator exists before bytes can arrive: the view only creates one once
        // it has been laid out, but server output may come first. The view re-sizes (and
        // preserves) this emulator on its first real layout.
        if (session.emulator == null) {
            val cellH = (fontSizePx * 1.2f).toInt().coerceAtLeast(1)
            val cellW = (fontSizePx * 0.6f).toInt().coerceAtLeast(1)
            session.initializeEmulator(cols, rows, cellW, cellH)
        }
        applyTerminalTheme(darkTheme)
        onStatus(ConnStatus.CONNECTING)
        socket.connect(prefs.serverUrl, prefs.token, prefs.sessionId, cols, rows, wsListener)
    }

    /** Reconnect now, resetting backoff (the "Reconnect" toolbar button). */
    fun reconnect() {
        reconnectDelayMs = 1000L
        connect()
    }

    /** Close the socket but keep the persistent session alive on the server. */
    fun disconnect() {
        intentionalClose = true
        reconnectJob?.cancel()
        socket.close()
        onStatus(ConnStatus.OFFLINE)
    }

    /** Destroy the persistent server-side session, then forget the local session id. */
    fun killSession() {
        intentionalClose = true
        reconnectJob?.cancel()
        socket.sendKill()
        socket.close()
        prefs.resetSession()
        onStatus(ConnStatus.OFFLINE)
    }

    fun shutdown() {
        reconnectJob?.cancel()
        socket.close()
        view = null
    }

    private val wsListener = object : ShellWebSocket.Listener {
        override fun onOpen() {
            main.post {
                reconnectDelayMs = 1000L
                onStatus(ConnStatus.ONLINE)
                // tmux repaints the whole screen on attach; clear stale content first.
                session.reset()
                socket.sendResize(cols, rows)
                view?.requestFocus()
            }
        }

        override fun onOutput(body: String) {
            val bytes = body.toByteArray(StandardCharsets.UTF_8)
            main.post {
                session.onRemoteOutput(bytes, bytes.size)
                view?.onScreenUpdated()
            }
        }

        override fun onEvent(event: JSONObject) {
            main.post { handleEvent(event) }
        }

        override fun onClosed(code: Int, reason: String, t: Throwable?) {
            main.post {
                onStatus(ConnStatus.OFFLINE)
                if (intentionalClose) return@post
                scheduleReconnect()
            }
        }
    }

    private fun handleEvent(m: JSONObject) {
        when (m.optString("event")) {
            "session" -> {
                val isNew = m.optBoolean("isNew")
                onSessionLabel((if (isNew) "new · " else "resumed · ") + prefs.sessionId)
            }
            "error" -> writeNotice("\r\n[31m[remote-shell] ${m.optString("message", "error")}[0m\r\n")
            "ended" -> {
                writeNotice("\r\n[33m[remote-shell] session ended[0m\r\n")
                onStatus(ConnStatus.ENDED)
            }
        }
    }

    private fun writeNotice(text: String) {
        val b = text.toByteArray(StandardCharsets.UTF_8)
        session.onRemoteOutput(b, b.size)
        view?.onScreenUpdated()
    }

    private fun scheduleReconnect() {
        onStatus(ConnStatus.CONNECTING)
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            // Tell a token expiry apart from a transient network blip before retrying.
            val valid = withContext(Dispatchers.IO) { auth.verifyToken(prefs.serverUrl, prefs.token) }
            if (valid == false) {
                prefs.clearToken()
                onNeedLogin()
                return@launch
            }
            delay(reconnectDelayMs)
            reconnectDelayMs = (reconnectDelayMs * 3 / 2).coerceAtMost(10_000L)
            if (!intentionalClose) connect()
        }
    }

    // ---- Input helpers used by the on-screen keybar ------------------------------------

    /** Raw bytes straight to the shell (e.g. ^C/^D/^Z), bypassing modifier transforms. */
    fun writeBytes(data: ByteArray) {
        val s = String(data, StandardCharsets.UTF_8)
        socket.sendInput(s)
    }

    /** Paste the clipboard text into the shell, honoring bracketed-paste mode. */
    fun paste() {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        val item = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0) ?: return
        val text = item.coerceToText(context)?.toString().orEmpty()
        if (text.isEmpty()) return
        val emulator = session.emulator
        if (emulator != null) emulator.paste(text) else socket.sendInput(text)
    }

    /** A special key (Esc/Tab/arrows/...) folded with the current sticky modifiers. */
    fun sendKeyCode(keyCode: Int) {
        val v = view ?: return
        v.handleKeyCode(keyCode, currentKeyMod())
        clearLatched()
    }

    /** A printable code point routed through the view so sticky Ctrl/Alt apply to it. */
    fun sendCodePoint(codePoint: Int) {
        view?.inputCodePoint(TerminalView.KEY_EVENT_SOURCE_SOFT_KEYBOARD, codePoint, false, false)
        // latched modifiers are cleared in onCodePoint()
    }

    private fun currentKeyMod(): Int {
        var mod = 0
        if (ctrl > 0) mod = mod or KeyHandler.KEYMOD_CTRL
        if (alt > 0) mod = mod or KeyHandler.KEYMOD_ALT
        if (shift > 0) mod = mod or KeyHandler.KEYMOD_SHIFT
        return mod
    }

    fun toggleCtrl() {
        val now = System.currentTimeMillis()
        ctrl = nextSticky(ctrl, now - lastCtrlTap); lastCtrlTap = now; emitMods()
    }
    fun toggleAlt() {
        val now = System.currentTimeMillis()
        alt = nextSticky(alt, now - lastAltTap); lastAltTap = now; emitMods()
    }
    fun toggleShift() {
        val now = System.currentTimeMillis()
        shift = nextSticky(shift, now - lastShiftTap); lastShiftTap = now; emitMods()
    }

    /**
     * Three-state sticky toggle, mirroring the web client (app.js toggleMod):
     *   single tap -> latch (0<->1); a second tap within 300ms -> lock (0<->2).
     */
    private fun nextSticky(state: Int, sinceLastTapMs: Long): Int =
        if (sinceLastTapMs < DOUBLE_TAP_MS) (if (state == 2) 0 else 2)
        else (if (state == 0) 1 else 0)

    private fun clearLatched() {
        if (ctrl == 1) ctrl = 0
        if (alt == 1) alt = 0
        if (shift == 1) shift = 0
        emitMods()
    }

    private fun emitMods() = onModifiersChanged(Modifiers(ctrl, alt, shift))

    // ---- Font size ---------------------------------------------------------------------

    fun changeFontSize(increase: Boolean) {
        fontSizePx = (fontSizePx + if (increase) 2 else -2).coerceIn(MIN_FONT_PX, MAX_FONT_PX)
        prefs.fontSize = fontSizePx
        view?.setTextSize(fontSizePx)
    }

    /** Apply the web client's dark/light terminal palette to the live emulator and repaint. */
    fun applyTerminalTheme(dark: Boolean) {
        darkTheme = dark
        val colors = session.emulator?.mColors?.mCurrentColors ?: return
        if (dark) {
            colors[TextStyle.COLOR_INDEX_BACKGROUND] = 0xff1e1e1e.toInt()
            colors[TextStyle.COLOR_INDEX_FOREGROUND] = 0xffd4d4d4.toInt()
            colors[TextStyle.COLOR_INDEX_CURSOR] = 0xffffffff.toInt()
        } else {
            colors[TextStyle.COLOR_INDEX_BACKGROUND] = 0xffffffff.toInt()
            colors[TextStyle.COLOR_INDEX_FOREGROUND] = 0xff1e1e1e.toInt()
            colors[TextStyle.COLOR_INDEX_CURSOR] = 0xff000000.toInt()
        }
        view?.onScreenUpdated()
    }

    /** Clear the local scrollback (like the web client's term.clear()); the live shell is untouched. */
    fun clearScreen() {
        session.emulator?.screen?.clearTranscript()
        view?.onScreenUpdated()
    }

    fun showKeyboard() {
        val v = view ?: return
        v.requestFocus()
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(v, InputMethodManager.SHOW_IMPLICIT)
    }

    // ---- TerminalSession.SessionOutput -------------------------------------------------

    override fun write(data: ByteArray, offset: Int, count: Int) {
        socket.sendInput(String(data, offset, count, StandardCharsets.UTF_8))
    }

    override fun onSizeChanged(columns: Int, rowsCount: Int) {
        cols = columns
        rows = rowsCount
        socket.sendResize(columns, rowsCount)
    }

    // ---- TerminalSessionClient ---------------------------------------------------------

    override fun onTextChanged(changedSession: TerminalSession) { view?.onScreenUpdated() }
    override fun onTitleChanged(changedSession: TerminalSession) {}
    override fun onSessionFinished(finishedSession: TerminalSession) {}
    override fun onCopyTextToClipboard(session: TerminalSession, text: String?) {
        val t = text ?: return
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        cm.setPrimaryClip(ClipData.newPlainText("remote-shell", t))
    }
    override fun onPasteTextFromClipboard(session: TerminalSession?) {}
    override fun onBell(session: TerminalSession) {}
    override fun onColorsChanged(session: TerminalSession) {}
    override fun onTerminalCursorStateChange(state: Boolean) {}
    override fun setTerminalShellPid(session: TerminalSession, pid: Int) {}
    override fun getTerminalCursorStyle(): Int? = null

    // ---- TerminalViewClient ------------------------------------------------------------

    override fun onScale(scale: Float): Float {
        if (scale < 0.9f || scale > 1.1f) {
            changeFontSize(scale > 1f)
            return 1.0f
        }
        return scale
    }

    override fun onSingleTapUp(e: MotionEvent) { showKeyboard() }
    override fun shouldBackButtonBeMappedToEscape(): Boolean = false
    // false -> TYPE_NULL: a normal text keyboard. true would set VISIBLE_PASSWORD, which many
    // IMEs render as a secure/incognito keyboard — not what we want for a shell.
    override fun shouldEnforceCharBasedInput(): Boolean = false
    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false
    override fun isTerminalViewSelected(): Boolean = true
    override fun copyModeChanged(copyMode: Boolean) {}
    override fun onKeyDown(keyCode: Int, e: KeyEvent, session: TerminalSession): Boolean = false
    override fun onKeyUp(keyCode: Int, e: KeyEvent): Boolean = false
    override fun onLongPress(event: MotionEvent): Boolean = false
    override fun readControlKey(): Boolean = ctrl > 0
    override fun readAltKey(): Boolean = alt > 0
    override fun readShiftKey(): Boolean = shift > 0
    override fun readFnKey(): Boolean = false

    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession): Boolean {
        clearLatched() // a key was consumed; release single-tap modifiers
        return false
    }

    override fun onEmulatorSet() {
        view?.setTerminalCursorBlinkerState(true, true)
        applyTerminalTheme(darkTheme)
    }

    // ---- Logging (quiet by default) ----------------------------------------------------

    override fun logError(tag: String?, message: String?) { Log.e(tag ?: TAG, message ?: "") }
    override fun logWarn(tag: String?, message: String?) {}
    override fun logInfo(tag: String?, message: String?) {}
    override fun logDebug(tag: String?, message: String?) {}
    override fun logVerbose(tag: String?, message: String?) {}
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) { Log.e(tag ?: TAG, message, e) }
    override fun logStackTrace(tag: String?, e: Exception?) { Log.e(tag ?: TAG, "", e) }

    companion object {
        private const val TAG = "SessionController"
        private const val TRANSCRIPT_ROWS = 10_000
        private const val MIN_FONT_PX = 16
        private const val MAX_FONT_PX = 96
        private const val CURSOR_BLINK_MS = 500
        private const val DOUBLE_TAP_MS = 300L
    }
}
